import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseNpmPackMetrics } from '../scripts/npm-pack.mjs'

/**
 * Raw JSON fixtures: JSON.stringify maps Infinity/NaN to null, so the
 * malformed values these regressions need (1e999, quoted numbers, negatives)
 * have to be written as raw JSON text.
 */
const defaults = { size: '100', unpackedSize: '200', entryCount: '3' }

function reportBody(overrides = {}) {
  const values = { ...defaults, ...overrides }
  return Object.entries(values)
    .map(([field, raw]) => (raw === undefined ? null : `"${field}":${raw}`))
    .filter(Boolean)
    .join(',')
}

const legacyArray = (body) => `[{${body}}]`
const keyedObject = (body) => `{"pi-autosuggestions":{${body}}}`
const bothShapes = (body) => [legacyArray(body), keyedObject(body)]
const valid = reportBody()

describe('npm pack JSON parsing', () => {
  it('reads metrics from the legacy npm array shape', () => {
    assert.deepEqual(parseNpmPackMetrics(legacyArray(valid)), {
      size: 100,
      unpackedSize: 200,
      entryCount: 3,
    })
  })

  it('reads metrics from the npm 12 keyed-object shape', () => {
    assert.deepEqual(parseNpmPackMetrics(keyedObject(valid)), {
      size: 100,
      unpackedSize: 200,
      entryCount: 3,
    })
  })

  it('accepts zero metrics', () => {
    const zero = reportBody({ size: '0', unpackedSize: '0', entryCount: '0' })
    for (const fixture of bothShapes(zero)) {
      assert.deepEqual(parseNpmPackMetrics(fixture), { size: 0, unpackedSize: 0, entryCount: 0 })
    }
  })

  it('rejects output that is not valid JSON', () => {
    for (const fixture of ['', 'npm notice something', '{"size":']) {
      assert.throws(() => parseNpmPackMetrics(fixture), /did not output valid JSON/)
    }
  })

  it('rejects JSON that is not a report collection', () => {
    for (const fixture of ['null', 'true', '"pack"', '42']) {
      assert.throws(
        () => parseNpmPackMetrics(fixture),
        /legacy report array or an npm 12 keyed report object/
      )
    }
  })

  it('rejects a collection that is not exactly one report', () => {
    const fixtures = [
      '[]',
      '{}',
      '{"a":{"size":1},"b":{"size":2}}',
      `[${legacyArray(valid)},${legacyArray(valid)}]`,
    ]
    for (const fixture of fixtures) {
      assert.throws(() => parseNpmPackMetrics(fixture), /exactly one pack report/)
    }
  })

  it('rejects a report that is not an object', () => {
    const fixtures = ['["not-an-object"]', '{"pi-autosuggestions":"not-an-object"}']
    for (const fixture of fixtures) {
      assert.throws(() => parseNpmPackMetrics(fixture), /pack report must be an object/)
    }
  })

  for (const field of ['size', 'unpackedSize', 'entryCount']) {
    it(`fails closed when ${field} is missing`, () => {
      for (const fixture of bothShapes(reportBody({ [field]: undefined }))) {
        assert.throws(() => parseNpmPackMetrics(fixture), new RegExp(`missing ${field}`))
      }
    })

    it(`fails closed when ${field} has the wrong type`, () => {
      for (const raw of ['"100"', 'null', 'true']) {
        for (const fixture of bothShapes(reportBody({ [field]: raw }))) {
          assert.throws(() => parseNpmPackMetrics(fixture), new RegExp(`${field} must be a number`))
        }
      }
    })

    it(`fails closed when ${field} is not finite`, () => {
      for (const fixture of bothShapes(reportBody({ [field]: '1e999' }))) {
        assert.throws(() => parseNpmPackMetrics(fixture), new RegExp(`${field} must be finite`))
      }
    })

    it(`fails closed when ${field} is negative`, () => {
      for (const fixture of bothShapes(reportBody({ [field]: '-1' }))) {
        assert.throws(
          () => parseNpmPackMetrics(fixture),
          new RegExp(`${field} must be non-negative`)
        )
      }
    })
  }
})
