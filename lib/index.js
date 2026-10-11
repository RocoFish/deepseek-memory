import { dirname, join } from 'node:path';
import { resolveConfig } from "./config.js";
import { consolidateTurn } from "./consolidate.js";
import { createMemoryUserMessage } from "./message.js";
import { MEMORY_SECTION, MEMORY_SECTION_ORDER, renderMemory } from "./prompt.js";
import { MemoryRuntime } from "./runtime.js";
import { MemoryError } from "./store.js";
import { createMemoryTools } from "./tools.js";
/** Environment variable naming the harness home that holds the user tier. */
const DSH_HOME = 'DSH_HOME';
/** Directory name of the harness home, used when deriving a home from the OS. */
const DSH_DIR_NAME = '.dsh';
/**
 * Plugin name, used for logs and for the injected source marker.
 */
export const name = 'memory';
/**
 * Services this plugin must be able to reach.
 *
 * See the module doc: an empty `inject` leaves the whole service registry
 * unreachable, which makes the plugin inert while looking healthy. Only the two
 * services it exists to use are named; `llm` and `subagents` stay optional and
 * are resolved at point of use so their absence degrades rather than disables.
 */
export const inject = ['tools', 'systemPrompt'];
/** The label shown as the tier heading in the injected prompt section. */
const TIER_LABELS = {
    project: 'Project memory (this repository)',
    user: 'User memory (standing personal facts)',
};
/** Pull plain text out of a message's content blocks, ignoring reasoning and non-text. */
function textBlocks(content) {
    if (!Array.isArray(content))
        return '';
    return content
        .map((block) => {
        if (block === null || typeof block !== 'object')
            return '';
        const typed = block;
        return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : '';
    })
        .filter(part => part !== '')
        .join('\n');
}
/** Read one session event's contribution to the turn capture. */
function eventText(event) {
    if (event === null || typeof event !== 'object')
        return undefined;
    const typed = event;
    const data = (typed.data ?? {});
    if (typed.type === 'user/message') {
        const text = textBlocks(data.content);
        return text === '' ? undefined : { role: 'user', text };
    }
    if (typed.type === 'assistant/message') {
        const text = textBlocks(data.message?.content);
        return text === '' ? undefined : { role: 'assistant', text };
    }
    return undefined;
}
/**
 * Learn the session's own model route from its logged request events.
 *
 * Reusing the session's route is the only defensible choice for the consolidator:
 * it is the model the user already selected for this conversation, it needs no
 * extra configuration, and it cannot silently call something they did not
 * choose. Two event types can carry it, and both are read because either may be
 * absent depending on how the request was assembled.
 */
function routeFromEvent(event) {
    if (event === null || typeof event !== 'object')
        return undefined;
    const typed = event;
    const data = typed.data;
    if (data === undefined)
        return undefined;
    if (typed.type === 'request/header') {
        const config = data['header']?.config;
        const provider = config?.['provider'];
        const model = config?.['model'];
        if (typeof provider === 'string' && typeof model === 'string')
            return { provider, model };
        return undefined;
    }
    if (typed.type === 'request/context') {
        const provider = data['provider'];
        const model = data['model'];
        if (typeof provider === 'string' && typeof model === 'string')
            return { provider, model };
        return undefined;
    }
    return undefined;
}
/**
 * Apply the plugin.
 * @param ctx - the plugin context.
 * @param rawConfig - configuration validated by {@link Config}.
 * @returns the disposer, called by the loader on unload.
 */
export function apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig);
    // Every login path goes through these, so a context whose service store throws
    // can never take the plugin — or the shell's plugin load — down with it.
    const safeGet = (key) => {
        try {
            return ctx.get(key);
        }
        catch (error) {
            console.warn(`[memory] could not read service "${key}": ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    };
    const log = (message) => {
        try {
            ctx.logger?.('memory').info(message);
        }
        catch { /* logging must never throw */ }
    };
    const warn = (message) => {
        try {
            ctx.logger?.('memory').warn(message);
        }
        catch {
            try {
                console.warn(`[memory] ${message}`);
            }
            catch { /* nothing left to do */ }
        }
    };
    /**
     * Run one registration step, containing its failure.
     *
     * A registry or event bus is free to reject a registration, and none of those
     * refusals should cost the plugin its other capabilities — or, worse, escape
     * into the shell's plugin load.
     */
    const register = (what, step) => {
        try {
            step();
        }
        catch (error) {
            warn(`${what} could not be registered: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    /**
     * The project directory, once a session has told us what it is.
     *
     * Read through a getter rather than captured at `apply` time: the session's own
     * recorded `cwd` is the authoritative value (see {@link resolveCwd}), and it
     * only becomes known when a session event arrives.
     */
    let projectDir = resolveCwd(safeGet);
    const homeResolution = resolveDshHome(safeGet);
    const runtime = new MemoryRuntime(config, homeResolution.home, () => projectDir);
    const turns = new Map();
    let disposed = false;
    const turnState = (sessionId) => {
        const existing = turns.get(sessionId);
        if (existing !== undefined)
            return existing;
        const created = { user: [], assistant: [], closedTurns: 0, lastRunAt: 0, running: false, route: undefined };
        turns.set(sessionId, created);
        return created;
    };
    /* ------------------------------------------------------------- injection */
    const systemPrompt = safeGet('systemPrompt');
    if (systemPrompt === undefined || systemPrompt === null) {
        warn('systemPrompt service is absent: memory will not be injected');
    }
    else {
        // `text` as a provider is the point: the section is recomputed at every
        // assembly, so a memory written a second ago is visible on the next request
        // and no stale copy accumulates in session history.
        register('prompt section', () => ctx.effect(() => systemPrompt.section({
            name: MEMORY_SECTION,
            order: MEMORY_SECTION_ORDER,
            interpolate: false,
            text: () => {
                if (disposed)
                    return '';
                try {
                    const views = runtime.stores().map(({ tier, store }) => ({
                        tier,
                        label: TIER_LABELS[tier],
                        entries: store.entries(),
                    }));
                    return renderMemory(views, config.injectChars).text;
                }
                catch (error) {
                    // A broken store must not break the request. The tools report the
                    // detail; the prompt just goes without memory this once.
                    warn(`memory injection skipped: ${error instanceof Error ? error.message : String(error)}`);
                    return '';
                }
            },
        }), 'deepseek-memory: prompt section'));
    }
    /* ----------------------------------------------------------------- tools */
    const tools = safeGet('tools');
    if (config.tools && (tools === undefined || tools === null)) {
        warn('tools service is absent: memory tools are not registered');
    }
    else if (config.tools && tools !== undefined && tools !== null) {
        // Registration is per tool and independently contained: a registry that
        // refuses one definition must not cost the plugin its other five. A failure
        // here also must not stop injection, which needs no tool registry.
        try {
            const definitions = createMemoryTools(runtime, {
                homeSource: homeResolution.source,
                home: homeResolution.home,
                projectDir: projectDir,
            });
            for (const definition of definitions) {
                register(`tool ${definition.name}`, () => ctx.effect(() => tools.register(definition), `deepseek-memory: tool ${definition.name}`));
            }
            log(`registered ${definitions.length} memory tool(s)`);
        }
        catch (error) {
            warn(`memory tools could not be prepared: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /* -------------------------------------------------------- turn lifecycle */
    register('session listener', () => ctx.on('session/event', (...args) => {
        if (disposed)
            return;
        const [session, event] = args;
        const sessionId = typeof session?.id === 'string' ? session.id : undefined;
        if (sessionId === undefined)
            return;
        // The session's own recorded project directory, which is the only source that
        // survives every way a host can be launched. See `resolveCwd`.
        const sessionCwd = readSessionCwd(session);
        if (sessionCwd !== undefined && sessionCwd !== projectDir) {
            log(`project memory tier now tracks ${sessionCwd}`);
            projectDir = sessionCwd;
        }
        const state = turnState(sessionId);
        const route = routeFromEvent(event);
        if (route !== undefined) {
            state.route = route;
            return;
        }
        const contribution = eventText(event);
        if (contribution === undefined)
            return;
        if (contribution.role === 'user') {
            // A new user message opens a turn: fold the previous turn's capture away
            // rather than letting it grow without bound.
            if (state.user.length > 0 && state.assistant.length > 0) {
                state.closedTurns += 1;
                state.user = [];
                state.assistant = [];
            }
            state.user.push(contribution.text);
        }
        else {
            state.assistant.push(contribution.text);
        }
    }));
    const llm = safeGet('llm');
    if (config.consolidation !== 'off' && (llm === undefined || llm === null)) {
        warn('llm service is absent: the fallback consolidation path is unavailable');
    }
    const subagents = safeGet('subagents');
    if (config.consolidation !== 'off' && subagents === undefined) {
        warn('subagents service is absent: consolidation falls back to a direct model request');
    }
    // `agent/status` -> idle is an emit, so this listener is never awaited: the
    // turn is already closed and the next one is not waiting on memory work.
    register('status listener', () => ctx.on('agent/status', (...args) => {
        if (disposed)
            return;
        const [payload] = args;
        const agent = payload?.agent;
        const sessionId = typeof agent?.id === 'string' ? agent.id : undefined;
        if (sessionId === undefined)
            return;
        const turn = turns.get(sessionId);
        if (turn === undefined || turn.running)
            return;
        if (turn.user.length === 0)
            return;
        if (turn.closedTurns < config.minTurnsBetweenRuns && turn.lastRunAt !== 0)
            return;
        const capture = { userTexts: [...turn.user], assistantTexts: [...turn.assistant] };
        turn.user = [];
        turn.assistant = [];
        turn.running = true;
        turn.lastRunAt = Date.now();
        void consolidateTurn({
            runtime,
            config,
            llm: llm ?? undefined,
            // An explicit pin wins; otherwise the session's own learned route is used,
            // so the direct path calls the model the user already chose here. The child
            // path needs no route at all: the child inherits the parent's.
            model: resolveModel(config, turn.route),
            toUserMessages: (texts) => texts.map(text => createMemoryUserMessage(text)),
            log,
            warn,
            // Present only when the deployment mounts a subagent provider; the
            // consolidator degrades to a direct model request without one.
            ...(agent === undefined ? {} : {
                child: {
                    subagents,
                    provider: config.consolidationSubagentProvider,
                    parent: agent,
                    timeoutMs: config.consolidationTimeoutMs,
                },
            }),
        }, capture)
            .then((outcome) => {
            if (outcome.ran)
                turn.closedTurns += 1;
        })
            .catch((error) => {
            warn(`consolidation crashed: ${error instanceof Error ? error.message : String(error)}`);
        })
            .finally(() => { turn.running = false; });
    }));
    log(`loaded (project=${runtime.enabledTiers().includes('project')}, user=${runtime.enabledTiers().includes('user')}, consolidation=${config.consolidation})`);
    return () => {
        disposed = true;
        turns.clear();
    };
}
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
export function resolveHomeFromEnv(env) {
    if (env === undefined)
        return { home: undefined, source: 'unset' };
    const fromEnv = env[DSH_HOME];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
        return { home: fromEnv, source: 'DSH_HOME' };
    }
    // The app publishes where its profile lives: `<home>/profiles/<name>`, so the
    // harness home is two levels up, not one.
    const profileDir = env['DSH_PROFILE_DIR'];
    if (typeof profileDir === 'string' && profileDir.trim() !== '') {
        const parent = dirname(dirname(profileDir));
        if (parent !== '' && parent !== profileDir)
            return { home: parent, source: 'DSH_PROFILE_DIR parent' };
    }
    const userProfile = env['USERPROFILE'];
    if (typeof userProfile === 'string' && userProfile.trim() !== '') {
        return { home: join(userProfile, DSH_DIR_NAME), source: 'USERPROFILE/.dsh' };
    }
    const drive = env['HOMEDRIVE'];
    const path = env['HOMEPATH'];
    if (typeof drive === 'string' && drive.trim() !== '' && typeof path === 'string' && path.trim() !== '') {
        return { home: join(`${drive}${path}`, DSH_DIR_NAME), source: 'HOMEDRIVE+HOMEPATH/.dsh' };
    }
    return { home: undefined, source: 'unset' };
}
/**
 * Resolve the harness home from an environment map and a service lookup.
 *
 * Pure, so both sources can be asserted directly. `resolveDshHome` is the
 * production wrapper that supplies the real ones.
 *
 * @param env - the environment to read, or undefined when there is none.
 * @param serviceHome - the `dshHome` service value, if the host publishes one.
 */
export function resolveHome(env, serviceHome) {
    const fromEnv = resolveHomeFromEnv(env);
    if (fromEnv.home !== undefined)
        return fromEnv;
    if (typeof serviceHome === 'string' && serviceHome.trim() !== '') {
        return { home: serviceHome, source: 'dshHome service' };
    }
    return { home: undefined, source: 'unset' };
}
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
export function resolveDshHome(safeGet) {
    const env = typeof process === 'undefined' ? undefined : process.env;
    return resolveHome(env, safeGet('dshHome'));
}
/**
 * Read the project directory the session itself records.
 *
 * This is the authoritative source, and it was measured on a live host rather
 * than assumed: the object passed to `session/event` carries a `header` with
 * `{ createdAt, cwd, id, isSeeded, version }`, so `header.cwd` is the session's
 * own validated absolute project directory — the same value the harness writes
 * into the session log.
 *
 * It is also the only source that is always right. `ctx.get('cwd')` is not a
 * service on any host measured (it returns `undefined` even with services
 * injected, so the lookup was dead code), and `process.cwd()` is a property of how
 * the host was *launched*, not of the project: the same installed application
 * produced `D:\WSL\DSH Workspace` on one launch and its own profile directory on
 * another. Trusting it silently wrote project memory into
 * `…\.dsh\profiles\desktop\.dsh-memory\`.
 */
function readSessionCwd(session) {
    if (session === null || typeof session !== 'object')
        return undefined;
    const header = session.header;
    if (header === null || typeof header !== 'object')
        return undefined;
    const cwd = header.cwd;
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined;
}
/**
 * The project directory the project tier lives under.
 *
 * Prefers nothing but the session's own record: {@link readSessionCwd} supplies it
 * once a session exists, and the getter reads it on demand. Only before the first
 * session event is `process.cwd()` consulted, and only because in a process that
 * boots per project it is momentarily the right answer.
 *
 * `undefined` disables the project tier entirely, on the same principle as the
 * user tier: a tier whose location cannot be established is a tier that stays off.
 * Writing memory into the wrong tree is worse than not having project memory —
 * the entries are then invisible where they are wanted and misleading where they
 * are found.
 */
function resolveCwd(safeGet) {
    const fromService = safeGet('cwd');
    if (typeof fromService === 'string' && fromService.trim() !== '')
        return fromService;
    return typeof process === 'undefined' ? undefined : process.cwd();
}
/**
 * Resolve the **direct fallback** path's model route.
 *
 * An explicit pin wins. Otherwise the session's own logged route is used, which is
 * the honest default: it is the model the user selected for this conversation.
 * When neither exists the fallback is skipped rather than guessing a provider — a
 * wrong guess would either fail on every turn or call a model the user did not
 * choose. The child path needs none of this: the child inherits the parent's.
 */
function resolveModel(config, sessionRoute) {
    if (config.consolidationRouteProvider !== undefined && config.consolidationRouteModel !== undefined) {
        return { provider: config.consolidationRouteProvider, model: config.consolidationRouteModel };
    }
    return sessionRoute;
}
export { MemoryError };
//# sourceMappingURL=index.js.map