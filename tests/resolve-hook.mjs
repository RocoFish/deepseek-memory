/**
 * Resolution hook for pnpm's junction-linked package layout.
 *
 * `resolve` is called for every import. When the target is a `@deepseek-ai/*`
 * specifier that Node cannot resolve from the importing file, this falls back to
 * the copy installed at this repo's root `node_modules` or in the pnpm store.
 * That is deliberately narrow: it never changes which package version is used for
 * anything already resolvable, and it never touches a non-`@deepseek-ai`
 * specifier.
 *
 * See `register-hook.mjs` for the measured failure this works around. It affects
 * only tests that import the SDK; the plugin's own built output resolves nothing.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const rootModules = join(repoRoot, 'node_modules')
const pnpmStore = join(rootModules, '.pnpm')

/** Read a package's declared entry point, preferring its ESM export map. */
function entryOf(packageDir) {
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) return undefined
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const dot = manifest.exports?.['.']
  const fromExports = typeof dot === 'string'
    ? dot
    : dot?.import?.default ?? dot?.default?.default ?? dot?.default
  const relative = fromExports ?? manifest.module ?? manifest.main ?? 'index.js'
  const absolute = join(packageDir, relative)
  return existsSync(absolute) ? absolute : undefined
}

/** Locate one `@deepseek-ai/*` package at the repo root. */
function rootPackage(specifier) {
  const [scope, name, ...rest] = specifier.split('/')
  const packageDir = join(rootModules, scope, name)
  if (!existsSync(packageDir)) return undefined
  if (rest.length === 0) return entryOf(packageDir)
  // A subpath import: resolve it against the package's own export map when we can.
  const manifestPath = join(packageDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const key = `./${rest.join('/')}`
  const value = manifest.exports?.[key]
  const relative = typeof value === 'string' ? value : value?.default
  if (typeof relative !== 'string') return undefined
  const absolute = join(packageDir, relative)
  return existsSync(absolute) ? absolute : undefined
}

/**
 * Locate one `@deepseek-ai/*` package inside pnpm's content-addressed store.
 *
 * The layout is `.pnpm/@deepseek-ai+<name>@<version>/node_modules/@deepseek-ai/<name>`.
 * Only used when the root `node_modules` does not have it, and only for the
 * harness scope, so a real install always takes precedence.
 */
const storeCache = new Map()

function storePackage(specifier) {
  if (storeCache.has(specifier)) return storeCache.get(specifier)
  let found
  try {
    const [scope, name, ...rest] = specifier.split('/')
    const prefix = `${scope}+${name}@`
    const entries = readdirSync(pnpmStore, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
      const packageDir = join(pnpmStore, entry.name, 'node_modules', scope, name)
      if (!existsSync(packageDir)) continue
      if (rest.length === 0) {
        found = entryOf(packageDir)
      } else {
        const manifestPath = join(packageDir, 'package.json')
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        const value = manifest.exports?.[`./${rest.join('/')}`]
        const relative = typeof value === 'string' ? value : value?.default
        const absolute = typeof relative === 'string' ? join(packageDir, relative) : undefined
        found = absolute !== undefined && existsSync(absolute) ? absolute : undefined
      }
      if (found !== undefined) break
    }
  } catch {
    found = undefined
  }
  storeCache.set(specifier, found)
  return found
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (!specifier.startsWith('@deepseek-ai/')) throw error
    const fallback = rootPackage(specifier) ?? storePackage(specifier)
    if (fallback === undefined) throw error
    return { url: pathToFileURL(fallback).href, shortCircuit: true }
  }
}
