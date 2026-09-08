import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
const budgets = JSON.parse(readFileSync(join(root, 'performance-budgets.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

if (!global.gc) {
  throw new Error('Run this harness with Node.js --expose-gc')
}

function run(command, args) {
  const started = performance.now()
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const elapsed = performance.now() - started
  if (result.status !== 0) {
    process.stderr.write(result.stdout)
    process.stderr.write(result.stderr)
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
  return { elapsed, stdout: result.stdout }
}

const build = run('npm', ['run', 'build', '--silent'])
const tests = run('npm', ['run', 'test:unit', '--silent'])

global.gc()
const heapBeforeImport = process.memoryUsage().heapUsed
await import(pathToFileURL(join(root, 'dist/autosuggestions.js')).href)
global.gc()
const pluginImportHeapBytes = Math.max(0, process.memoryUsage().heapUsed - heapBeforeImport)

const { findHistoryCandidates } = await import(pathToFileURL(join(root, 'dist/history.js')).href)
const history = Array.from({ length: 5_000 }, (_, index) => {
  const command = index % 5 === 0 ? 'git status' : `git switch feature-${index % 250}`
  return index % 17 === 0 ? `${command}\nfollow-up context` : command
})

for (let i = 0; i < 100; i++) {
  findHistoryCandidates(history, 'git s')
}

const samples = []
for (let i = 0; i < 1_000; i++) {
  const started = performance.now()
  findHistoryCandidates(history, 'git s')
  samples.push(performance.now() - started)
}
samples.sort((a, b) => a - b)
const historyP95Milliseconds = samples[Math.ceil(samples.length * 0.95) - 1]

global.gc()
const heapBeforeHistory = process.memoryUsage().heapUsed
for (let i = 0; i < 10_000; i++) {
  findHistoryCandidates(history, 'git s')
}
global.gc()
const historyRetainedHeapBytes = Math.max(0, process.memoryUsage().heapUsed - heapBeforeHistory)

const pack = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'])
const packInfo = JSON.parse(pack.stdout)[0]
const metrics = {
  buildMilliseconds: Math.round(build.elapsed * 100) / 100,
  testMilliseconds: Math.round(tests.elapsed * 100) / 100,
  historyP95Milliseconds: Math.round(historyP95Milliseconds * 1_000) / 1_000,
  pluginImportHeapBytes,
  historyRetainedHeapBytes,
  packagePackedBytes: packInfo.size,
  packageUnpackedBytes: packInfo.unpackedSize,
  packageFileCount: packInfo.entryCount,
  runtimeDependencyCount: Object.keys(pkg.dependencies ?? {}).length,
  peerDependencyCount: Object.keys(pkg.peerDependencies ?? {}).length,
}

const failures = []
for (const [name, limit] of Object.entries(budgets)) {
  if (metrics[name] > limit) {
    failures.push(`${name}: ${metrics[name]} exceeds ${limit}`)
  }
}

console.log(
  JSON.stringify({ metrics, budgets, status: failures.length ? 'failed' : 'passed' }, null, 2)
)
if (check && failures.length) {
  for (const failure of failures) {
    console.error(`Performance budget exceeded: ${failure}`)
  }
  process.exitCode = 1
}
