import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { findHistoryCandidates } from '../dist/history.js'

describe('history suggestions', () => {
  it('returns extending matches newest first without duplicates', () => {
    const history = ['git status', 'git stash', 'git status', 'git switch main', 'npm test']

    assert.deepEqual(findHistoryCandidates(history, 'git s'), [
      'git switch main',
      'git status',
      'git stash',
    ])
  })

  it('matches only the first line and preserves the existing case-sensitive behavior', () => {
    const history = ['deploy staging\nwith additional instructions', 'Deploy production']

    assert.deepEqual(findHistoryCandidates(history, 'deploy'), ['deploy staging'])
    assert.deepEqual(findHistoryCandidates(history, 'Deploy'), ['Deploy production'])
  })

  it('does not suggest blank prefixes or exact matches', () => {
    const history = ['git status', 'git stash']

    assert.deepEqual(findHistoryCandidates(history, '   '), [])
    assert.deepEqual(findHistoryCandidates(history, 'git status'), [])
  })
})
