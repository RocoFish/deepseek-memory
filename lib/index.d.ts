/**
 * Plugin entry point.
 *
 * Shape follows the harness convention for a namespace plugin: named `name`,
 * `inject`, and `apply` exports, no default export.
 *
 * ## `inject` is not an optional-dependency declaration
 *
 * `inject` is what makes the Cordis service registry reachable from this
 * context. With an empty list the plugin still loads and `apply` still runs — but
 * `ctx.get(name)` returns `undefined` for *every* service, and reading one as a
 * property throws `cannot get property "tools" without inject`. A plugin in that
 * state looks perfectly healthy (the plugin manager reports it running) while
 * doing nothing at all, because every guarded lookup takes its "service absent"
 * path.
 *
 * That is exactly what an empty `inject` cost this plugin: the prompt section was
 * never registered and no tool was ever registered, silently, in every
 * deployment. Measured on a real harness with a probe plugin:
 *
 * | `inject` | `ctx.get('tools')` |
 * |---|---|
 * | `[]` | `undefined` |
 * | `['tools', 'systemPrompt']` | the registry, with `register` callable |
 *
 * So the two services this plugin exists to use are injected. Everything else is
 * genuinely optional and is still resolved at point of use, because a service
 * absent from a deployment must degrade the plugin rather than prevent it from
 * starting:
 *
 * | service | absent |
 * |---|---|
 * | `llm` | no after-turn consolidation; injection and tools still work |
 * | `subagents` | consolidation falls back to a direct model request |
 *
 * @module deepseek-memory
 */
import type { Context } from '@deepseek-ai/cordis';
import { MemoryError } from './store.ts';
/**
 * Plugin name, used for logs and for the injected source marker.
 */
export declare const name = "memory";
/**
 * Services this plugin must be able to reach.
 *
 * See the module doc: an empty `inject` leaves the whole service registry
 * unreachable, which makes the plugin inert while looking healthy. Only the two
 * services it exists to use are named; `llm` and `subagents` stay optional and
 * are resolved at point of use so their absence degrades rather than disables.
 */
export declare const inject: string[];
/**
 * Apply the plugin.
 * @param ctx - the plugin context.
 * @param rawConfig - configuration validated by {@link Config}.
 * @returns the disposer, called by the loader on unload.
 */
export declare function apply(ctx: Context, rawConfig?: unknown): () => void;
/**
 * Where the harness home came from, for the load log and `memory_status`.
 *
 * Reported rather than silent because the tier's availability is otherwise
 * invisible: a disabled user tier looks exactly like an empty one, and on the
 * packaged desktop app that is precisely what happened.
 */
export type HomeSource = 'DSH_HOME' | 'dshHome service' | 'DSH_PROFILE_DIR parent' | 'USERPROFILE/.dsh' | 'HOMEDRIVE+HOMEPATH/.dsh' | 'unset';
/**
 * The environment lookup the home resolver performs, as a pure function of an
 * environment map.
 *
 * Split out from {@link resolveDshHome} so it can be tested without mutating
 * `process.env`: the test runner executes files concurrently in one process, and a
 * test that edits global state can be observed by an unrelated file mid-flight.
 * That is exactly what happened here, so the seam is deliberate.
 *
 * @param env - the environment to read, or undefined when there is none.
 * @returns the home and which candidate supplied it; `unset` when nothing did.
 */
export declare function resolveHomeFromEnv(env: Readonly<Record<string, string | undefined>> | undefined): {
    home: string | undefined;
    source: HomeSource;
};
/**
 * Resolve the harness home from an environment map and a service lookup.
 *
 * Pure, so both sources can be asserted directly. `resolveDshHome` is the
 * production wrapper that supplies the real ones.
 *
 * @param env - the environment to read, or undefined when there is none.
 * @param serviceHome - the `dshHome` service value, if the host publishes one.
 */
export declare function resolveHome(env: Readonly<Record<string, string | undefined>> | undefined, serviceHome: string | undefined): {
    home: string | undefined;
    source: HomeSource;
};
/**
 * Read the harness home the user tier lives under.
 *
 * The candidates are ordered by how directly each names the harness home, and the
 * one actually used is reported so a deployment can see why a tier is on or off.
 *
 * `undefined` disables the user tier. It deliberately does **not** fall back to
 * the process working directory: that would scatter standing personal facts into
 * whatever directory the host happened to start in, and inside a plugin's own
 * repository it could commit them. A tier with no established home is a tier that
 * stays off.
 *
 * The later candidates exist because the desktop app's host process does not carry
 * `DSH_HOME` — measured: the tool reported the user tier as absent while a
 * sandboxed shell spawned from the same application had the variable set, so it is
 * injected into shells rather than present at the host's own startup. `USERPROFILE`
 * is the standard Windows home and `.dsh` is the harness's documented directory
 * name, so the derived path matches an unmodified installation.
 */
export declare function resolveDshHome(safeGet: <T>(key: string) => T | undefined): {
    home: string | undefined;
    source: HomeSource;
};
export { MemoryError };
//# sourceMappingURL=index.d.ts.map