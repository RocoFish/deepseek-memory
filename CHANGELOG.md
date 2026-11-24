# Changelog

Notable changes to `deepseek-memory`. Versions follow [semver](https://semver.org/).

## 1.0.4

Third audit round: three regressions and edge cases introduced or left behind
by the 1.0.3 fixes.

**Fixed**

- `applyActions` opens the tier store lazily inside its try/catch: a tier
  whose file cannot be read (malformed, over the size cap) now rejects every
  action of that tier with the reason, instead of letting the open failure
  escape and silently swallow the whole run's remaining actions.
- `memory_arbitrate` `merge` detects the self-referential text collision
  read-only, before the pre-op snapshot is taken: a refused merge no longer
  consumes one of the limited pre-op snapshot slots, and no longer leaves the
  colliding card behind in the tier's cached store.
- Home resolution only trusts a `USERPROFILE` / `HOMEDRIVE`+`HOMEPATH`
  candidate that is absolute under the current platform's path semantics, so
  Windows-shaped values leaking onto POSIX (Wine, cross-compiled hosts,
  manually exported shells) are skipped instead of nesting the memory
  directory inside a literal `X:\...` folder under the working directory.

## 1.0.3

Second audit round: eight findings from a full read of the source are fixed,
three of them behavioral. The direct-path consolidator now rolls a tier back
when any action in it is refused, `merge` can no longer supersede a card with
itself, and home resolution no longer hard-codes win32 path semantics.

**Fixed**

- `applyActions` is now all-or-nothing per tier, matching its documented
  contract: a refused action rolls the tier's in-memory changes back to disk
  state, a tier that applies cleanly commits before the next tier is touched,
  and a commit failure (lock timeout, cross-process revision conflict) moves
  only that tier's actions into `rejected` with the reason instead of
  aborting the run with some tiers silently persisted.
- `memory_arbitrate` `merge` refuses merged text that collides with an
  existing card — including one of the merge sources — instead of creating a
  self-referential supersede chain that removed the group's effective card.
- Home resolution imports `node:path` instead of `node:path/win32`, which on
  Linux/macOS silently scattered the user tier into a relative
  `\home\<user>\.dsh` tree under the working directory. Home tests now
  compose expectations with the platform `join`/`dirname` and assert POSIX
  inputs resolve to POSIX outputs on every host.

**Security**

- `commit` re-checks under the tier lock that the store file has not been
  swapped for a symlink between location validation and the read/history
  backup, closing the TOCTOU window on the read path.
- Snapshot directories are created `0o700`, matching the store and history
  directories — snapshots contain whole tiers, personal data included.
- `memory_arbitrate` takes its pre-operation snapshot only after the branch's
  argument validation passes, so invalid calls no longer consume the limited
  pre-op snapshot quota.

**Housekeeping**

- A commit that overwrites a disk file with no readable revision now warns
  when the session had loaded a healthy store, making silent external
  replacement diagnosable.
- `gate.ts` `textOf` doc comment matches what the function does (case
  handling lives in the regexes, not in the function).

## 1.0.2

Security review follow-ups: the child consolidation mutation budget is now
actually enforced, snapshot restore validates every entry before applying,
export destinations and redaction are tightened, and `pnpm run check` is green
again. No format or tool-surface changes.

**Fixed**

- `memory_add` / `memory_update` / `memory_delete` now call `gateMutation()`
  before touching the store, so one child consolidation run can no longer
  rewrite the whole library past its per-run budget.
- `tests/prompt.test.ts` fixture updated for the v2 household-registration
  entry fields; `typecheck` no longer fails on a fresh clone.

**Security**

- `loadSnapshot()` runs every tier file through the same per-entry
  normalization and bounds as `MemoryStore.load`; a hand-edited or shared
  snapshot can no longer bypass scope/length/entry ceilings at restore time.
- `memory_export` only writes into an existing, non-symlink directory outside
  the default export root; `verifyExport` validates the manifest defensively
  and bounds its directory walk.
- Export redaction now covers `subject`/`key`/`tags`, not just card text.

**Housekeeping**

- Home resolution used win32 path semantics so the home tests passed on any
  host — this regressed POSIX deployments and is reverted in Unreleased.
- Build config disables sourcemaps so the committed `lib/` matches a fresh
  build exactly; scripts consistently use `pnpm run`.

## 1.0.1

Version metadata catches up with the release tags: `package.json` now reports
the published version, and the sections below are stamped with the versions
they shipped in. No behavior change.

## 1.0.0

Household-registration stage 1: every durable memory now carries a household
record, and the resolver can show which card is in force without deleting the
losers.

**Added**

- Memory entries are now cards with `scope`, `subject`, `key`, `status`,
  `confidence`, `source`, and `supersedes`. Existing format-1 files still load
  and migrate in memory; the next commit writes format 2.
- Scope resolution for injection: inside a project session, project cards beat
  personal-global cards; user-confirmed beats assistant inference; recency
  breaks ties only after scope and confidence match; imported cards never
  affect answers; personal-topic cards stay invisible until their subject is
  in play.
- `memory_add` accepts an optional `subject`; `memory_list` shows scope and
  status; `memory_status` reports suspected scope violations by id.
- Injection dedupes by `(subject, key)` so a project value wins without the
  shadowed global value being repeated as a separate fact.
- `memory_conflicts`: a read-only arbitration console. Every `(subject, key)`
  group across both tiers, which value is in force and *why* (scope,
  confidence, or recency, measured against the strongest losing card), which
  cards lost, and which cards need a human: disputed groups, tier scope
  violations, unclaimed imported cards, and weakly supported in-force cards.
  Suggests nothing, changes nothing.
- `memory_arbitrate`: the four confirmed rulings — `adopt` (winner becomes
  `user-confirmed`, competitors become `superseded`, never deleted; the
  winner records what it demoted so the decision replays), `merge` (several
  cards become one new card), `mark-wrong` (archived, kept for replay), and
  `confirm-import` (an imported card enters a real scope, moving tiers when
  needed). Every action takes a `pre-op` snapshot of the whole library first.
- `memory_snapshot` / `memory_restore`: named, restorable points-in-time of
  the whole library. Snapshots capture on-disk truth and live in the user tier
  (with the project tier as fallback), so the project repository is never
  polluted. Retention keeps the newest pre-op x20, daily x7, weekly x4,
  pre-restore x10; the first session of a day/week writes the daily/weekly
  snapshot automatically. Restore always previews first — four buckets per
  tier (`added`, `removed`, `modified`, `conflicts`, where a conflict is a
  card the current side edited *after* the snapshot was taken) — and apply
  writes only the explicitly confirmed selections, backing the current
  library up as `pre-restore` before anything lands.
- `memory_export`: take the library out as one Markdown file per card with
  YAML frontmatter plus `INDEX.md` (`markdown`), a one-card-per-line JSONL
  stream (`jsonl`), or the full bundle zipped (`zip`). `MANIFEST.json` signs
  every file with SHA-256, credential-shaped strings (tokens, PATs, private
  keys) are masked and counted by kind, and `format: "verify"` re-checks an
  export, locating missing or tampered files by name.
- `MemoryStore.adjudicate` changes a card's registration fields (scope,
  status, confidence, supersedes) as one replayable step without touching its
  text; `MemoryStore.upsertRestored` is the restore-only write path that
  reproduces snapshot entries exactly.
- Fixed: `decidedBy` named the axis of a mid-loop comparison, so a winner
  that happened to be listed first always reported `recency`; it now names
  the axis that separates the winner from the strongest losing card.

**Changed**

- The entry ceiling now counts only live cards (`active` and `disputed`);
  `superseded` and `archived` cards stay on disk for replay without consuming
  capacity.
- Adds reject cards whose scope does not belong to the store tier with
  `MEMORY_SCOPE_VIOLATION`.

## 0.1.4

Version-metadata fix — no code changes.

**Fixed**

- `package.json`'s `version` field lagged the git tags: v0.1.2 and v0.1.3 were
  cut while `version` still read `0.1.1`, so plugin listings that install from
  the git source kept showing `0.1.1` no matter which tag was checked out. The
  manifest now reads `0.1.4`, matching the v0.1.4 tag.

## 0.1.3

Release hygiene for the 0.1.2 security fixes: the committed build output and
the dependency snapshot are brought in line with the verified local build.
Backfilled from git history — the tag shipped without a manifest bump.

**Fixed**

- Transitive `zod` pinned to the patched `4.6.6` release.
- The committed `lib/` output is byte-identical to a fresh `tsc` build of the
  security-fixed sources (runtime, tools, consolidate, subagent and their
  declarations), so a git install loads exactly what the sources describe.
- The lockfile and the `pnpm.overrides` pin agree with the verified local
  build; the dependency snapshot no longer diverges from what CI and the
  release build actually resolve.

## 0.1.2

Security hardening. Backfilled from git history — the tag shipped without a
manifest bump.

**Fixed**

- History symlinks that resolve outside their tier directory are refused with
  `MEMORY_STORE_ESCAPE` instead of being read or written through.
- History backup names gain an 8-character random suffix so two backups taken
  in the same millisecond no longer silently overwrite each other (lexical
  order stays chronological for the pruner).
- Child consolidation runs now carry a per-run mutation budget enforced at the
  memory tool gate, and the child transcript is wrapped as untrusted data so
  it cannot prompt-inject its way to more authority than the runtime grants.

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
