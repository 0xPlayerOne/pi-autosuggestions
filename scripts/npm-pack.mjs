/**
 * Strict parser for `npm pack --json` output.
 *
 * npm through 11 prints a legacy JSON array of pack reports; npm 12 switched
 * to a keyed object whose single value is the pack report. The performance
 * budgets consume `size`, `unpackedSize`, and `entryCount`, so anything that
 * is not exactly one well-formed record fails closed instead of silently
 * feeding `undefined` or `NaN` into the budget comparison.
 */

const NUMERIC_FIELDS = ['size', 'unpackedSize', 'entryCount']

/** @param {string} stdout */
function parseJson(stdout) {
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`npm pack --json did not output valid JSON: ${error.message}`, {
      cause: error,
    })
  }
}

/** @param {unknown} parsed */
function selectReport(parsed) {
  // Legacy npm: an array of pack reports. npm 12: an object keyed by package.
  const reports = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.values(parsed)
      : null
  if (reports === null)
    throw new Error(
      'npm pack --json must be a legacy report array or an npm 12 keyed report object'
    )
  if (reports.length !== 1)
    throw new Error(`npm pack --json must contain exactly one pack report, found ${reports.length}`)
  const report = reports[0]
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new Error('npm pack --json pack report must be an object')
  return /** @type {Record<string, unknown>} */ (report)
}

/**
 * Parse `npm pack --json` stdout into the numeric metrics the performance
 * budgets consume. Accepts the legacy npm array and the npm 12 keyed object;
 * rejects every other shape and every missing, non-numeric, non-finite, or
 * negative metric.
 *
 * @param {string} stdout
 * @returns {{ size: number, unpackedSize: number, entryCount: number }}
 */
export function parseNpmPackMetrics(stdout) {
  const report = selectReport(parseJson(String(stdout)))
  /** @type {Record<string, number>} */
  const metrics = {}
  for (const field of NUMERIC_FIELDS) {
    const value = report[field]
    if (value === undefined) throw new Error(`npm pack --json pack report is missing ${field}`)
    if (typeof value !== 'number')
      throw new Error(
        `npm pack --json pack report ${field} must be a number, received ${typeof value}`
      )
    if (!Number.isFinite(value))
      throw new Error(`npm pack --json pack report ${field} must be finite`)
    if (value < 0) throw new Error(`npm pack --json pack report ${field} must be non-negative`)
    metrics[field] = value
  }
  return { size: metrics.size, unpackedSize: metrics.unpackedSize, entryCount: metrics.entryCount }
}
