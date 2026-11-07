# Changelog

Notable changes to `deepseek-memory`. Versions follow [semver](https://semver.org/).

## 0.1.1

Compatibility with DSH 0.2.2-rc.1.

**Changed**

- Peer ranges widened: the five `@deepseek-ai/dsh-*` peers move from the exact
  pin `0.2.0-rc.2` to `^0.2.0-rc.2`, and `@deepseek-ai/cordis` from `~4.0.4` to
  `^4.0.4`. The previous exact pins made the install-time compatibility gate
  flag the plugin as incompatible on any newer DSH; `^0.2.0-rc.2` still admits
  only the 0.2.x line the plugin was built against. Dev dependencies now track
  `0.2.2-rc.1` and the unused ones (`dsh-invariants`, `dsh-brand`,
  `dsh-timeout`, `dsh-util-crypto`, `dsh-util-values`, `dsh-typert-protocol`,
  `cosmokit`) were removed — no source file imports them.
- DSH 0.2.2 removed `SubagentRuntime.start()` in favour of `startActivation()`,
  and the activation path no longer accepts a per-request `toolFilter`/`persona`
  for a freshly spawned child (narrowing moved to preset composition). Since an
  un-narrowed child would defeat the point of the child path, the plugin now
  probes eligibility with `canNarrowChildren()`: hosts that can narrow use the
  child as before; activation-only hosts fail closed to the direct model path
  (a bare `llm.stream()` with no tools) and say so once at load.

**Fixed**

- `minTurnsBetweenRuns` now actually spaces two consolidator runs: the guard
  counted a session-lifetime total of closed turns (and the run itself bumped
  it), so after the first run the interval was permanently satisfied and every
  durable-signal turn paid a consolidation call. Turns are now counted since
  the last run and reset when one starts; the turn that feeds a run no longer
  eats the next turn's count.
- A write is no longer silently lost when the store cache is dropped between a
  tool's mutation and its commit (`memory_status` refreshes mid-consolidation,
  for example). `commit` now takes the caller's store object and refuses with
  `MEMORY_STORE_STALE` when the runtime no longer owns it.
- Committing a tier that another process changed on disk since load is now
  refused with `MEMORY_STORE_CONFLICT` instead of silently overwriting the
  other writer's entries; the stale cache is dropped so the next read sees the
  truth.

## 0.1.0

First release.

**What it does**

- Two memory tiers: `project` (this repository) and `user` (standing personal facts).
- Six model-facing tools: `memory_add`, `memory_update`, `memory_delete`,
  `memory_list`, `memory_search`, `memory_status`.
- Memory injected as a `systemPrompt` section whose text is a provider, so it is
  recomputed at every assembly and never leaves a stale copy in session history.
- After-turn consolidation triggered on `agent/status` → `idle`, gated on durable
  signals (explicit remember, correction, preference, decision, constraint) so most
  turns cost nothing.
- Consolidation runs as a restricted child agent whose tool filter admits nothing
  but the memory tools, and its claimed result is verified against store revisions
  rather than trusted.

**Packaging**

- The built output is self-contained: zero bare specifiers in `lib/*.js`, statically
  or dynamically, so it loads in a profile whose `node_modules` has no Harness SDK.
  `defineTool`, parameter compilation, argument validation, and `createUserMessage`
  are implemented locally; `tests/define.test.ts` asserts the vendored tool helper
  produces byte-identical schemas to the real SDK one, and `tests/packaging.test.ts`
  enforces the no-bare-import rule.
