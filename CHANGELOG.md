# Changelog

Notable changes to `deepseek-memory`. Versions follow [semver](https://semver.org/).

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

- Home resolution uses win32 path semantics; the home tests pass on any host.
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
  personal-global cards; imported cards resolve in the importing scope.
- Card lifecycle states (`active` / `disputed` / `superseded` / `archived`)
  with confidence levels, so injection can show the in-force card while
  keeping the full arbitration history replayable.
- Conflict surfacing: `memory_conflicts` lists competing cards, and
  `memory_arbitrate` adjudicates one conflict at a time with explicit
  outcomes (affirm / supersede / merge / archive / dispute).

## 0.1.4

Snapshot and restore: the whole library can be backed up on demand or around
dangerous operations, browsed, diffed, and restored entry-by-entry.

**Added**

- `memory_snapshot` with four kinds of snapshot (`pre-op`, `pre-restore`,
  `daily`, `weekly` plus unlimited manual), retention enforced per kind, and
  atomic write-then-rename persistence.
- `memory_restore` with a preview-first contract: every restore shows a
  four-bucket diff (added / removed / modified / conflicts) and only applies
  entries the user confirms.
- `memory_export` producing a Markdown package, a JSONL stream, or a zipped
  bundle; `MANIFEST.json` signs every file with SHA-256 and masks
  credential-shaped strings before signing.

## 0.1.3

Two-tier store and prompt injection.

**Added**

- `user` and `project` memory tiers with separate files, budgets, and
  histories.
- Per-request injection of memory into the system prompt inside an explicit
  `<untrusted-data>` block, with a token budget and a stale-data warning.
- After-turn consolidation proposing a bounded change set instead of rewriting
  the store, with revision checks against concurrent writers.

## 0.1.2

Initial public release: curated long-term memory as a DeepSeek Harness
plugin, with `memory_add`, `memory_update`, `memory_delete`, `memory_list`,
and `memory_search`.
