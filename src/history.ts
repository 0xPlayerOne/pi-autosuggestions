/**
 * Return unique, single-line history entries that extend `typed`, newest first.
 *
 * Keeping this strategy separate from the editor makes its behavior directly
 * testable and gives the performance harness the exact production code path.
 */
export function findHistoryCandidates(history: readonly string[], typed: string): string[] {
  if (!typed.trim()) {
    return []
  }

  const matches: string[] = []
  const seen = new Set<string>()
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i] ?? ''
    const newline = entry.indexOf('\n')
    const firstLine = newline === -1 ? entry : entry.slice(0, newline)
    if (firstLine.length > typed.length && firstLine.startsWith(typed) && !seen.has(firstLine)) {
      seen.add(firstLine)
      matches.push(firstLine)
    }
  }
  return matches
}
