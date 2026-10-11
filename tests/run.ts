/**
 * In-process test entry point.
 *
 * `npm test` uses `node --test`, which is the right thing on a normal machine:
 * one child process per file, isolation, and the standard reporter. But a
 * restricted sandbox may deny the `spawn` that mode needs, so this file drives
 * the same `node:test` cases inside the current process instead. Both paths run
 * exactly the same assertions.
 *
 * Usage: node tests/run.ts
 */
import { run } from 'node:test'
import { spec } from 'node:test/reporters'

import './store.test.ts'
import './gate.test.ts'
import './prompt.test.ts'
import './runtime.test.ts'
import './consolidate.test.ts'
import './subagent.test.ts'
import './wiring.test.ts'
// Compares the vendored tool helper against the real SDK one; needs the
// resolution hook, so it is most meaningful under `npm run test:sandbox`.
import './define.test.ts'
// How the harness home is located, which decides whether the user tier exists.
import './home.test.ts'
// Last, because it asserts on the built `lib/` output rather than on sources.
import './packaging.test.ts'

let failed = 0
const stream = run({ files: [], concurrency: 1 })
stream.on('test:fail', () => { failed += 1 })
stream.compose(spec).pipe(process.stdout)
stream.on('end', () => {
  process.exitCode = failed === 0 ? 0 : 1
})
