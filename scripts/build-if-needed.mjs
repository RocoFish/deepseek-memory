/**
 * Build only when the compiled output is missing.
 *
 * Why this exists instead of a plain `prepare: tsc`:
 *
 * - An npm install receives this package's published tarball, which already
 *   contains `lib/`. Nothing needs building, and pnpm asks nothing.
 * - A git install receives sources only, so `lib/` really is absent and the
 *   package would be unusable without a build. pnpm runs `prepare`-style scripts
 *   for git dependencies only after the user allowlists them — which is why the
 *   script does nothing when `lib/` is already there, so the allowlist is only
 *   ever needed by someone installing sources with no build output.
 *
 * Exits non-zero only when the build is needed AND fails, so a real problem is
 * not mistaken for "nothing to do".
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = join(root, 'lib', 'index.js')

if (existsSync(entry)) {
  console.log('lib/index.js is present; nothing to build')
  process.exit(0)
}

// The TypeScript compiler is a devDependency, so it is not on PATH: it lives at
// `node_modules/.bin/tsc` (POSIX) or `node_modules/.bin/tsc.cmd` (Windows). The
// entry script is resolved through `node` rather than executed, which works
// identically on both without a shell.
const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(compiler)) {
  console.error('lib/ is missing and TypeScript is not installed; run `npm install` in this package first')
  process.exit(1)
}

console.log('lib/ is missing; building from source')
const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })

if (result.error !== undefined && result.error !== null) {
  console.error(`could not run tsc: ${result.error.message}`)
  process.exit(1)
}
if (result.status === 0) console.log('built lib/ from source')
process.exit(result.status ?? 1)
