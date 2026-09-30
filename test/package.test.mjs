import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

describe('package', () => {
  it('ships the built extension the pi manifest points at', () => {
    for (const entry of pkg.pi.extensions) {
      const resolved = join(root, entry)
      assert.ok(existsSync(resolved), `missing built extension: ${entry}`)
      const source = readFileSync(resolved, 'utf8')
      assert.ok(source.length > 1000, `built extension looks empty: ${entry}`)
    }
  })

  it('keeps the install light (built output plus docs only)', () => {
    assert.deepEqual(pkg.files, ['dist', 'README.md'])
  })

  it('declares a Node engine range rather than an exact pin', () => {
    const range = pkg.engines?.node
    assert.ok(range, 'package.json must declare engines.node')
    // An exact pin makes `npm install` emit EBADENGINE on every Node release
    // other than that one, so `pi update npm:pi-autosuggestions` warned for
    // anyone not on 24.18.0 exactly (issue #66). Keep the tested floor, drop
    // the upper bound the way the pi packages themselves declare theirs.
    assert.doesNotMatch(
      range,
      /^\d+\.\d+\.\d+$/,
      `engines.node "${range}" is an exact version; use a range such as ">=24.18.0"`
    )
    assert.match(range, /^(>=|\^|~|>)/, `engines.node "${range}" has no lower bound`)
  })
})
