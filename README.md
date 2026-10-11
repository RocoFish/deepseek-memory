# deepseek-memory

English | [中文](README.zh.md)

Curated long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
packaged as an installable community bundle.

Memory here means **small and curated**, not a transcript index: the store holds a
bounded set of short facts about the user and the project, and the whole store is
injected into every request. That bound is what removes the retrieval problem —
no embedding service, no ranking, and no stale snapshot left behind in session
history.

## What it does

| Piece | Behaviour |
| --- | --- |
| **Two tiers** | `user` (`$DSH_HOME/memory/`) for who the person is; `project` (`<cwd>/.dsh-memory/`) for this repository's conventions and decisions. |
| **Tools** | `memory_add`, `memory_update`, `memory_delete`, `memory_list`, `memory_search`, `memory_status`. |
| **Injection** | A `systemPrompt` section whose text is a *provider*, so it is recomputed at every assembly. Nothing is written into session history. |
| **After-turn consolidation** | A restricted child agent reviews the closed turn through the memory tools alone. |
| **Plain files** | The store is readable JSON, hand-editable, diffable in git, and every mutation keeps the previous revision. |

## Install

```sh
dsh plugin --profile <name> add deepseek-memory
```

From a git host, the same one-liner:

```sh
dsh plugin --profile <name> add github:<you>/deepseek-memory
```

There is no build step and no allowlist for you to deal with, because this
repository **commits the compiled `lib/`** — a git install receives exactly what an
npm install does. That is a deliberate trade: build output in version control is
unusual, and it costs the maintainer a rebuild before each push, weighed against
every user having to read a pnpm build-script error and hand-edit
`pnpm-workspace.yaml` first. For a plugin meant to be installed by strangers, the
install has to be one command.

Which means **there is deliberately no `prepare` script.** pnpm decides whether a
git dependency's build scripts need allowlisting by looking for that entry in
`package.json` — before running it, and regardless of what it contains. A
conditional `prepare` that exits immediately when `lib/` is present therefore still
demands the allowlist, which was measured rather than assumed. Committing `lib/` and
dropping the entry is what actually removes the step; `prepublishOnly` still builds
for npm, where no consumer is affected.

Contributors cloning the repository get no `lib/` (or can delete it) and build with
`npm install && npm run build`.

Restart the profile afterwards.

### Community listing

DSH's community plugin index is the GitHub topic
[`dsh-plugin`](https://github.com/topics/dsh-plugin) — "the `dsh-plugin` topic gathers
third-party plugins that extend it". Set that topic on the repository and it appears
in the index; the npm `keywords` list `dsh-plugin` too, so both routes lead back here.

## Configuration

Every key can be overridden in a profile's `cordis.patch.yml` by targeting the
`memory` row:

```yaml
- id: memory
  config:
    maxEntries: 80
    consolidation: always
```

| Key | Default | Meaning |
| --- | --- | --- |
| `user` | `true` | Enable the user-level tier. |
| `project` | `true` | Enable the project-level tier. |
| `maxEntries` | `50` | Maximum entries per tier. |
| `maxEntryChars` | `500` | Maximum characters per entry. |
| `injectChars` | `4000` | Maximum characters of memory injected into one request. |
| `tools` | `true` | Register the memory tools. |
| `consolidation` | `gated` | `off`, `gated`, or `always`. |
| `minTurnsBetweenRuns` | `1` | Minimum closed turns between consolidator runs in one session. |
| `keepHistory` | `true` | Keep the previous revision of each store in `history/`. |
| `consolidationSubagentProvider` | `in-process` | Registered subagent provider the consolidator **child** runs on. A provider *name*, not a model route. |
| `consolidationRouteProvider` | — | Provider route for the **fallback** path, used only when no subagent provider is mounted. Omit to reuse the session's own logged route. |
| `consolidationRouteModel` | — | Model id paired with `consolidationRouteProvider`. |
| `consolidationTimeoutMs` | `120000` | Wall-clock cap for one consolidation run. |

## How consolidation works

Paying a model call after every turn is wasteful, because most turns contain
nothing durable. The gate is a local, deterministic scan for the situations that
actually change long-term memory: an explicit request to remember, a correction, a
standing preference, a decision, or a constraint. It is biased toward
**under**-triggering on purpose — a missed consolidation is repaired by the next
related turn, whereas an eager consolidator eventually starts inventing memories.
Set `consolidation: always` if you want the faithful behaviour instead.

When the gate fires, consolidation runs as a **restricted child agent**:

- `toolFilter: { allow: [memory_*] }` removes every other tool from the child's
  prompt *and* refuses them at execution, so it cannot read or write the repository
  however the transcript talks to it;
- `persona` gives it a consolidation-only brief that shadows the deployment persona
  for that child alone;
- `outputSchema` makes it return a structured receipt;
- it starts with no parent history, so consolidation never inflates the main
  conversation's context.

The child writes memory through **this plugin's own tools**, so every ceiling and
every teaching error still applies. That is also why the plugin does not trust the
child's self-report: it compares **store revisions** across the run and treats a
claimed-but-absent change as a failure.

Without a mounted subagent provider the plugin falls back to a direct model
request that returns a JSON change set, which the plugin validates action by action,
bounds per run, and applies atomically per tier. The child path is strictly better;
the fallback exists so a deployment without subagents still consolidates.

## Storage format

```json
{
  "format": 1,
  "tier": "project",
  "revision": 3,
  "updatedAt": 1790000000000,
  "entries": [
    {
      "id": "m1a2b3c4",
      "text": "The build uses tsc, not a bundler.",
      "tags": ["build"],
      "createdAt": 1789990000000,
      "updatedAt": 1790000000000,
      "origin": "consolidator"
    }
  ]
}
```

The id is derived from the entry text, so adding the same fact twice is a no-op and
a rewritten entry keeps its identity. A file whose `format` is newer than the
running build is refused rather than guessed at.

The project tier is meant to be committed by the *user* in *their* repository, so
`.dsh-memory/` is a sensible addition to a project's `.gitignore` if they would
rather not share it.

## Design notes

Four constraints shaped this implementation and are worth knowing before changing
it.

**1. `inject` is not an optional-dependency declaration — it is what makes the
service registry reachable.** This shipped broken once, so it is first. A Cordis
plugin with `inject: []` still loads and `apply` still runs, but `ctx.get(name)`
returns `undefined` for **every** service, and reading one as a property throws
`cannot get property "tools" without inject`. A plugin in that state reports as
running in the plugin manager while doing nothing at all, because each guarded
lookup takes its "service absent" branch. Measured on a real harness with a probe
plugin:

| `inject` | `ctx.get('tools')` |
| --- | --- |
| `[]` | `undefined` |
| `['tools', 'systemPrompt']` | the registry, with `register` callable |

This plugin injects the two services it exists to use. `llm` and `subagents` stay
out of `inject` on purpose: they are genuinely optional, and naming one would make
its absence disable the plugin instead of degrading it. They are resolved at point
of use.

Two consequences worth internalising: a test that hands services to `apply` through
a hand-built `ctx` **cannot** catch this class of bug, because it bypasses `inject`
entirely — the export itself has to be asserted (see `tests/wiring.test.ts`); and
the symptom is not an error, it is silence.

**2. There is no catch-all `plugin` message source.** `MessageSourceMap` is a
merge-extensible sum type; each producer declares its own `kind` in its own module.
Writing `{ kind: 'plugin', plugin: 'x' }` — the shape older releases accepted, and
one still found throughout the harness's own fixtures — does not typecheck against
0.2 and triggers `format v4 message requires a producer-owned source kind` at the
log boundary on versions that enforce it. This plugin declares its own kind in
[`src/source.ts`](src/source.ts). Injection deliberately does not use message
injection at all: a `systemPrompt` provider cannot leave a stale copy in history.

**3. The turn boundary is `agent/status` → `idle`, not `agent/turn-stopping`.**
The latter is a serial, awaited listener; consolidating there would add model
latency to every turn. `agent/status` is an `emit`, so memory work starts after the
turn has already closed and nothing waits on it.
**4. The plugin is self-contained at runtime, so the SDK stays a type-only
dependency.** `defineTool`, parameter compilation, argument validation,
`createUserMessage`, and the output-schema check are all implemented in this package
rather than imported. The SDK packages are still declared — as `peerDependencies`
for version agreement and `devDependencies` for the types and for the equivalence
suite — but nothing in `lib/` imports one, which is what makes a profile install work
at all. See "The built output is self-contained" below.

**5. `ctx.get` reads once, at `apply` time.** Not a constraint to design around so
much as one to remember: the resolvers read their services once, so every service the
plugin needs must be listed in `inject` and cannot be discovered later.

### Where the two tiers get their location

The **project tier** takes the session's own recorded directory: the `session/event`
payload carries a `header` with a validated absolute `cwd`, and that is the only
source that is always right. Resolved through a getter, so a host that switches
projects without restarting the plugin follows along and drops the stale cache;
nothing is cached at `apply` time.

Two measured facts make this the only defensible choice. `ctx.get('cwd')` is not a
service on any host tried — it returns `undefined` even with services injected, so
that lookup was dead code from the start. And `process.cwd()` describes how the host
was *launched*, not which project is open: the same packaged application yielded
`D:\WSL\DSH Workspace` on one launch and its own profile directory on another.
Trusting it silently wrote project memory into the application's own config
directory, where it was invisible in the project and misleading anywhere else.

The **user tier** resolves in this order, and the source used is reported by
`memory_status`:

| order | source | why |
| --- | --- | --- |
| 1 | `DSH_HOME` | names the harness home directly |
| 2 | `DSH_PROFILE_DIR` minus two levels | the app publishes `<home>/profiles/<name>`, so the home is two levels up |
| 3 | `USERPROFILE` + `.dsh` | the standard Windows home and the harness's own directory name |
| 4 | `HOMEDRIVE` + `HOMEPATH` + `.dsh` | the fallback for shells that split the path |
| 5 | a `dshHome` service | hosts that publish it as a service instead |
| — | otherwise **disabled** | never the working directory |

Tiers 2–5 exist because the desktop app's host process does not carry `DSH_HOME`:
a sandboxed shell spawned from the same application had the variable while the host's
own startup did not, so the tool reported the tier absent in the GUI. Falling back to
the working directory is still refused — that would scatter standing personal facts
into whatever directory the host happened to start in, including a plugin's own
checkout, where they could be committed.

Both tiers follow the same principle: a tier whose location cannot be established
stays **off**, and says so. `memory_status` reports a disabled tier explicitly rather
than omitting it, because an absent tier and an empty tier otherwise read identically.

### Structural interfaces, checked at compile time

The plugin declares narrow structural interfaces for the two services it reaches
through `ctx` (`SubagentConsolidator`, and the tools registry shape) instead of
importing the SDK's service classes. That keeps the plugin adaptable to the
deployment's actual versions.

A structural interface can drift from the real one, so
[`src/typecheck.ts`](src/typecheck.ts) asserts that the published `SubagentRuntime`
satisfies the plugin's interface. That check has already caught two real errors: a
`readonly ContentBlock[]` where the SDK requires a mutable array, and an
`outputSchema` typed too loosely to be assigned.

### The built output is self-contained: no bare imports at all

This is the packaging rule that decides whether a profile install works at all, and
it is invisible until someone actually installs the plugin. It cost two rounds of
debugging to get right, so the full chain is recorded here.

`dsh plugin add` puts this package in the profile's `node_modules`, and the loader
imports it by name from there. Bare `@deepseek-ai/*` specifiers then resolve against
the **profile's** `node_modules`, which holds only the profile's declared
dependencies — the Harness SDK lives in the installation, not there. Measured on the
`desktop` profile: `node_modules/@deepseek-ai` does not exist. A top-level bare
import therefore does not degrade, it fails the whole entry with `failed to import`,
before a single hook is registered.

So SDK imports are **type-only** wherever possible, and every genuine runtime need is
implemented locally:

| Need | Handling |
| --- | --- |
| `createUserMessage` | Reproduced in [`src/message.ts`](src/message.ts), its contract checked against the SDK's own types in `typecheck.ts`. |
| `defineTool` (+ parameter compilation, argument validation) | Implemented in [`src/define.ts`](src/define.ts). |
| `assertObjectJsonSchema` | Implemented in [`src/define.ts`](src/define.ts) as a structural self-consistency check. |

**Guarded dynamic `import()` is not a fix, and this repo no longer uses it.** It
looks like graceful degradation, but on the target install the import always fails,
so the "fallback" is the permanent path — the feature is silently missing while the
plugin reports healthy. That is exactly how the memory tools came to be absent from
every tool surface.

The dynamic import also failed for a second, subtler reason worth knowing: pnpm links
packages with **junctions**, so `dsh-tools` is entered at
`node_modules\@deepseek-ai\dsh-tools\lib\index.js` rather than at its real store
path, and its own `import '@deepseek-ai/schemastery'` does not resolve from there —
even though schemastery *is* installed as a sibling link in the pnpm store:

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
  imported from ...\deepseek-memory\node_modules\@deepseek-ai\dsh-tools\lib\index.js
```

This is a linkage-layout problem, **not** an incomplete published dependency closure.

The one risk this creates is drift from the harness, so it is held down two ways:
`tests/define.test.ts` compiles the same options through the real SDK `defineTool` and
asserts deep equality **including key order**; `src/typecheck.ts` asserts the local
definitions stay assignable to the SDK's own types. `tests/packaging.test.ts` enforces
zero bare specifiers in any `lib/*.js`, statically **or** dynamically, so this cannot
regress silently.

That last file is also why the plugin is verified working: with `defineTool` local,
`createMemoryTools()` returns all six tools in a plain process with no resolution
hook and no SDK on the module graph.

## Publishing

The package is a normal npm package that happens to carry a `dsh.bundle.patch`
field, so publishing it is the usual flow:

```sh
npm run check          # typecheck + build + tests
npm pack --dry-run     # inspect exactly what ships (57 files, no tests, no node_modules)
npm publish            # publishConfig.access is already "public"
```

Before the first publish, replace the placeholder repository URL in
`package.json` with your own — GitHub's "publish to npm" guidance reads it, and a
`REPLACE-WITH-YOUR-USERNAME` string in a published manifest is worse than no
repository field at all.

Then set the repository's GitHub topics to include **`dsh-plugin`**, which is the
community index described under [Community listing](#community-listing). The topic
and the npm keyword of the same name are what make the plugin discoverable from
either side.

Two packaging properties are load-bearing and easy to lose:

- **`lib/` must be in `files`.** A manifest that forgets it publishes a package
  whose declared entry point does not exist.
- **`lib/` must be committed, and current.** It is tracked (see Install), so a push
  that forgets to rebuild ships an older plugin to everyone installing from git.
  `prepublishOnly` covers the npm side; the git side is on you:
  `npm run build && git add lib && git commit`.

That second point is the real cost of committing build output, and it is worth
stating plainly rather than discovering after a release.

## Development

```sh
npm install
npm run typecheck    # tsc --noEmit against the real SDK types
npm run build        # tsc -p tsconfig.build.json -> lib/
npm test             # node --test, one process per file
npm run check        # all three
```

`npm run test:sandbox` runs the same cases in a single process. It exists for two
reasons: a restricted sandbox can deny the `spawn` that `node --test` needs, and the
`define.test.ts` equivalence suite imports the real SDK, which a pnpm junction layout
leaves unresolvable from inside `dsh-tools` (see above). That entry point adds a
narrow resolver fallback for the `@deepseek-ai/*` scope; on a complete install it is
unnecessary, and the plugin's own `lib/` needs no hook at all.

## Known limitations

- **The child path needs a subagent provider, and the fallback path needs a route.**
  With a subagent provider, the child inherits the session's model and consolidation
  is fully automatic. Without one, the fallback needs `consolidationRouteProvider` +
  `consolidationRouteModel`, or the session's logged `request/header` route; with
  neither, consolidation is skipped rather than guessing a model.
- **Consolidation runs in-process and is not queued.** One run per session at a
  time; a crash mid-run loses that run's changes, never a committed store.
- **The gate is a heuristic over text.** It reads user and assistant text only; it
  cannot see whether a turn was *important*, just whether it *sounded* durable.
- **No dedup against near-identical entries.** Two differently-worded versions of
  the same fact are two entries; the consolidator is expected to merge them.
- **`maxEntries` is per tier, not global**, so a deployment with both tiers enabled
  can hold twice the configured number of entries.
- **The child can only write memory, so anything else it concludes is discarded.**
  That is intentional, but it means a consolidation that needs to inspect a file to
  decide is simply out of scope.

## License

MIT
