# pi-autosuggestions

[zsh-autosuggestions](https://github.com/zsh-users/zsh-autosuggestions)-style
ghost completions for the [pi coding agent](https://github.com/earendil-works/pi-mono),
with the path-completion layer fish and zsh users expect from a modern setup.

As you type, a suggestion appears **dimmed, inline, right after your cursor** —
no dropdown, no Tab required. Press `→` to accept it all, `Alt+f` to accept it
one word at a time.

```
you type:  !cd Desk
you see:   !cd Desktop/     ( dimmed "top/", first char is your blinking cursor )
```

## Install

```bash
pi install git:github.com/0xPlayerOne/pi-autosuggestions
# or pinned:
pi install git:github.com/0xPlayerOne/pi-autosuggestions@pi-autosuggestions-v0.2.1
# or from npm:
pi install npm:pi-autosuggestions
```

## Features

### zsh-autosuggestions behavior

- **History strategy** — every prompt you submit is remembered; start typing a
  prefix of a previous prompt and its continuation appears as dimmed ghost text,
  most recent match first. Works everywhere in the editor, not just bash mode —
  exactly like `zsh-autosuggestions` works on every shell line.
- **`→`** — accept the whole suggestion (`autosuggest-accept`)
- **`Alt+f` / `Ctrl+→`** — partial accept: take the next word
  (`autosuggest-accept-word`), like zsh's default `alt+f` binding
- **`Esc`** — dismiss the suggestion until your next edit
- Suggestion hides when the cursor leaves end-of-line, returns when you come back

### Path completion (fish/zsh-completion flavored)

In bash mode (`!command`), a second strategy completes **filesystem paths**:

| Input | Result |
|-------|--------|
| `!cd` | dropdown — all entries |
| `!cd D` | dropdown — filtered to `D*` |
| `!cd Dow` | inline ghost `nloads/` |
| `→` / `Tab` | accept |
| accept a directory | immediately suggests its first entry (zsh-like chaining) |

- **Command position aware** — `!cd` (no space yet) lists everything; picking an
  entry inserts it as the first argument
- **Priority**: multiple path options → stock dropdown (fully interactive);
  zero or one option → ghost, with history winning over paths
- Works for `!!` hidden commands and any bash argument, not just `cd`

### Beam cursor

The block cursor becomes a thin blinking vertical bar (`▏`, ~2 Hz) that stays
solid while you type. On ghost rows the cursor rides the suggestion's first
character, zsh-autosuggestions style.

## Attribution

This extension reimplements the interaction model of:

- [zsh-autosuggestions](https://github.com/zsh-users/zsh-autosuggestions) — the
  ghost-suggestion UX, history strategy, accept/partial-accept widgets
  (`autosuggest-accept`, `autosuggest-accept-word`), and
  [fish](https://fishshell.com/docs/current/interactive.html#autosuggestions),
  which pioneered autosuggestions natively
- The zsh completion system's menu behavior for the dropdown fallback

Differences from the shell originals: suggestions are scoped to the current
session (pi has no persistent shell history file yet), and history matching is
line-scoped. Strategy order mirrors zsh-autosuggestions: history first, then
completions.

## Compatibility

- Built and tested against **pi 0.85.0**
- Hooks pi-tui editor internals that are private in the type declarations; a
  major pi update may require a touch-up. Failures are visible at startup, never
  silent.

## License

MIT
