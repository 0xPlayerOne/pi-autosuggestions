// Contract tests for the custom editor against the installed pi/pi-tui.
//
// The extension reaches into editor internals that are `private` in the type
// declarations, so TypeScript cannot catch a rename or a signature change on a
// pi upgrade. These tests instantiate the real editor and fail loudly instead,
// which is what makes the "never silent" claim in the README true.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The extension resolves its settings file and cross-session history from the
// home directory at module load. Point HOME at a scratch directory first so a
// developer's real history cannot leak into the ghost assertions below.
const home = mkdtempSync(join(tmpdir(), 'pi-autosuggestions-test-'))
process.env.HOME = home
process.env.USERPROFILE = home

const root = join(import.meta.dirname, '..')
const { TuiMainScreen, Editor, visibleWidth } = await import('@earendil-works/pi-tui')
const loadExtension = (await import(join(root, 'dist/autosuggestions.js'))).default

const theme = { borderColor: (str) => str, selectList: {} }
/** Only `matches` is consulted; no action should fire in these tests. */
const keybindings = { matches: () => false }

// pi loads an extension once per session, so install it once and reuse the
// handler. Loading it per test would stack a process 'exit' listener each time
// and spray the cursor-restore sequence at the end of the run.
let onSessionStart
const pi = {
  on: (event, handler) => {
    if (event === 'session_start') {
      onSessionStart = handler
    }
  },
  registerCommand() {},
  exec: async () => ({ code: 0, stdout: '', stderr: '' }),
}
loadExtension(pi)
assert.equal(typeof onSessionStart, 'function', 'extension did not register session_start')

/**
 * Build an editor the way pi hands one to the custom component.
 * `hardwareCursor: false` models the transient state the editor can be in
 * right after a pi `/reload`, which selects the software-blink render path.
 */
function createEditor({ columns = 80, hardwareCursor = true } = {}) {
  const written = []
  const terminal = {
    columns,
    rows: 24,
    hideCursor() {},
    showCursor() {},
    start() {},
    stop() {},
    write: (data) => written.push(data),
  }
  const tui = new TuiMainScreen(terminal, false)

  let factory
  onSessionStart({}, { ui: { setEditorComponent: (fn) => (factory = fn) } })
  assert.equal(typeof factory, 'function', 'extension did not install an editor component')

  const editor = factory(tui, theme, keybindings)
  tui.setShowHardwareCursor(hardwareCursor)
  return { editor, tui, written }
}

/** The dim sequence the editor wraps ghost text in. */
// oxlint-disable-next-line no-control-regex -- matching ANSI escape output requires control characters
const DIM = /\x1b\[2m/
// oxlint-disable-next-line no-control-regex -- matching ANSI escape output requires control characters
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const stripAnsi = (str) => str.replaceAll(ANSI, '')

/**
 * pi aborts its render loop when any line is wider than the terminal, so
 * assert the whole frame, not just the ghost row.
 */
function assertFits(editor, width) {
  for (const [index, row] of editor.render(width).entries()) {
    assert.ok(
      visibleWidth(row) <= width,
      `row ${index} is ${visibleWidth(row)} cells wide, exceeding the ${width}-cell terminal`
    )
  }
}

describe('pi/pi-tui contract', () => {
  it('exposes the editor internals the extension shadows', () => {
    // Each of these is `private` in the .d.ts, so a pi upgrade can remove or
    // rename it without a type error. The extension calls them through
    // `as unknown as` casts precisely because of that.
    for (const method of [
      'setCursorCol',
      'handleTabCompletion',
      'pushUndoSnapshot',
      'requestAutocomplete',
      'cancelAutocomplete',
      'isShowingAutocomplete',
      'setAutocompleteProvider',
    ]) {
      assert.equal(
        typeof Editor.prototype[method],
        'function',
        `Editor.prototype.${method} is gone — the extension's private-internals hooks need a touch-up`
      )
    }
  })

  it('keeps the editor state shape the ghost logic indexes into', () => {
    const { editor } = createEditor()
    const state = editor.state
    assert.ok(Array.isArray(state.lines), 'editor.state.lines is missing')
    assert.equal(typeof state.cursorLine, 'number', 'editor.state.cursorLine is missing')
    assert.equal(typeof state.cursorCol, 'number', 'editor.state.cursorCol is missing')
  })

  it('installs the per-instance shadow patches it relies on', () => {
    const { editor } = createEditor()
    // These shadow private base methods; a same-named class declaration is
    // rejected by TS2415, so the extension assigns them per instance.
    assert.ok(Object.hasOwn(editor, 'setCursorCol'), 'setCursorCol shadow was not installed')
    assert.ok(
      Object.hasOwn(editor, 'handleTabCompletion'),
      'handleTabCompletion shadow was not installed'
    )
  })
})

describe('custom editor', () => {
  it('asks for the hardware cursor and forces a blinking white bar', () => {
    const { editor, tui, written } = createEditor()
    assert.equal(tui.getShowHardwareCursor(), true, 'hardware cursor was not enabled')
    // OSC 12 sets the cursor color, DECSCUSR 5 the blinking bar shape.
    assert.ok(
      written.some((chunk) => chunk.includes(']12;')),
      'OSC 12 cursor-color sequence was not written'
    )
    assert.ok(
      written.some((chunk) => chunk.includes('[5 q')),
      'DECSCUSR 5 blinking-bar sequence was not written'
    )
    assert.equal(typeof editor.getText(), 'string')
  })

  it('ghosts the remainder of a previously submitted prompt', () => {
    const { editor } = createEditor()
    // Record a prompt the way pi does, then type a prefix of it.
    editor.onSubmit = () => {}
    editor.onSubmit('git status --short')
    editor.setText('git st')

    const row = editor.render(80).find((line) => line.includes('git st'))
    assert.ok(row, 'the typed line did not render')
    assert.match(row, DIM, 'ghost text is not dimmed')
    assert.equal(
      stripAnsi(row).trim(),
      'git status --short',
      'the ghost did not show the rest of the submitted prompt'
    )
  })

  it('shows no ghost for text that matches no earlier prompt', () => {
    const { editor } = createEditor()
    editor.onSubmit = () => {}
    editor.onSubmit('git status --short')
    editor.setText('zzz')

    const row = editor.render(80).find((line) => line.includes('zzz'))
    assert.ok(row, 'the typed line did not render')
    assert.equal(stripAnsi(row).trim(), 'zzz', 'an unrelated prefix should not produce a ghost')
  })

  it('dismisses the ghost on escape until the next edit', () => {
    const { editor } = createEditor()
    editor.onSubmit = () => {}
    editor.onSubmit('git status --short')
    editor.setText('git st')
    assert.match(editor.render(80).join(''), DIM, 'expected a ghost before escape')

    editor.handleInput('\x1b')
    const dismissed = editor.render(80).join('')
    assert.doesNotMatch(dismissed, /status/, 'escape did not dismiss the ghost')
  })
})

// Issue #67: pi enforces that every rendered line fits the terminal and aborts
// the render loop (writing pi-tui-crash.log) when one does not. The
// software-blink fallback budgets the ghost against `pad + 1` but also emits
// the beam as its own cell, so a ghost long enough to reach the end of the line
// came out one column too wide.
describe('render width (issue #67)', () => {
  /** A history entry whose ghost fills the line from a one-character prefix. */
  function fillTheLine(width, hardwareCursor) {
    const { editor } = createEditor({ columns: width, hardwareCursor })
    editor.onSubmit = () => {}
    editor.onSubmit('r' + 'x'.repeat(width - 1))
    editor.setText('r')
    return editor
  }

  for (const hardwareCursor of [false, true]) {
    const path = hardwareCursor ? 'hardware-cursor path' : 'software-blink fallback'
    it(`keeps a full-width ghost within the terminal on the ${path}`, () => {
      // Width 87 with an 86-character ghost is the case from the report.
      assertFits(fillTheLine(87, hardwareCursor), 87)
    })

    it(`keeps a full-width ghost within a narrow terminal on the ${path}`, () => {
      assertFits(fillTheLine(40, hardwareCursor), 40)
    })

    it(`keeps a ghost with no padding on the ${path}`, () => {
      // A ghost that exactly fills the line leaves no trailing pad at all.
      const { editor } = createEditor({ columns: 20, hardwareCursor })
      editor.onSubmit = () => {}
      editor.onSubmit('r' + 'y'.repeat(19))
      editor.setText('r')
      assertFits(editor, 20)
    })
  }

  it('does not overflow when the ghost is longer than the terminal', () => {
    for (const hardwareCursor of [false, true]) {
      const { editor } = createEditor({ columns: 30, hardwareCursor })
      editor.onSubmit = () => {}
      editor.onSubmit('r' + 'z'.repeat(200))
      editor.setText('r')
      assertFits(editor, 30)
    }
  })
})
