// Bash inline completion — zsh-style ghost text in the Pi editor.
//
// In bash mode (message starts with "!"), path completions render as dimmed
// inline text after the cursor instead of a dropdown:
//   - type `!cd A`  →  "ppleStuff/" appears dimmed right after the cursor
//   - → (right arrow) or Tab accepts it
//   - accepting a directory immediately suggests its first entry (zsh-like)
//   - Escape dismisses
// Everything outside bash mode keeps stock editor behavior (dropdown etc.).

import {
  CustomEditor,
  type ExtensionAPI,
  type KeybindingsManager,
} from '@earendil-works/pi-coding-agent'
import {
  Editor,
  matchesKey,
  visibleWidth,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type EditorTheme,
  type TUI,
} from '@earendil-works/pi-tui'

/** Runtime access to Editor internals that are private in the type declarations. */
import {
  existsSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import type { AutocompleteItem } from '@earendil-works/pi-tui'

interface EditorInternals {
  state: { lines: string[]; cursorLine: number; cursorCol: number }
  autocompleteProvider?: AutocompleteProvider | null
  setCursorCol(col: number): void
  cancelAutocomplete(): void
  pushUndoSnapshot(): void
  tui: { requestRender(): void }
  requestAutocomplete(options: { force?: boolean; explicitTab?: boolean }): void
}

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
/** Set at extension load; used for dynamic completion exec calls. */
let execApi: ExtensionAPI | undefined
/** Active pi theme (set at session start) for theme-aware cursor colors. */
/** Persisted extension settings (~/.pi/agent/pi-autosuggestions.json). */
interface AutosuggestConfig {
  crossSessionHistory?: boolean
}
let config: AutosuggestConfig = {}
const configPath = `${homedir()}/.pi/agent/pi-autosuggestions.json`

function loadConfig(): void {
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    config = {}
  }
}

function saveConfig(): void {
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2))
  } catch {
    // read-only home — settings stay in-memory
  }
}
/** Beam cursor: thin vertical bar, bold so it stands out. One cell wide. */
const BEAM = '\x1b[1m▏\x1b[0m'
/** Matches the reverse-video block the base renderer emits for the cursor. */
const REVERSE_CURSOR = /\x1b\[7m([\s\S]*?)\x1b\[0m/

/** First-argument (subcommand) completions for common commands. */
const SUBCOMMANDS: Record<string, string[]> = {
  git: [
    'add',
    'am',
    'apply',
    'archive',
    'bisect',
    'blame',
    'branch',
    'bundle',
    'checkout',
    'cherry-pick',
    'clean',
    'clone',
    'commit',
    'config',
    'describe',
    'diff',
    'fetch',
    'fsck',
    'gc',
    'init',
    'log',
    'merge',
    'mv',
    'pull',
    'push',
    'rebase',
    'reflog',
    'remote',
    'repack',
    'reset',
    'restore',
    'revert',
    'rm',
    'shortlog',
    'show',
    'stash',
    'status',
    'submodule',
    'switch',
    'tag',
    'worktree',
  ],
  npm: [
    'audit',
    'bin',
    'bugs',
    'cache',
    'ci',
    'completion',
    'config',
    'dedupe',
    'deprecate',
    'diff',
    'dist-tag',
    'docs',
    'doctor',
    'edit',
    'exec',
    'explain',
    'explore',
    'find-dupes',
    'fund',
    'help',
    'hook',
    'init',
    'install',
    'link',
    'login',
    'logout',
    'ls',
    'npm-autoinit',
    'org',
    'outdated',
    'owner',
    'pack',
    'ping',
    'pkg',
    'prefix',
    'profile',
    'prune',
    'publish',
    'query',
    'rebuild',
    'repo',
    'restart',
    'root',
    'run-script',
    'search',
    'set',
    'shrinkwrap',
    'star',
    'stars',
    'start',
    'stop',
    'team',
    'test',
    'token',
    'uninstall',
    'unpublish',
    'unstar',
    'update',
    'version',
    'view',
    'whoami',
  ],
  pnpm: [
    'add',
    'audit',
    'bin',
    'config',
    'create',
    'dlx',
    'exec',
    'import',
    'init',
    'install',
    'link',
    'list',
    'outdated',
    'pack',
    'patch',
    'prune',
    'publish',
    'rebuild',
    'remove',
    'rename',
    'run',
    'store',
    'test',
    'unlink',
    'update',
    'why',
  ],
  yarn: [
    'add',
    'audit',
    'bin',
    'cache',
    'config',
    'create',
    'dedupe',
    'dlx',
    'exec',
    'global',
    'info',
    'init',
    'install',
    'link',
    'list',
    'outdated',
    'owner',
    'pack',
    'publish',
    'remove',
    'run',
    'self',
    'unlink',
    'upgrade',
    'up',
    'version',
    'why',
    'workspace',
    'workspaces',
  ],
  bun: [
    'add',
    'build',
    'create',
    'init',
    'install',
    'link',
    'outdated',
    'pm',
    'publish',
    'remove',
    'run',
    'test',
    'unlink',
    'update',
    'upgrade',
    'x',
  ],
  docker: [
    'attach',
    'build',
    'commit',
    'container',
    'cp',
    'create',
    'diff',
    'events',
    'exec',
    'export',
    'history',
    'image',
    'images',
    'import',
    'info',
    'inspect',
    'kill',
    'load',
    'login',
    'logout',
    'logs',
    'network',
    'pause',
    'port',
    'ps',
    'pull',
    'push',
    'rename',
    'restart',
    'rm',
    'rmi',
    'run',
    'save',
    'search',
    'start',
    'stats',
    'stop',
    'system',
    'tag',
    'top',
    'unpause',
    'update',
    'version',
    'volume',
    'wait',
  ],
  kubectl: [
    'annotate',
    'api-resources',
    'api-versions',
    'apply',
    'attach',
    'auth',
    'autoscale',
    'cluster-info',
    'completion',
    'config',
    'cordon',
    'cp',
    'create',
    'delete',
    'describe',
    'diff',
    'drain',
    'edit',
    'exec',
    'explain',
    'expose',
    'get',
    'label',
    'logs',
    'options',
    'patch',
    'port-forward',
    'proxy',
    'replace',
    'rollout',
    'run',
    'scale',
    'set',
    'taint',
    'top',
    'uncordon',
    'version',
    'wait',
  ],
  cargo: [
    'add',
    'bench',
    'build',
    'check',
    'clean',
    'doc',
    'fetch',
    'fix',
    'fmt',
    'init',
    'install',
    'locate-project',
    'login',
    'logout',
    'metadata',
    'new',
    'owner',
    'package',
    'publish',
    'read-manifest',
    'remove',
    'report',
    'run',
    'rustc',
    'rustdoc',
    'search',
    'test',
    'tree',
    'uninstall',
    'update',
    'vendor',
    'verify-project',
    'version',
    'yank',
  ],
  brew: [
    'audit',
    'bundle',
    'cleanup',
    'commands',
    'config',
    'deps',
    'desc',
    'doctor',
    'edit',
    'fetch',
    'formula',
    'home',
    'info',
    'install',
    'leaves',
    'link',
    'list',
    'log',
    'missing',
    'options',
    'outdated',
    'pin',
    'postinstall',
    'readall',
    'reinstall',
    'search',
    'services',
    'style',
    'tap',
    'uninstall',
    'unlink',
    'unpin',
    'untap',
    'update',
    'upgrade',
    'uses',
  ],
  gh: [
    'alias',
    'api',
    'auth',
    'browse',
    'cache',
    'codespace',
    'completion',
    'config',
    'extension',
    'gist',
    'gpg-key',
    'issue',
    'label',
    'org',
    'pr',
    'project',
    'release',
    'repo',
    'run',
    'search',
    'secret',
    'ssh-key',
    'status',
    'variable',
    'workflow',
  ],
  go: [
    'bug',
    'build',
    'clean',
    'doc',
    'env',
    'fix',
    'fmt',
    'generate',
    'get',
    'help',
    'install',
    'list',
    'mod',
    'run',
    'test',
    'tool',
    'version',
    'vet',
    'work',
  ],
  uv: [
    'add',
    'build',
    'cache',
    'export',
    'help',
    'init',
    'lock',
    'pip',
    'publish',
    'python',
    'remove',
    'run',
    'self',
    'sync',
    'tool',
    'tree',
    'venv',
    'version',
  ],
  pip: [
    'cache',
    'check',
    'config',
    'debug',
    'download',
    'freeze',
    'hash',
    'index',
    'inspect',
    'install',
    'list',
    'show',
    'uninstall',
    'wheel',
  ],
  poetry: [
    'add',
    'build',
    'cache',
    'check',
    'config',
    'env',
    'export',
    'init',
    'install',
    'list',
    'lock',
    'new',
    'publish',
    'remove',
    'run',
    'search',
    'self',
    'shell',
    'show',
    'source',
    'update',
    'version',
  ],
  terraform: [
    'apply',
    'console',
    'destroy',
    'fmt',
    'get',
    'graph',
    'import',
    'init',
    'output',
    'plan',
    'providers',
    'refresh',
    'show',
    'state',
    'taint',
    'test',
    'untaint',
    'validate',
    'version',
    'workspace',
  ],
  helm: [
    'completion',
    'create',
    'dependency',
    'env',
    'get',
    'help',
    'history',
    'install',
    'lint',
    'list',
    'package',
    'plugin',
    'pull',
    'push',
    'registry',
    'repo',
    'rollback',
    'search',
    'show',
    'status',
    'template',
    'test',
    'uninstall',
    'upgrade',
    'verify',
  ],
  wrangler: [
    'ai',
    'd1',
    'delete',
    'deploy',
    'dev',
    'dispatch',
    'init',
    'kv',
    'login',
    'logout',
    'logs',
    'r2',
    'rollback',
    'secret',
    'subdomain',
    'tail',
    'triggers',
    'types',
    'versions',
    'whoami',
  ],
  vercel: [
    'alias',
    'build',
    'deploy',
    'dev',
    'dns',
    'domains',
    'env',
    'init',
    'inspect',
    'link',
    'login',
    'logout',
    'logs',
    'ls',
    'projects',
    'pull',
    'remove',
    'switch',
    'teams',
    'telemetry',
    'whoami',
  ],
  mise: [
    'activate',
    'current',
    'deactivate',
    'doctor',
    'exec',
    'global',
    'install',
    'link',
    'list',
    'local',
    'ls',
    'outdated',
    'prune',
    'reshim',
    'run',
    'settings',
    'tasks',
    'uninstall',
    'upgrade',
    'use',
    'which',
  ],
  asdf: [
    'current',
    'exec',
    'global',
    'info',
    'install',
    'latest',
    'list',
    'list-all',
    'local',
    'plugin',
    'reshim',
    'shell',
    'uninstall',
    'update',
    'version',
    'where',
    'which',
  ],
  systemctl: [
    'cat',
    'disable',
    'enable',
    'is-active',
    'is-enabled',
    'isolate',
    'kill',
    'list',
    'list-dependencies',
    'list-timers',
    'list-units',
    'mask',
    'reload',
    'reload-or-restart',
    'restart',
    'set-default',
    'show',
    'start',
    'status',
    'stop',
    'unmask',
  ],
  apt: [
    'autoclean',
    'autopurge',
    'autoremove',
    'build-dep',
    'cache',
    'check',
    'clean',
    'download',
    'edit-sources',
    'full-upgrade',
    'help',
    'install',
    'list',
    'purge',
    'reinstall',
    'remove',
    'satisfy',
    'search',
    'show',
    'source',
    'update',
    'upgrade',
  ],
  pacman: [
    '-Q',
    '-R',
    '-S',
    '-T',
    '-U',
    '-F',
    'clean',
    'deps',
    'files',
    'help',
    'query',
    'remove',
    'sync',
    'test',
    'upgrade',
    'version',
  ],
}

const COMPOSE_SUBCOMMANDS = [
  'build',
  'config',
  'create',
  'down',
  'events',
  'exec',
  'images',
  'kill',
  'logs',
  'ls',
  'pause',
  'port',
  'ps',
  'pull',
  'push',
  'restart',
  'rm',
  'run',
  'start',
  'stop',
  'top',
  'unpause',
  'up',
  'version',
  'wait',
  'watch',
]

// (SUBCOMMANDS gains more tables below — see SUBCOMMANDS_EXTRA merge point.)

const DOCKER_CONTAINER_VERBS = [
  'start',
  'stop',
  'restart',
  'kill',
  'rm',
  'logs',
  'exec',
  'inspect',
  'stats',
  'top',
  'pause',
  'unpause',
  'commit',
]

const KUBECTL_RESOURCES = [
  'pods',
  'po',
  'deployments',
  'deploy',
  'services',
  'svc',
  'ingresses',
  'ing',
  'nodes',
  'no',
  'namespaces',
  'ns',
  'configmaps',
  'cm',
  'secrets',
  'persistentvolumes',
  'pv',
  'persistentvolumeclaims',
  'pvc',
  'events',
  'ev',
  'replicasets',
  'rs',
  'statefulsets',
  'sts',
  'daemonsets',
  'ds',
  'jobs',
  'cronjobs',
  'hpa',
  'endpoints',
  'ep',
]

const BLINK_INTERVAL_MS = 500
/** Cursor stays solid for this long after each keystroke, then resumes blinking. */
const SOLID_AFTER_INPUT_MS = 450

type GhostSource = 'history' | 'path'
type Ghost = { lineIndex: number; typed: string; suggestion: string; source: GhostSource }

class BashInlineEditor extends CustomEditor {
  private realProvider: AutocompleteProvider | undefined
  private bashProvider: AutocompleteProvider | undefined
  private ghost: Ghost | null = null
  private ghostToken = 0
  private ghostAbort?: AbortController
  /** Submitted prompts, oldest first — the zsh-autosuggestions history strategy. */
  private promptHistory: string[] = []
  private historyLoaded = false
  /** History candidates for the current ghost (most recent first). */
  private ghostCandidates: string[] = []
  private ghostCandidateIndex = 0
  /** Set by Escape; keeps the ghost dismissed until the next text edit. */
  private ghostSuppressed = false

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings)
    // Shadow the base Editor's private setCursorCol per instance (a
    // same-named declaration is rejected by TS2415). Virtual dispatch
    // routes base-internal and external calls here; refresh the ghost
    // after cursor moves (clicks, etc.).
    ;(this as unknown as { setCursorCol: (col: number) => void }).setCursorCol = (col: number) => {
      ;(Editor.prototype as unknown as EditorInternals).setCursorCol.call(this, col)
      this.updateGhost()
    }
    // Same treatment for the base Editor's private handleTabCompletion:
    // Tab reaches the ghost first, otherwise falls through to stock
    // behavior. A same-named declaration is rejected by TS2415, so the
    // shadow is installed per instance with identical dispatch semantics.
    ;(this as unknown as { handleTabCompletion: () => void }).handleTabCompletion = () => {
      if (this.activeGhost()) {
        this.acceptGhost()
        return
      }
      ;(
        Editor.prototype as unknown as { handleTabCompletion: () => void }
      ).handleTabCompletion.call(this)
    }
    // Native terminal cursor = the Apple-Terminal-style blinking bar: it
    // draws over the glyph's cell edge without covering the character.
    // - DECSCUSR 5 q: blinking bar shape (Warp honors this).
    // - OSC 12: force the cursor color white — terminals like Warp paint
    //   the native cursor with the theme's color (often blue), which we
    //   don't control from the theme.
    tui.setShowHardwareCursor(true)
    tui.terminal.write('\x1b]12;#ffffff\x1b\\')
    tui.terminal.write('\x1b[5 q')
    // Wrap onChange so programmatic text changes (paste, undo, history,
    // setText) also refresh the inline suggestion.
    let external: ((text: string) => void) | undefined
    const self = this
    Object.defineProperty(this, 'onChange', {
      configurable: true,
      enumerable: true,
      get() {
        if (!external) return undefined
        return (text: string) => {
          external!(text)
          self.updateGhost()
        }
      },
      set(fn) {
        external = fn
      },
    })
    // Capture submitted prompts for the history suggestion strategy
    // (zsh-autosuggestions records everything written to the shell line).
    let externalSubmit: ((text: string) => void) | undefined
    Object.defineProperty(this, 'onSubmit', {
      configurable: true,
      enumerable: true,
      get() {
        if (!externalSubmit) return undefined
        return (text: string) => {
          if (text.trim()) {
            self.promptHistory.push(text)
            if (self.promptHistory.length > 500) {
              self.promptHistory.shift()
            }
          }
          externalSubmit!(text)
        }
      },
      set(fn) {
        externalSubmit = fn
      },
    })
  }

  // Pi installs the shared autocomplete provider here. Wrap it once with
  // bash-mode-aware behavior; the wrapper is what the stock popup machinery
  // talks to, so dropdown open/close and ghost diversion stay consistent.
  // The base implementation dereferences the provider, so an undefined
  // teardown call clears our wrappers and nulls the base field directly
  // instead of forwarding it.
  setAutocompleteProvider(provider: AutocompleteProvider | undefined): void {
    if (!provider) {
      this.realProvider = undefined
      this.bashProvider = undefined
      ;(this as unknown as EditorInternals).autocompleteProvider = null
      return
    }
    super.setAutocompleteProvider(provider)
    this.realProvider = provider
    const bashProvider = this.createBashProvider(provider)
    this.bashProvider = bashProvider
    ;(this as unknown as EditorInternals).autocompleteProvider = bashProvider
  }

  handleInput(data: string): void {
    // Accept keys while a ghost suggestion is showing and the cursor sits
    // at end of line (zsh-autosuggestions widget semantics):
    //   right        → accept the whole suggestion
    //   alt+f        → accept the next word (partial accept)
    //   ctrl+right   → accept the next word (partial accept)
    if (matchesKey(data, 'escape')) {
      this.ghostSuppressed = true
    } else {
      this.ghostSuppressed = false
    }
    if (this.activeGhost() && this.cursorAtLineEnd()) {
      if (matchesKey(data, 'right')) {
        this.acceptGhost()
        return
      }
      if (matchesKey(data, 'alt+f') || matchesKey(data, 'ctrl+right')) {
        this.acceptGhostWord()
        return
      }
      if (matchesKey(data, 'alt+down')) {
        this.cycleGhostCandidate(1)
        return
      }
      if (matchesKey(data, 'alt+up')) {
        this.cycleGhostCandidate(-1)
        return
      }
    }
    super.handleInput(data)
    if (matchesKey(data, 'escape')) {
      this.ghost = null
    }
    // History suggestions work in every mode; bash mode adds the path
    // strategy (updateGhost clears the ghost itself when nothing matches).
    this.updateGhost()
  }

  render(width: number): string[] {
    const out = super.render(width)
    // Replace the base renderer's reverse-video block cursor with a blinking
    // beam. On ghost rows there is no separate cursor cell: the suggestion
    // starts flush after the typed text and the blink highlights its first
    // character instead.
    const rowIdx = out.findIndex((row) => REVERSE_CURSOR.test(row))
    if (rowIdx === -1) {
      return out
    }
    const row = out[rowIdx]!
    const match = REVERSE_CURSOR.exec(row)
    if (!match) {
      return out
    }
    const head = row.slice(0, match.index)
    const ch = match[1] || ' '
    if (this.tui.getShowHardwareCursor()) {
      // Native terminal cursor mode: strip the fake block so the real
      // blinking bar is the only cursor. It overlays the cell edge
      // without covering the character, and it rides the first ghost
      // character on suggestion rows.
      const ghost = this.activeGhost()
      if (!ghost) {
        // Empty cursor cell: the native bar blinks there, nothing covered.
        out[rowIdx] = head + ch + row.slice(match.index + match[0].length)
        return out
      }
      // The ghost starts AT the cursor cell so the native bar overlays
      // its first character (Apple Terminal bar-cursor behavior) instead
      // of sitting in a gap cell.
      const remainder = ghost.suggestion.slice(ghost.typed.length)
      const pad = / *$/.exec(row.slice(match.index + match[0].length))?.[0].length ?? 0
      const avail = pad + 1
      let used = 0
      const ghostCells: string[] = []
      for (const g of [...remainder]) {
        const w = visibleWidth(g)
        if (used + w > avail) {
          break
        }
        ghostCells.push(`${DIM}${g}${RESET}`)
        used += w
      }
      out[rowIdx] = head + ghostCells.join('') + ' '.repeat(Math.max(0, pad - used + 1))
      return out
    }
    const ghost = this.activeGhost()
    if (ghost) {
      // Fallback (software blink): ghost chars fill the padding.
      const remainder = ghost.suggestion.slice(ghost.typed.length)
      const pad = / *$/.exec(row.slice(match.index + match[0].length))?.[0].length ?? 0
      const avail = pad + 1
      let used = 0
      const ghostCells: string[] = []
      for (const g of [...remainder]) {
        const w = visibleWidth(g)
        if (used + w > avail) {
          break
        }
        ghostCells.push(`${DIM}${g}${RESET}`)
        used += w
      }
      out[rowIdx] = head + BEAM + ghostCells.join('') + ' '.repeat(Math.max(0, pad - used))
      return out
    }
    out[rowIdx] = head + BEAM + row.slice(match.index + match[0].length)
    return out
  }

  // --- internals ---

  private inBashMode(): boolean {
    return this.getText().trimStart().startsWith('!')
  }

  private cursorAtLineEnd(): boolean {
    const st = (this as unknown as EditorInternals).state
    return st.cursorCol === (st.lines[st.cursorLine] ?? '').length
  }

  /** Suppress the dropdown in bash mode unless the popup is already open. */

  /**
   * True while the command word after "!" is still being typed (no space
   * yet), e.g. "!cd" or "!!ls" — completion targets the argument position.
   */
  private commandPosition(beforeCursor: string): boolean {
    return /^[ \t]*![^\s]*$/.test(beforeCursor)
  }

  /**
   * Wrap the stock provider with bash-mode behavior:
   *   - command position ("!cd", no space yet) → suggest all entries
   *   - non-bash text → untouched stock behavior
   * The ghost-vs-dropdown split (one match → ghost, many → dropdown) is
   * decided in updateGhost(), which sees the final suggestion counts.
   */
  /** Executable names on $PATH, cached for the session (zsh command completion). */
  private pathCommandCache: string[] | null = null

  private getPathCommands(): string[] {
    if (this.pathCommandCache) {
      return this.pathCommandCache
    }
    const names = new Set<string>()
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (!dir) {
        continue
      }
      let entries
      try {
        entries = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of entries) {
        if (names.has(name)) {
          continue
        }
        try {
          // eslint-disable-next-line no-bitwise
          if (statSync(`${dir}/${name}`).mode & 0o111) {
            names.add(name)
          }
        } catch {
          // dangling symlink or unreadable entry
        }
      }
    }
    this.pathCommandCache = [...names].sort()
    return this.pathCommandCache
  }

  /** PATH commands starting with the typed command word. */
  private matchingCommands(word: string): string[] {
    if (!word) {
      return []
    }
    return this.getPathCommands()
      .filter((name) => name.startsWith(word))
      .slice(0, 100)
  }

  private dynCache = new Map<string, { at: number; data: string[] }>()

  private cached(key: string, ttl: number, fetch: () => Promise<string[]>): Promise<string[]> {
    const hit = this.dynCache.get(key)
    if (hit && Date.now() - hit.at < ttl) {
      return Promise.resolve(hit.data)
    }
    return fetch()
      .then((data) => {
        this.dynCache.set(key, { at: Date.now(), data })
        return data
      })
      .catch(() => [])
  }

  private async runCommand(cmd: string, args: string[], timeout = 4000): Promise<string[]> {
    if (!execApi) {
      return []
    }
    const result = await execApi.exec(cmd, args, { cwd: process.cwd(), timeout })
    if (result.code !== 0) {
      return []
    }
    return result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  }

  private findUp(name: string): string | null {
    let dir = process.cwd()
    for (;;) {
      const candidate = `${dir}/${name}`
      if (existsSync(candidate)) {
        return candidate
      }
      const parent = dirname(dir)
      if (parent === dir) {
        return null
      }
      dir = parent
    }
  }

  private gitBranches(): Promise<string[]> {
    return this.cached('git:branches', 10_000, async () =>
      (await this.runCommand('git', ['branch', '--list']))
        .map((l) => l.replace(/^\*?\s*/, ''))
        .filter((l) => l && !l.includes(' '))
    )
  }

  private npmScripts(): Promise<string[]> {
    return this.cached('npm:scripts', 10_000, async () => {
      const pkg = this.findUp('package.json')
      if (!pkg) {
        return []
      }
      const parsed: { scripts?: Record<string, string> } = JSON.parse(readFileSync(pkg, 'utf8'))
      return Object.keys(parsed.scripts ?? {})
    })
  }

  private makeTargets(): Promise<string[]> {
    return this.cached('make:targets', 10_000, async () => {
      const file = this.findUp('Makefile') ?? this.findUp('makefile')
      if (!file) {
        return []
      }
      const targets = new Set<string>()
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = /^([a-zA-Z0-9][^\s=$#]*(?:\s+[a-zA-Z0-9][^\s=$#]*)?):(?!=)/.exec(line)
        if (m) {
          for (const t of m[1]!.trim().split(/\s+/)) {
            targets.add(t)
          }
        }
      }
      return [...targets]
    })
  }

  /** Live sources: git branches, package scripts, make targets, compose. */
  private sshHosts(): Promise<string[]> {
    return this.cached('ssh:hosts', 60_000, async () => {
      const cfg = `${homedir()}/.ssh/config`
      if (!existsSync(cfg)) {
        return []
      }
      const hosts: string[] = []
      for (const lineText of readFileSync(cfg, 'utf8').split('\n')) {
        const m = /^\s*[Hh]ost\s+(.+)$/.exec(lineText)
        if (m) {
          for (const host of m[1]!.trim().split(/\s+/)) {
            if (!host.includes('*') && !hosts.includes(host)) {
              hosts.push(host)
            }
          }
        }
      }
      return hosts
    })
  }

  private dockerContainers(): Promise<string[]> {
    return this.cached(
      'docker:containers',
      10_000,
      async () => await this.runCommand('docker', ['ps', '--format', '{{.Names}}'])
    )
  }

  private async dynamicCompletions(
    cmd: string,
    args: string[],
    token: string
  ): Promise<{ items: string[]; description: string } | null> {
    let items: string[] | null = null
    let description = ''
    if (
      cmd === 'git' &&
      args.length === 1 &&
      ['checkout', 'switch', 'merge', 'rebase'].includes(args[0]!)
    ) {
      items = (await this.gitBranches()).filter((b) => b.startsWith(token))
      description = 'branch'
    } else if (cmd === 'git' && args[0] === 'branch' && args.length === 1) {
      items = (await this.gitBranches()).filter((b) => b.startsWith(token))
      description = 'branch'
    } else if (
      ['npm', 'pnpm', 'yarn', 'bun'].includes(cmd) &&
      ((args[0] === 'run' && args.length === 1) || (cmd !== 'npm' && args.length === 0))
    ) {
      items = (await this.npmScripts()).filter((sc) => sc.startsWith(token))
      description = 'script'
    } else if ((cmd === 'make' || cmd === 'gmake') && args.length === 0) {
      items = (await this.makeTargets()).filter((t) => t.startsWith(token))
      description = 'make target'
    } else if (cmd === 'docker' && args[0] === 'compose' && args.length === 1) {
      items = COMPOSE_SUBCOMMANDS.filter((sc) => sc.startsWith(token))
      description = 'compose subcommand'
    } else if (cmd === 'docker' && args.length === 1 && DOCKER_CONTAINER_VERBS.includes(args[0]!)) {
      items = (await this.dockerContainers()).filter((c) => c.startsWith(token))
      description = 'container'
    } else if (cmd === 'kubectl' && args[0] === 'get' && args.length === 1) {
      items = KUBECTL_RESOURCES.filter((r) => r.startsWith(token))
      description = 'resource'
    } else if (['ssh', 'scp'].includes(cmd) && args.length === 0) {
      items = (await this.sshHosts()).filter((h) => h.startsWith(token))
      description = 'host'
    }
    if (!items || items.length === 0) {
      return null
    }
    return { items: items.slice(0, 50), description }
  }

  private createBashProvider(current: AutocompleteProvider): AutocompleteProvider {
    const self = this
    return {
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        if (!self.inBashMode()) {
          return current.getSuggestions(lines, cursorLine, cursorCol, options)
        }
        const before = (lines[cursorLine] ?? '').slice(0, cursorCol)
        // First-argument completion for known commands:
        // "!git s" → status/stash/show… (replaces path completion).
        const arg = /^[\t ]*!+(\S+)[ \t]+(\S*)$/.exec(before)
        if (arg) {
          const cmd = arg[1]!
          const token = arg[2] ?? ''
          const subs = SUBCOMMANDS[cmd]
          const staticMatches = (subs ?? []).filter((sc) => sc.startsWith(token)).slice(0, 50)
          const dynamic = await self.dynamicCompletions(cmd, [], token)
          const dynamicItems = dynamic?.items.filter((d) => !staticMatches.includes(d)) ?? []
          if (staticMatches.length > 0 || dynamicItems.length > 0) {
            return {
              items: [
                ...staticMatches.map((sc) => ({
                  value: sc,
                  label: sc,
                  description: `${cmd} subcommand`,
                })),
                ...dynamicItems.map((sc) => ({
                  value: sc,
                  label: sc,
                  description: dynamic!.description,
                })),
              ],
              prefix: token,
            }
          }
          // Nothing matched: fall through to paths.
        }
        // Second-argument dynamic completion (branches, scripts, compose…).
        const words = before.replace(/^[\t ]*!+/, '').split(/[ \t]+/)
        if (words.length >= 2) {
          const cmd = words[0]!
          const token = words[words.length - 1]!
          const args = words.slice(1, -1).filter(Boolean)
          const dyn = await self.dynamicCompletions(cmd, args, token)
          if (dyn && dyn.items.length > 0) {
            return {
              items: dyn.items.map((sc) => ({
                value: sc,
                label: sc,
                description: dyn.description,
              })),
              prefix: token,
            }
          }
        }
        let queryLines = lines
        let commandItems: AutocompleteItem[] = []
        let word = ''
        if (self.commandPosition(before)) {
          word = before.replace(/^[ \t]*!+/, '')
          const commands = self.matchingCommands(word)
          queryLines = [...lines]
          if (commands.length > 0) {
            // The typed word is a prefix of real commands: offer them
            // first, plus any matching file paths as fallback.
            commandItems = commands.map((name) => ({
              value: name,
              label: name,
              description: 'command',
            }))
            queryLines[cursorLine] = `! ${word}`
          } else {
            // Neutralize the command word so the provider completes the
            // (empty) argument position: every entry matches.
            queryLines[cursorLine] = before.replace(/![^!\s]*$/, '! ')
          }
        }
        const suggestions = await current.getSuggestions(queryLines, cursorLine, cursorCol, {
          ...options,
          force: true,
        })
        if (commandItems.length === 0) {
          return suggestions
        }
        return {
          items: [...commandItems, ...(suggestions?.items ?? [])],
          prefix: word,
        }
      },

      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        const before = (lines[cursorLine] ?? '').slice(0, cursorCol)
        if (self.inBashMode() && self.commandPosition(before)) {
          const value = item.value ?? ''
          const line = lines[cursorLine] ?? ''
          const newLines = [...lines]
          if (item.description === 'command') {
            // Completing the command word itself ("!gi" + git → "!git").
            const start = cursorCol - prefix.length
            newLines[cursorLine] = line.slice(0, start) + value + line.slice(cursorCol)
            return { lines: newLines, cursorLine, cursorCol: start + value.length }
          }
          // Completing from the command position: insert the chosen path
          // as the first argument ("!cd" + AppleStuff/ → "!cd AppleStuff/").
          newLines[cursorLine] = `${line.slice(0, cursorCol)} ${value}${line.slice(cursorCol)}`
          return { lines: newLines, cursorLine, cursorCol: cursorCol + 1 + value.length }
        }
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
      },

      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
      },
    }
  }
  /** The ghost suggestion, only if it still matches the current editor state. */
  private activeGhost(): Ghost | null {
    const ghost = this.ghost
    if (!ghost || this.isShowingAutocomplete() || !this.cursorAtLineEnd()) {
      return null
    }
    const st = (this as unknown as EditorInternals).state
    if (ghost.lineIndex !== st.cursorLine) {
      return null
    }
    const line = st.lines[st.cursorLine] ?? ''
    const before = line.slice(0, st.cursorCol)
    if (before !== ghost.typed || ghost.suggestion.length <= ghost.typed.length) {
      return null
    }
    return ghost
  }

  /** Most recent history entry extending the current line (history strategy). */
  private historyGhost(): Ghost | null {
    this.loadCrossSessionHistory()
    const st = (this as unknown as EditorInternals).state
    const line = st.lines[st.cursorLine] ?? ''
    const typed = line.slice(0, st.cursorCol)
    if (!typed.trim()) {
      return null
    }
    const matches: string[] = []
    for (let i = this.promptHistory.length - 1; i >= 0; i--) {
      const entry = this.promptHistory[i] ?? ''
      // Suggest only the entry's first line: ghost text renders on a
      // single editor row (full multi-line entries are inserted on accept).
      const firstLine = entry.split('\n', 1)[0] ?? ''
      if (
        firstLine.length > typed.length &&
        firstLine.startsWith(typed) &&
        !matches.includes(firstLine)
      ) {
        matches.push(firstLine)
      }
    }
    this.ghostCandidates = matches
    this.ghostCandidateIndex = 0
    const first = matches[0]
    return first ? { lineIndex: st.cursorLine, typed, suggestion: first, source: 'history' } : null
  }

  /**
   * Seed the history strategy with prompts from previous sessions in this
   * working directory. Opt-in via /autosuggest; runs once per editor.
   */
  private loadCrossSessionHistory(): void {
    if (this.historyLoaded) {
      return
    }
    this.historyLoaded = true
    if (!config.crossSessionHistory) {
      return
    }
    try {
      const sessionsDir = `${homedir()}/.pi/agent/sessions`
      const encoded = (p: string) => `--${p.split('/').filter(Boolean).join('-')}--`
      let dir: string | undefined
      for (const candidate of [process.cwd(), realpathSync(process.cwd())]) {
        const path13 = `${sessionsDir}/${encoded(candidate)}`
        if (existsSync(path13)) {
          dir = path13
          break
        }
      }
      if (!dir) {
        return
      }
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .slice(-5)
      const prompts: string[] = []
      for (const file of files) {
        for (const lineText of readFileSync(`${dir}/${file}`, 'utf8').split('\n')) {
          try {
            const entry = JSON.parse(lineText) as {
              type?: string
              message?: { role?: string; content?: string | { type?: string; text?: string }[] }
            }
            if (entry.type !== 'message' || entry.message?.role !== 'user') {
              continue
            }
            const content = entry.message.content
            const text =
              typeof content === 'string'
                ? content
                : (content ?? [])
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text ?? '')
                    .join('')
            const firstLine = text.split('\n', 1)[0] ?? ''
            if (firstLine.trim()) {
              prompts.push(firstLine)
            }
          } catch {
            // partial line or unsupported entry
          }
        }
      }
      // Cross-session entries come before anything typed this session.
      this.promptHistory = [...prompts.reverse(), ...this.promptHistory]
    } catch (e) {}
  }

  /** Rotate to the previous/next history candidate (Alt+Up / Alt+Down). */
  private cycleGhostCandidate(dir: 1 | -1): void {
    const ghost = this.activeGhost()
    if (!ghost || ghost.source !== 'history' || this.ghostCandidates.length < 2) {
      return
    }
    this.ghostCandidateIndex =
      (this.ghostCandidateIndex + dir + this.ghostCandidates.length) % this.ghostCandidates.length
    this.ghost = { ...ghost, suggestion: this.ghostCandidates[this.ghostCandidateIndex]! }
    ;(this as unknown as EditorInternals).tui.requestRender()
  }

  /** Path ghost from provider suggestions (completion strategy, bash mode). */
  private pathGhost(suggestions: AutocompleteSuggestions | null, lineIndex: number): Ghost | null {
    const st = (this as unknown as EditorInternals).state
    const line = st.lines[lineIndex] ?? ''
    const before = line.slice(0, st.cursorCol)
    const token = suggestions?.prefix ?? ''
    const value = suggestions?.items[0]?.value ?? ''
    if (!value || !value.toLowerCase().startsWith(token.toLowerCase())) {
      return null
    }
    const isCommand = suggestions?.items[0]?.description === 'command'
    const separator = isCommand ? '' : this.commandPosition(before) ? ' ' : ''
    const suggestion = before.slice(0, before.length - token.length) + separator + value
    if (suggestion.length <= before.length) {
      return null
    }
    return { lineIndex, typed: before, suggestion, source: 'path' }
  }

  private acceptGhost(): void {
    const ghost = this.activeGhost()
    if (!ghost) {
      return
    }
    const st = (this as unknown as EditorInternals).state
    const line = st.lines[ghost.lineIndex] ?? ''
    const col = st.cursorCol
    ;(this as unknown as EditorInternals).pushUndoSnapshot()
    st.lines[ghost.lineIndex] =
      line.slice(0, col - ghost.typed.length) + ghost.suggestion + line.slice(col)
    this.ghost = null
    ;(this as unknown as EditorInternals).setCursorCol(
      col - ghost.typed.length + ghost.suggestion.length
    )
    this.onChange?.(this.getText())
    // Like zsh: after accepting, immediately suggest the next part.
    this.updateGhost()
  }

  /** Partial accept (autosuggest-accept-word): take the next word of the suggestion. */
  private acceptGhostWord(): void {
    const ghost = this.activeGhost()
    if (!ghost) {
      return
    }
    const remainder = ghost.suggestion.slice(ghost.typed.length)
    const chunk = /^\S+\s*/.exec(remainder)?.[0]
    if (!chunk) {
      return
    }
    const st = (this as unknown as EditorInternals).state
    const line = st.lines[ghost.lineIndex] ?? ''
    const col = st.cursorCol
    ;(this as unknown as EditorInternals).pushUndoSnapshot()
    st.lines[ghost.lineIndex] = line.slice(0, col) + chunk + line.slice(col)
    this.ghost = { ...ghost, typed: ghost.typed + chunk }
    ;(this as unknown as EditorInternals).setCursorCol(col + chunk.length)
    this.onChange?.(this.getText())
    this.updateGhost()
  }

  private updateGhost(): void {
    const st = this as unknown as EditorInternals
    // Dismissed via Escape; stays dismissed until the next text edit.
    if (this.ghostSuppressed) {
      this.ghost = null
      return
    }
    // zsh-autosuggestions hides the suggestion once the cursor moves off
    // the end of the buffer.
    if (!this.cursorAtLineEnd()) {
      this.ghost = null
      return
    }
    const history = this.historyGhost()
    if (!this.inBashMode()) {
      // History strategy works everywhere, like zsh-autosuggestions.
      this.ghost = history
      st.tui.requestRender()
      return
    }
    const provider = this.bashProvider
    if (!provider) {
      this.ghost = history
      return
    }
    const token = ++this.ghostToken
    const lineIndex = st.state.cursorLine
    const controller = new AbortController()
    this.ghostAbort?.abort()
    this.ghostAbort = controller
    void provider
      .getSuggestions(st.state.lines, lineIndex, st.state.cursorCol, {
        signal: controller.signal,
        force: true,
      })
      .then((suggestions: AutocompleteSuggestions | null) => {
        if (token !== this.ghostToken) {
          return
        }
        const items = suggestions?.items ?? []
        if (items.length > 1) {
          // Multiple path options win: show the stock dropdown, no ghost.
          this.ghost = null
          if (!this.isShowingAutocomplete()) {
            st.requestAutocomplete({ force: true, explicitTab: false })
          }
        } else {
          // Zero or one path option: prefer the history ghost, then the
          // path ghost (zsh-autosuggestions strategy order: history first).
          if (this.isShowingAutocomplete()) {
            st.cancelAutocomplete()
          }
          this.ghost = history ?? this.pathGhost(suggestions, lineIndex)
        }
        st.tui.requestRender()
      })
      .catch(() => {})
  }
}

export default function (pi: ExtensionAPI): void {
  execApi = pi
  loadConfig()
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new BashInlineEditor(tui, theme, keybindings)
    )
  })
  pi.registerCommand('autosuggest', {
    description: 'Toggle cross-session history for ghost suggestions',
    handler: async (args, ctx) => {
      const arg = (args ?? '').trim().toLowerCase()
      if (arg === 'on' || arg === 'off') {
        config.crossSessionHistory = arg === 'on'
      } else {
        config.crossSessionHistory = !config.crossSessionHistory
      }
      saveConfig()
      const state = config.crossSessionHistory ? 'ON' : 'OFF'
      ctx.ui.notify(
        `pi-autosuggestions: cross-session history ${state}${config.crossSessionHistory ? ' (applies next session)' : ''}`,
        'info'
      )
    },
  })
  // Restore the terminal's own cursor color and shape when pi exits so the
  // shell afterwards isn't left with our forced white bar.
  process.on('exit', () => {
    try {
      process.stdout.write('\x1b]104;12\x1b\\\x1b[0 q')
    } catch {
      // terminal gone — nothing to restore
    }
  })
}
