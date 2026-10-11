/**
 * Test-only module-resolution hook.
 *
 * Why this exists: pnpm links packages with junctions, so a package is entered at
 * `node_modules/<scope>/<name>/lib/index.js` rather than at its real path under
 * `.pnpm`. Node's ESM resolver then looks for that package's own dependencies
 * beside the *junction*, not beside the real directory, and does not find them —
 * even though pnpm did install them as siblings in the store.
 *
 * The measured symptom, on `@deepseek-ai/dsh-tools`:
 *
 *   ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
 *     imported from ...\node_modules\@deepseek-ai\dsh-tools\lib\index.js
 *
 * This is a linkage-layout problem, NOT an incomplete published dependency
 * closure: schemastery is present at
 * `.pnpm/@deepseek-ai+schemastery@3.18.4/node_modules/@deepseek-ai/schemastery`.
 *
 * The hook pins resolution for the SDK's internal `@deepseek-ai/*` imports to
 * whatever versions pnpm did install, so the real SDK code runs unmodified and
 * `tests/define.test.ts` can compare the vendored tool helper against the true
 * `defineTool`.
 *
 * It is registered with `--import` by `tests/run.ts` only, and only because that
 * suite imports the SDK. **The plugin itself needs no hook**: its built `lib/` is
 * self-contained, which is the whole point of `src/define.ts`.
 */
import { register } from 'node:module'

register(new URL('./resolve-hook.mjs', import.meta.url))
