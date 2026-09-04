# pi-bash-inline-completion

[zsh](https://www.zsh.org/)-style **inline ghost completion** for bash mode (`!command`) in the
[pi coding agent](https://github.com/earendil-works/pi-mono).

Type `!cd De` and `ktop/` appears dimmed right after your cursor — no dropdown,
no Tab required. Press `→` or `Tab` to accept. Everything outside bash mode keeps
stock editor behavior.

## Features

- **Inline ghost text** — completions render dimmed after the cursor, zsh-autosuggestions style
- **Accept with `→` or `Tab`** — accepting a directory immediately suggests its first entry (zsh-like dir chaining)
- **Smart mode switching**:
  - exactly **1 match** → inline ghost
  - **multiple matches** → the stock dropdown appears, fully interactive (arrow keys, Enter, mouse)
  - **0 matches** → just the cursor
- **Command position aware** — typing `!cd` (no space yet) lists all entries; picking one inserts it as the first argument
- **Blinking beam cursor** — replaces the block cursor with a thin vertical bar that blinks at ~2 Hz and stays solid while you type
- **`!!` hidden shell commands** get completions too
- Zero dependencies — only peer-imports pi's own bundled modules

## Install

```bash
pi install git:github.com/0xPlayerOne/pi-bash-inline-completion@v0.1.0
```

or from a local checkout:

```bash
pi install /path/to/pi-bash-inline-completion
```

## Usage

| Input | Result |
|-------|--------|
| `!cd` | dropdown — all entries |
| `!cd D` | dropdown — filtered to `D*` |
| `!cd Dow` | inline ghost `nloads/` |
| `→` / `Tab` | accept the suggestion |
| `Esc` | dismiss / clear as usual |

Works for any bash-mode path argument, not just `cd`: `!cat Do<Tab>`, `!vim do<Tab>`, `!!ls -la De<Tab>`…

## Compatibility

- Built and tested against **pi 0.85.0**.
- Hooks pi-tui editor internals that are private in the type declarations; a major
  pi update may require a touch-up. The extension fails visibly (a startup error
  message), never corrupts the session.

## How it works

The extension replaces the editor component with a subclass of pi's `CustomEditor`:

- A bash-aware wrapper around the shared autocomplete provider acts as the single
  decision point: 1 match diverts to the ghost (returning "no suggestions" closes the
  stock popup by design), multiple matches flow through to the genuine stock dropdown.
- Ghost text is spliced into the rendered cursor row at render time, taking cells
  from row padding so widths stay exact.
- The beam cursor swaps the base renderer's reverse-video block at render time; the
  blink is a focused render loop that pauses (solid) briefly after each keystroke.

## License

MIT
