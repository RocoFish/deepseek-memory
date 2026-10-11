/**
 * How the harness home is located.
 *
 * The user tier is only as good as this resolution, and its failure mode is
 * invisible: a tier with no home is simply off, which reads exactly like a tier
 * with no memories yet. That is how it shipped broken — the desktop app's host
 * process carries no `DSH_HOME`, while a shell spawned from the same application
 * does, so the tier was silently absent in the GUI for the whole project.
 *
 * These tests call the resolver with an explicit environment map and never touch
 * `process.env`. The test runner executes files concurrently in one process, and
 * another file here does set `DSH_HOME`; mutating global state from a test is how
 * a passing case turns into a flake.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveHome, resolveHomeFromEnv } from '../src/index.ts'

test('DSH_HOME wins over every derived candidate', () => {
  assert.deepEqual(
    resolveHomeFromEnv({
      DSH_HOME: 'X:\\explicit-home',
      DSH_PROFILE_DIR: 'X:\\profiles\\desktop',
      USERPROFILE: 'X:\\Users\\someone',
    }),
    { home: 'X:\\explicit-home', source: 'DSH_HOME' },
  )
})

test('a blank DSH_HOME is treated as unset, not as an empty home', () => {
  // An empty string would otherwise make `join('', 'memory')` a path relative to
  // the process working directory — the exact scattering the tier exists to avoid.
  assert.deepEqual(
    resolveHomeFromEnv({ DSH_HOME: '   ', USERPROFILE: 'X:\\Users\\someone' }),
    { home: 'X:\\Users\\someone\\.dsh', source: 'USERPROFILE/.dsh' },
  )
})

test('the profile directory supplies the home when DSH_HOME is absent', () => {
  // The desktop host knows where its profile lives; the harness home is its parent.
  assert.deepEqual(
    resolveHomeFromEnv({
      DSH_PROFILE_DIR: 'X:\\home\\.dsh\\profiles\\desktop',
      USERPROFILE: 'X:\\Users\\someone',
    }),
    { home: 'X:\\home\\.dsh', source: 'DSH_PROFILE_DIR parent' },
  )
})

test('USERPROFILE supplies the standard Windows home directory', () => {
  assert.deepEqual(
    resolveHomeFromEnv({ USERPROFILE: 'X:\\Users\\someone', HOMEDRIVE: 'X:', HOMEPATH: '\\ignored' }),
    { home: 'X:\\Users\\someone\\.dsh', source: 'USERPROFILE/.dsh' },
  )
})

test('HOMEDRIVE plus HOMEPATH is the last environment resort', () => {
  assert.deepEqual(
    resolveHomeFromEnv({ HOMEDRIVE: 'X:', HOMEPATH: '\\Users\\someone' }),
    { home: 'X:\\Users\\someone\\.dsh', source: 'HOMEDRIVE+HOMEPATH/.dsh' },
  )
})

test('with nothing in the environment the resolver reports unset, not a guess', () => {
  // The one outcome that must never happen is a guess: the user tier holds
  // standing personal facts, and writing them relative to an arbitrary working
  // directory is worse than not storing them.
  assert.deepEqual(resolveHomeFromEnv({}), { home: undefined, source: 'unset' })
  assert.deepEqual(resolveHomeFromEnv(undefined), { home: undefined, source: 'unset' })
})

test('a published dshHome service is the final fallback', () => {
  // The service can only win when the environment offers nothing, so this asserts
  // both halves: it is used as a last resort, and it never overrides the
  // environment.
  assert.deepEqual(
    resolveHome({}, 'X:\\service-home'),
    { home: 'X:\\service-home', source: 'dshHome service' },
  )
  assert.deepEqual(
    resolveHome({ DSH_HOME: 'X:\\from-env' }, 'X:\\service-home'),
    { home: 'X:\\from-env', source: 'DSH_HOME' },
  )
  // A blank service value is unset, not an empty home.
  assert.deepEqual(resolveHome({}, '  '), { home: undefined, source: 'unset' })
})
