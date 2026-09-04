// Bash inline completion — zsh-style ghost text in the Pi editor.
//
// In bash mode (message starts with "!"), path completions render as dimmed
// inline text after the cursor instead of a dropdown:
//   - type `!cd A`  →  "ppleStuff/" appears dimmed right after the cursor
//   - → (right arrow) or Tab accepts it
//   - accepting a directory immediately suggests its first entry (zsh-like)
//   - Escape dismisses
// Everything outside bash mode keeps stock editor behavior (dropdown etc.).

import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	matchesKey,
	visibleWidth,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

/** Runtime access to Editor internals that are private in the type declarations. */
import { readdirSync, statSync } from "node:fs";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	autocompleteProvider?: AutocompleteProvider | null;
	setCursorCol(col: number): void;
	pushUndoSnapshot(): void;
	tui: { requestRender(): void };
	requestAutocomplete(options: { force?: boolean; explicitTab?: boolean }): void;
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
/** Beam cursor: thin vertical bar, bold so it stands out. One cell wide. */
const BEAM = "\x1b[1m▏\x1b[0m";
/** Matches the reverse-video block the base renderer emits for the cursor. */
const REVERSE_CURSOR = /\x1b\[7m([\s\S]*?)\x1b\[0m/;

const BLINK_INTERVAL_MS = 500;
/** Cursor stays solid for this long after each keystroke, then resumes blinking. */
const SOLID_AFTER_INPUT_MS = 450;

type GhostSource = "history" | "path";
type Ghost = { lineIndex: number; typed: string; suggestion: string; source: GhostSource };

class BashInlineEditor extends CustomEditor {
	private realProvider: AutocompleteProvider | undefined;
	private bashProvider: AutocompleteProvider | undefined;
	private ghost: Ghost | null = null;
	private ghostToken = 0;
	private ghostAbort?: AbortController;
	/** Submitted prompts, oldest first — the zsh-autosuggestions history strategy. */
	private promptHistory: string[] = [];
	/** Set by Escape; keeps the ghost dismissed until the next text edit. */
	private ghostSuppressed = false;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		// Native terminal cursor = the Apple-Terminal-style blinking bar: it
		// draws over the glyph's cell edge without covering the character.
		// DECSCUSR 5 q requests a blinking bar where the terminal supports
		// it; otherwise the terminal profile's cursor shape is used as-is.
		tui.setShowHardwareCursor(true);
		tui.terminal.write("\x1b[5 q");
		// Wrap onChange so programmatic text changes (paste, undo, history,
		// setText) also refresh the inline suggestion.
		let external: ((text: string) => void) | undefined;
		const self = this;
		Object.defineProperty(this, "onChange", {
			configurable: true,
			enumerable: true,
			get() {
				if (!external) return undefined;
				return (text: string) => {
					external!(text);
					self.updateGhost();
				};
			},
			set(fn) {
				external = fn;
			},
		});
		// Capture submitted prompts for the history suggestion strategy
		// (zsh-autosuggestions records everything written to the shell line).
		let externalSubmit: ((text: string) => void) | undefined;
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			enumerable: true,
			get() {
				if (!externalSubmit) return undefined;
				return (text: string) => {
					if (text.trim()) {
						self.promptHistory.push(text);
						if (self.promptHistory.length > 500) {
							self.promptHistory.shift();
						}
					}
					externalSubmit!(text);
				};
			},
			set(fn) {
				externalSubmit = fn;
			},
		});
	}

	// Pi installs the shared autocomplete provider here. Wrap it once with
	// bash-mode-aware behavior; the wrapper is what the stock popup machinery
	// talks to, so dropdown open/close and ghost diversion stay consistent.
	setAutocompleteProvider(provider: AutocompleteProvider | undefined): void {
		super.setAutocompleteProvider(provider);
		this.realProvider = provider;
		const bashProvider = provider ? this.createBashProvider(provider) : undefined;
		this.bashProvider = bashProvider;
		(this as unknown as EditorInternals).autocompleteProvider = bashProvider;
	}

	handleInput(data: string): void {
		// Accept keys while a ghost suggestion is showing and the cursor sits
		// at end of line (zsh-autosuggestions widget semantics):
		//   right        → accept the whole suggestion
		//   alt+f        → accept the next word (partial accept)
		//   ctrl+right   → accept the next word (partial accept)
		if (matchesKey(data, "escape")) {
			this.ghostSuppressed = true;
		} else {
			this.ghostSuppressed = false;
		}
		if (this.activeGhost() && this.cursorAtLineEnd()) {
			if (matchesKey(data, "right")) {
				this.acceptGhost();
				return;
			}
			if (matchesKey(data, "alt+f") || matchesKey(data, "ctrl+right")) {
				this.acceptGhostWord();
				return;
			}
		}
		super.handleInput(data);
		if (matchesKey(data, "escape")) {
			this.ghost = null;
		}
		// History suggestions work in every mode; bash mode adds the path
		// strategy (updateGhost clears the ghost itself when nothing matches).
		this.updateGhost();
	}

	handleTabCompletion(): void {
		if (this.activeGhost()) {
			this.acceptGhost();
			return;
		}
		super.handleTabCompletion();
	}

	// Runtime override of the base Editor's (private) setCursorCol — virtual
	// dispatch makes this shadow work. Refresh after cursor moves (clicks, etc.).
	// @ts-ignore — intentional runtime override of a private base method
	setCursorCol(col: number): void {
		Editor.prototype.setCursorCol.call(this, col);
		this.updateGhost();
	}

	render(width: number): string[] {
		const out = super.render(width);
		// Replace the base renderer's reverse-video block cursor with a blinking
		// beam. On ghost rows there is no separate cursor cell: the suggestion
		// starts flush after the typed text and the blink highlights its first
		// character instead.
		const rowIdx = out.findIndex((row) => REVERSE_CURSOR.test(row));
		if (rowIdx === -1) {
			return out;
		}
		const row = out[rowIdx]!;
		const match = REVERSE_CURSOR.exec(row);
		if (!match) {
			return out;
		}
		const head = row.slice(0, match.index);
		const ch = match[1] || " ";
		if (this.tui.getShowHardwareCursor()) {
			// Native terminal cursor mode: strip the fake block so the real
			// blinking bar is the only cursor. It overlays the cell edge
			// without covering the character, and it rides the first ghost
			// character on suggestion rows.
			const ghost = this.activeGhost();
			if (!ghost) {
				// Empty cursor cell: the native bar blinks there, nothing covered.
				out[rowIdx] = head + ch + row.slice(match.index + match[0].length);
				return out;
			}
			// The ghost starts AT the cursor cell so the native bar overlays
			// its first character (Apple Terminal bar-cursor behavior) instead
			// of sitting in a gap cell.
			const remainder = ghost.suggestion.slice(ghost.typed.length);
			const pad = / *$/.exec(row.slice(match.index + match[0].length))?.[0].length ?? 0;
			const avail = pad + 1;
			let used = 0;
			const ghostCells: string[] = [];
			for (const g of [...remainder]) {
				const w = visibleWidth(g);
				if (used + w > avail) {
					break;
				}
				ghostCells.push(`${DIM}${g}${RESET}`);
				used += w;
			}
			out[rowIdx] = head + ghostCells.join("") + " ".repeat(Math.max(0, pad - used + 1));
			return out;
		}
		const ghost = this.activeGhost();
		if (ghost) {
			// Fallback (software blink): ghost chars fill the padding.
			const remainder = ghost.suggestion.slice(ghost.typed.length);
			const pad = / *$/.exec(row.slice(match.index + match[0].length))?.[0].length ?? 0;
			const avail = pad + 1;
			let used = 0;
			const ghostCells: string[] = [];
			for (const g of [...remainder]) {
				const w = visibleWidth(g);
				if (used + w > avail) {
					break;
				}
				ghostCells.push(`${DIM}${g}${RESET}`);
				used += w;
			}
			out[rowIdx] = head + BEAM + ghostCells.join("") + " ".repeat(Math.max(0, pad - used));
			return out;
		}
		out[rowIdx] = head + BEAM + row.slice(match.index + match[0].length);
		return out;
	}

	// --- internals ---

	private inBashMode(): boolean {
		return this.getText().trimStart().startsWith("!");
	}

	private cursorAtLineEnd(): boolean {
		const st = (this as unknown as EditorInternals).state;
		return st.cursorCol === (st.lines[st.cursorLine] ?? "").length;
	}

	/** Suppress the dropdown in bash mode unless the popup is already open. */

	/**
	 * True while the command word after "!" is still being typed (no space
	 * yet), e.g. "!cd" or "!!ls" — completion targets the argument position.
	 */
	private commandPosition(beforeCursor: string): boolean {
		return /^[ \t]*![^\s]*$/.test(beforeCursor);
	}

	/**
	 * Wrap the stock provider with bash-mode behavior:
	 *   - command position ("!cd", no space yet) → suggest all entries
	 *   - non-bash text → untouched stock behavior
	 * The ghost-vs-dropdown split (one match → ghost, many → dropdown) is
	 * decided in updateGhost(), which sees the final suggestion counts.
	 */
	/** Executable names on $PATH, cached for the session (zsh command completion). */
	private pathCommandCache: string[] | null = null;

	private getPathCommands(): string[] {
		if (this.pathCommandCache) {
			return this.pathCommandCache;
		}
		const names = new Set<string>();
		for (const dir of (process.env.PATH ?? "").split(":")) {
			if (!dir) {
				continue;
			}
			let entries;
			try {
				entries = readdirSync(dir);
			} catch {
				continue;
			}
			for (const name of entries) {
				if (names.has(name)) {
					continue;
				}
				try {
					// eslint-disable-next-line no-bitwise
					if (statSync(`${dir}/${name}`).mode & 0o111) {
						names.add(name);
					}
				} catch {
					// dangling symlink or unreadable entry
				}
			}
		}
		this.pathCommandCache = [...names].sort();
		return this.pathCommandCache;
	}

	/** PATH commands starting with the typed command word. */
	private matchingCommands(word: string): string[] {
		if (!word) {
			return [];
		}
		return this.getPathCommands()
			.filter((name) => name.startsWith(word))
			.slice(0, 100);
	}

	private createBashProvider(current: AutocompleteProvider): AutocompleteProvider {
		const self = this;
		return {
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				if (!self.inBashMode()) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}
				const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
				let queryLines = lines;
				let commandItems: AutocompleteItem[] = [];
				let word = "";
				if (self.commandPosition(before)) {
					word = before.replace(/^[ \t]*!+/, "");
					const commands = self.matchingCommands(word);
					queryLines = [...lines];
					if (commands.length > 0) {
						// The typed word is a prefix of real commands: offer them
						// first, plus any matching file paths as fallback.
						commandItems = commands.map((name) => ({
							value: name,
							label: name,
							description: "command",
						}));
						queryLines[cursorLine] = `! ${word}`;
					} else {
						// Neutralize the command word so the provider completes the
						// (empty) argument position: every entry matches.
						queryLines[cursorLine] = before.replace(/![^!\s]*$/, "! ");
					}
				}
				const suggestions = await current.getSuggestions(queryLines, cursorLine, cursorCol, {
					...options,
					force: true,
				});
				if (commandItems.length === 0) {
					return suggestions;
				}
				return {
					items: [...commandItems, ...(suggestions?.items ?? [])],
					prefix: word,
				};
			},

			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
				if (self.inBashMode() && self.commandPosition(before)) {
					const value = item.value ?? "";
					const line = lines[cursorLine] ?? "";
					const newLines = [...lines];
					if (item.description === "command") {
						// Completing the command word itself ("!gi" + git → "!git").
						const start = cursorCol - prefix.length;
						newLines[cursorLine] = line.slice(0, start) + value + line.slice(cursorCol);
						return { lines: newLines, cursorLine, cursorCol: start + value.length };
					}
					// Completing from the command position: insert the chosen path
					// as the first argument ("!cd" + AppleStuff/ → "!cd AppleStuff/").
					newLines[cursorLine] = `${line.slice(0, cursorCol)} ${value}${line.slice(cursorCol)}`;
					return { lines: newLines, cursorLine, cursorCol: cursorCol + 1 + value.length };
				}
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},

			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		};
	}
	/** The ghost suggestion, only if it still matches the current editor state. */
	private activeGhost(): Ghost | null {
		const ghost = this.ghost;
		if (!ghost || this.isShowingAutocomplete() || !this.cursorAtLineEnd()) {
			return null;
		}
		const st = (this as unknown as EditorInternals).state;
		if (ghost.lineIndex !== st.cursorLine) {
			return null;
		}
		const line = st.lines[st.cursorLine] ?? "";
		const before = line.slice(0, st.cursorCol);
		if (before !== ghost.typed || ghost.suggestion.length <= ghost.typed.length) {
			return null;
		}
		return ghost;
	}

	/** Most recent history entry extending the current line (history strategy). */
	private historyGhost(): Ghost | null {
		const st = (this as unknown as EditorInternals).state;
		const line = st.lines[st.cursorLine] ?? "";
		const typed = line.slice(0, st.cursorCol);
		if (!typed.trim()) {
			return null;
		}
		for (let i = this.promptHistory.length - 1; i >= 0; i--) {
			const entry = this.promptHistory[i] ?? "";
			// Suggest only the entry's first line: ghost text renders on a
			// single editor row (full multi-line entries are inserted on accept).
			const firstLine = entry.split("\n", 1)[0] ?? "";
			if (firstLine.length > typed.length && firstLine.startsWith(typed)) {
				return { lineIndex: st.cursorLine, typed, suggestion: firstLine, source: "history" };
			}
		}
		return null;
	}

	/** Path ghost from provider suggestions (completion strategy, bash mode). */
	private pathGhost(suggestions: AutocompleteSuggestions | null, lineIndex: number): Ghost | null {
		const st = (this as unknown as EditorInternals).state;
		const line = st.lines[lineIndex] ?? "";
		const before = line.slice(0, st.cursorCol);
		const token = suggestions?.prefix ?? "";
		const value = suggestions?.items[0]?.value ?? "";
		if (!value || !value.toLowerCase().startsWith(token.toLowerCase())) {
			return null;
		}
		const isCommand = suggestions?.items[0]?.description === "command";
		const separator = isCommand ? "" : (this.commandPosition(before) ? " " : "");
		const suggestion = before.slice(0, before.length - token.length) + separator + value;
		if (suggestion.length <= before.length) {
			return null;
		}
		return { lineIndex, typed: before, suggestion, source: "path" };
	}

	private acceptGhost(): void {
		const ghost = this.activeGhost();
		if (!ghost) {
			return;
		}
		const st = (this as unknown as EditorInternals).state;
		const line = st.lines[ghost.lineIndex] ?? "";
		const col = st.cursorCol;
		(this as unknown as EditorInternals).pushUndoSnapshot();
		st.lines[ghost.lineIndex] = line.slice(0, col - ghost.typed.length) + ghost.suggestion + line.slice(col);
		this.ghost = null;
		(this as unknown as EditorInternals).setCursorCol(col - ghost.typed.length + ghost.suggestion.length);
		this.onChange?.(this.getText());
		// Like zsh: after accepting, immediately suggest the next part.
		this.updateGhost();
	}

	/** Partial accept (autosuggest-accept-word): take the next word of the suggestion. */
	private acceptGhostWord(): void {
		const ghost = this.activeGhost();
		if (!ghost) {
			return;
		}
		const remainder = ghost.suggestion.slice(ghost.typed.length);
		const chunk = /^\S+\s*/.exec(remainder)?.[0];
		if (!chunk) {
			return;
		}
		const st = (this as unknown as EditorInternals).state;
		const line = st.lines[ghost.lineIndex] ?? "";
		const col = st.cursorCol;
		(this as unknown as EditorInternals).pushUndoSnapshot();
		st.lines[ghost.lineIndex] = line.slice(0, col) + chunk + line.slice(col);
		this.ghost = { ...ghost, typed: ghost.typed + chunk };
		(this as unknown as EditorInternals).setCursorCol(col + chunk.length);
		this.onChange?.(this.getText());
		this.updateGhost();
	}

	private updateGhost(): void {
		const st = this as unknown as EditorInternals;
		// Dismissed via Escape; stays dismissed until the next text edit.
		if (this.ghostSuppressed) {
			this.ghost = null;
			return;
		}
		// zsh-autosuggestions hides the suggestion once the cursor moves off
		// the end of the buffer.
		if (!this.cursorAtLineEnd()) {
			this.ghost = null;
			return;
		}
		const history = this.historyGhost();
		if (!this.inBashMode()) {
			// History strategy works everywhere, like zsh-autosuggestions.
			this.ghost = history;
			st.tui.requestRender();
			return;
		}
		const provider = this.bashProvider;
		if (!provider) {
			this.ghost = history;
			return;
		}
		const token = ++this.ghostToken;
		const lineIndex = st.state.cursorLine;
		const controller = new AbortController();
		this.ghostAbort?.abort();
		this.ghostAbort = controller;
		void provider
			.getSuggestions(st.state.lines, lineIndex, st.state.cursorCol, {
				signal: controller.signal,
				force: true,
			})
			.then((suggestions: AutocompleteSuggestions | null) => {
				if (token !== this.ghostToken) {
					return;
				}
				const items = suggestions?.items ?? [];
				if (items.length > 1) {
					// Multiple path options win: show the stock dropdown, no ghost.
					this.ghost = null;
					if (!this.isShowingAutocomplete()) {
						st.requestAutocomplete({ force: true, explicitTab: false });
					}
				} else {
					// Zero or one path option: prefer the history ghost, then the
					// path ghost (zsh-autosuggestions strategy order: history first).
					if (this.isShowingAutocomplete()) {
						st.cancelAutocomplete();
					}
					this.ghost = history ?? this.pathGhost(suggestions, lineIndex);
				}
				st.tui.requestRender();
			})
			.catch(() => {});
	}
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new BashInlineEditor(tui, theme, keybindings));
	});
}
