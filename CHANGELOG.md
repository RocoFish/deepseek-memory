# Changelog

Notable changes to `deepseek-memory`. Versions follow [semver](https://semver.org/).

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
- Storage is plain JSON with atomic writes and the previous revision kept under
  `history/`.

**Notable fixes found by running against a real harness**

- `inject` must name the services the plugin uses. An empty list leaves the entire
  service registry unreachable — the plugin loads, reports as running, and silently
  registers nothing. This shipped broken in early builds of this version, and the
  wiring test had asserted the empty list, locking the bug in.
- The project tier takes its directory from the session's own recorded `cwd`, not
  `process.cwd()`. The latter describes how the host was launched; in the packaged
  app it is the application's own config directory, so project memory was written
  there instead of into the user's workspace.
- The user tier resolves the harness home from several candidates rather than
  `DSH_HOME` alone, since the desktop host process does not carry that variable.
  `memory_status` reports which source was used, and reports a disabled tier
  explicitly so it cannot be mistaken for an empty one.
