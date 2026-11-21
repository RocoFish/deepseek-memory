/**
 * Packaging invariants for the built output.
 *
 * These are not unit tests of plugin behaviour — they guard the one property that
 * decides whether a profile-installed plugin loads at all, and which is invisible
 * until someone installs it.
 *
 * The property: the emitted `lib/*.js` must contain **no bare specifier imports**.
 * A profile install puts this package in the profile's `node_modules`, and the
 * loader imports it by name from there. Bare `@deepseek-ai/*` specifiers then
 * resolve against the profile's own `node_modules`, which holds only the profile's
 * declared dependencies — no Harness SDK. A top-level bare import therefore does
 * not degrade; it fails the whole entry with `failed to import`, before a single
 * hook is registered.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const libDir = join(repoRoot, 'lib')

/** Every emitted JS file, or an empty list when the project has not been built. */
function builtFiles(): { name: string; source: string }[] {
  if (!existsSync(libDir)) return []
  return readdirSync(libDir)
    .filter(name => name.endsWith('.js'))
    .map(name => ({ name, source: readFileSync(join(libDir, name), 'utf8') }))
}

test('the built output has been produced', () => {
  const files = builtFiles()
  assert.ok(files.length > 0, 'lib/ is empty — run `npm run build` before this suite')
  assert.ok(existsSync(join(libDir, 'index.js')), 'lib/index.js must exist: it is the declared entry point')
  assert.ok(existsSync(join(libDir, 'index.d.ts')), 'lib/index.d.ts must exist: it is the declared types entry')
})

test('no built file imports a bare specifier at the top level', () => {
  const offenders = []
  for (const { name, source } of builtFiles()) {
    for (const match of source.matchAll(/^\s*(?:import|export)[^\n]*?from\s+'([^']+)'/gm)) {
      const specifier = match[1]!
      // Relative and absolute paths resolve inside the package; `node:` is a
      // builtin; everything else would need the host's module graph.
      if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) continue
      if (specifier.startsWith('node:')) continue
      offenders.push(`${name}: ${specifier}`)
    }
  }
  assert.deepEqual(offenders, [],
    'a profile-installed plugin cannot resolve bare specifiers; inline or defer them')
})

test('the built output carries no dynamic bare-specifier import at all', () => {
  // This used to allow guarded `import('@deepseek-ai/...')` calls. It no longer
  // does, because a guard is not a fix: on a real profile install the import
  // fails, so the guard turns "plugin will not load" into "feature silently
  // absent" — which is how the memory tools came to be missing from every tool
  // surface while the plugin reported healthy. The tool-definition helper and the
  // output-schema check are both local now (see `src/define.ts`).
  //
  // A dynamic import that starts resolving again is a regression, not a fallback.
  const dynamic = []
  for (const { name, source } of builtFiles()) {
    for (const match of source.matchAll(/import\('([^']+)'\)/g)) {
      const specifier = match[1]!
      if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('node:')) continue
      dynamic.push(`${name}: ${specifier}`)
    }
  }
  assert.deepEqual(dynamic, [],
    'the plugin must be self-contained: no built file may import a bare specifier, statically or dynamically')
})

test('the built entry exports the namespace-plugin shape and no default', async () => {
  // `import()` needs a URL, not a Windows path: a bare drive letter is read as a
  // URL scheme and rejected by the loader.
  const built = await import(pathToFileURL(join(libDir, 'index.js')).href)
  const keys = Object.keys(built).sort()
  assert.equal(typeof built.apply, 'function', `apply must be a function; exports were ${keys.join(', ')}`)
  assert.equal(typeof built.name, 'string')
  assert.ok(Array.isArray(built.inject))
  assert.equal(built.default, undefined,
    `the loader binds the namespace, so a default export is wrong here; exports were ${keys.join(', ')}`)
})


/** All files below `directory`, using POSIX separators for stable comparisons. */
function outputFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...outputFiles(path))
    else if (!entry.name.endsWith('.map')) files.push(relative(directory, path).replaceAll('\\', '/'))
  }
  return files.sort()
}

test('the committed lib matches a fresh build of src', () => {
  // The package entry is lib/index.js, including for direct git installs. A fix
  // that exists only in src therefore leaves the installed plugin vulnerable.
  // Build into a temporary directory so this check never masks drift by
  // rewriting the very output it is meant to verify.
  const freshDir = mkdtempSync(join(repoRoot, '.build-check-'))
  try {
    const result = spawnSync(process.execPath, [
      join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p', join(repoRoot, 'tsconfig.build.json'),
      '--outDir', freshDir,
    ], { cwd: repoRoot, encoding: 'utf8' })
    assert.equal(result.status, 0, `fresh build failed:\n${result.stdout}${result.stderr}`)

    const committedFiles = outputFiles(libDir)
    const freshFiles = outputFiles(freshDir)
    assert.deepEqual(committedFiles, freshFiles,
      'lib/ and a fresh src build contain different files; run `npm run build` and commit lib/')
    const drifted = freshFiles.filter(name =>
      readFileSync(join(libDir, name), 'utf8') !== readFileSync(join(freshDir, name), 'utf8'))
    assert.deepEqual(drifted, [],
      'committed lib/ is stale; run `npm run build` and commit the rebuilt output')
  } finally {
    rmSync(freshDir, { recursive: true, force: true })
  }
})
