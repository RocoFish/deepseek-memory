/**
 * Configuration hardening tests.
 *
 * Resource-shaped options must be bounded above as well as below: a config
 * typo must not be able to turn one store or one request into an unbounded
 * sink. Values below the floor fall back; values above the ceiling clamp.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.ts'

test('resource-shaped options clamp to their hard ceilings', () => {
  const config = resolveConfig({
    maxEntries: 100_000,
    maxEntryChars: 1_000_000,
    injectChars: 10_000_000,
    minTurnsBetweenRuns: 10_000,
    consolidationTimeoutMs: 3_600_000,
  })
  assert.equal(config.maxEntries, 500)
  assert.equal(config.maxEntryChars, 2_000)
  assert.equal(config.injectChars, 50_000)
  assert.equal(config.minTurnsBetweenRuns, 100)
  assert.equal(config.consolidationTimeoutMs, 600_000)
})

test('values below the floor still fall back to the defaults', () => {
  const config = resolveConfig({ maxEntries: 0, maxEntryChars: 2, consolidationTimeoutMs: 10 })
  assert.equal(config.maxEntries, 50)
  assert.equal(config.maxEntryChars, 500)
  assert.equal(config.consolidationTimeoutMs, 120_000)
})

test('non-numeric junk is ignored as before', () => {
  const config = resolveConfig({ maxEntries: 'lots', injectChars: Number.POSITIVE_INFINITY })
  assert.equal(config.maxEntries, 50)
  assert.equal(config.injectChars, 4_000)
})
