/**
 * Shared test fixtures.
 *
 * The resolved configuration gains fields as the plugin grows, so tests read one
 * factory instead of each restating every key. That keeps a new option from
 * breaking unrelated suites and makes the values under test visible in one place.
 */
import type { MemoryConfig } from '../src/config.ts'

/**
 * A resolved configuration suitable for tests.
 * @param overrides - values to replace, merged shallowly.
 * @returns the resolved configuration.
 */
export function configFixture(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    user: true,
    project: true,
    maxEntries: 5,
    maxEntryChars: 200,
    injectChars: 1000,
    tools: true,
    consolidation: 'gated',
    minTurnsBetweenRuns: 1,
    keepHistory: true,
    consolidationSubagentProvider: 'in-process',
    consolidationRouteProvider: undefined,
    consolidationRouteModel: undefined,
    consolidationTimeoutMs: 5_000,
    ...overrides,
  }
}
