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

type Ghost = { lineIndex: number; prefix: string; remainder: string };

class BashInlineEditor extends CustomEditor {
	private realProvider: AutocompleteProvider | undefined;
	private bashProvider: AutocompleteProvider | undefined;
	private ghost: Ghost | null = null;
	private ghostToken = 0;
	private ghostAbort?: AbortController;
	private cursorOn = true;
	private lastInputAt = 0;
	private blinkTimer?: ReturnType<typeof setInterval>;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);
		this.startBlink();
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
		// Solid cursor while typing; blinking resumes after the idle window.
		this.lastInputAt = Date.now();
		this.cursorOn = true;
		// Right arrow accepts the ghost suggestion when the cursor sits at EOL.
		if (matchesKey(data, "right") && this.activeGhost() && this.cursorAtLineEnd()) {
			this.acceptGhost();
			return;
		}
		super.handleInput(data);
		if (matchesKey(data, "escape")) {
			this.ghost = null;
		}
		if (this.inBashMode()) {
			this.updateGhost();
		} else if (this.ghost) {
			this.ghost = null;
		}
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
		if (this.inBashMode()) {
			this.updateGhost();
		}
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
		const ghost = this.activeGhost();
		if (ghost) {
			// Base row layout: text + cursor cell + padding. Drop the cursor
			// cell (frees 1 col) and render ghost chars into the padding.
			const pad = / *$/.exec(row.slice(match.index + match[0].length))?.[0].length ?? 0;
			const avail = pad + 1;
			let used = 0;
			const cells: string[] = [];
			for (const ch of [...ghost.remainder]) {
				const w = visibleWidth(ch);
				if (used + w > avail) {
					break;
				}
				// Blink "on": first suggestion char is bright (acts as the cursor)
				cells.push(used === 0 && this.cursorOn ? `\x1b[1m${ch}${RESET}` : `${DIM}${ch}${RESET}`);
				used += w;
			}
			out[rowIdx] = head + cells.join("") + " ".repeat(Math.max(0, pad - used + 1));
			return out;
		}
		const ch = match[1] || " ";
		const cursorCell = this.cursorOn ? BEAM : ch;
		out[rowIdx] = head + cursorCell + row.slice(match.index + match[0].length);
		return out;
	}

	// --- internals ---

	/** Toggle the beam cursor while focused; solid briefly after keystrokes. */
	private startBlink(): void {
		if (this.blinkTimer) {
			return;
		}
		this.blinkTimer = setInterval(() => {
			if (!this.focused) {
				return;
			}
			const idle = Date.now() - this.lastInputAt > SOLID_AFTER_INPUT_MS;
			this.cursorOn = idle ? !this.cursorOn : true;
			this.tui.requestRender();
		}, BLINK_INTERVAL_MS);
	}

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
	 * Wrap the stock provider with bash-mode behavior. This is the single
	 * decision point for both the ghost and the dropdown:
	 *   - command position ("!cd", no space yet) → suggest all entries
	 *   - multiple matches → normal suggestions (stock dropdown shows them)
	 *   - exactly one match → divert to the inline ghost, close any popup
	 *   - non-bash text → untouched stock behavior
	 */
	private createBashProvider(current: AutocompleteProvider): AutocompleteProvider {
		const self = this;
		return {
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				if (!self.inBashMode()) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}
				const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const commandPos = self.commandPosition(before);
				let queryLines = lines;
				if (commandPos) {
					// Neutralize the command word so the provider completes the
					// (empty) argument position: every entry matches.
					queryLines = [...lines];
					queryLines[cursorLine] = before.replace(/![^!\s]*$/, "! ");
				}
				const suggestions = await current.getSuggestions(queryLines, cursorLine, cursorCol, {
					...options,
					force: true,
				});
				const items = suggestions?.items ?? [];
				if (items.length === 1) {
					// Exactly one option: inline ghost instead of a popup. Returning
					// null makes the stock machinery close/skip the dropdown.
					const prefix = suggestions?.prefix ?? "";
					const value = items[0]?.value ?? "";
					const remainder = value.toLowerCase().startsWith(prefix.toLowerCase())
						? value.slice(prefix.length)
						: "";
					self.ghost = remainder ? { lineIndex: cursorLine, prefix, remainder } : null;
					return null;
				}
				if (items.length === 0) {
					self.ghost = null;
					return null;
				}
				return suggestions;
			},

			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
				if (self.inBashMode() && self.commandPosition(before)) {
					// Completing from the command position: insert the chosen path
					// as the first argument ("!cd" + AppleStuff/ → "!cd AppleStuff/").
					const value = item.value ?? "";
					const line = lines[cursorLine] ?? "";
					const newLines = [...lines];
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
	private activeGhost(): Ghost | null {
		const ghost = this.ghost;
		if (!ghost || this.isShowingAutocomplete() || !this.inBashMode()) {
			return null;
		}
		const st = (this as unknown as EditorInternals).state;
		if (ghost.lineIndex !== st.cursorLine || !this.cursorAtLineEnd()) {
			return null;
		}
		const line = st.lines[st.cursorLine] ?? "";
		if (!line.toLowerCase().endsWith(ghost.prefix.toLowerCase())) {
			return null;
		}
		return ghost;
	}

	private acceptGhost(): void {
		const ghost = this.activeGhost();
		if (!ghost) {
			return;
		}
		const st = (this as unknown as EditorInternals).state;
		const line = st.lines[ghost.lineIndex] ?? "";
		const col = st.cursorCol;
		const completed = ghost.prefix + ghost.remainder;
		const before = line.slice(0, col);
		// Completing from the command position: the path becomes the first
		// argument, so a leading space is part of the insertion.
		const separator = this.commandPosition(before) ? " " : "";
		(this as unknown as EditorInternals).pushUndoSnapshot();
		st.lines[ghost.lineIndex] = line.slice(0, col - ghost.prefix.length) + separator + completed + line.slice(col);
		this.ghost = null;
		(this as unknown as EditorInternals).setCursorCol(
			col - ghost.prefix.length + separator.length + completed.length,
		);
		this.onChange?.(this.getText());
		// Like zsh: after completing into a directory, suggest its first entry.
		this.updateGhost();
	}

	private updateGhost(): void {
		const token = ++this.ghostToken;
		const provider = this.bashProvider;
		if (!provider || !this.inBashMode() || !this.cursorAtLineEnd()) {
			this.ghost = null;
			return;
		}
		const state = (this as unknown as EditorInternals).state;
		const lineIndex = state.cursorLine;
		const controller = new AbortController();
		this.ghostAbort?.abort();
		this.ghostAbort = controller;
		void provider
			.getSuggestions(state.lines, lineIndex, state.cursorCol, {
				signal: controller.signal,
				force: true,
			})
			.then((suggestions: AutocompleteSuggestions | null) => {
				if (token !== this.ghostToken) {
					return;
				}
				// The wrapper owns ghost state (single matches are diverted to
				// the ghost there); this only triggers the dropdown for >1.
				const items = suggestions?.items ?? [];
				const st = this as unknown as EditorInternals;
				if (items.length > 1 && !this.isShowingAutocomplete()) {
					this.ghost = null;
					st.requestAutocomplete({ force: true, explicitTab: false });
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
