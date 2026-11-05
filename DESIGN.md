# DESIGN.md — Why deepseek-memory stores what it stores

This document records the load-bearing design decisions behind the memory model
and the reasoning for each. It is written for users deciding whether to trust
the plugin with their habits, and for contributors deciding what belongs in it.
For implementation constraints (Cordis wiring, packaging, turn boundaries), see
[README.md](README.md) § Design notes.

## 1. Facts, not transcripts

**Decision:** the plugin never persists raw conversation logs. The store holds
only short, distilled facts, and the *whole store* is injected into every
request — subject to the injection budget: entries that do not fit are omitted
with a pointer to `memory_search`, and the ceilings in §4 are what keep
overflow from being the normal case.

**Why:** a transcript is the highest-noise, highest-cost data a memory system
can hold. It contains secrets typed once and never relevant again, one-off
context, and thousands of tokens of reasoning nobody re-reads. A memory built on
transcripts degrades into a junk drawer within weeks, and every retrieval call
adds latency and a ranking step that can silently drop the one fact that
mattered. A bounded store of facts has none of these failure modes: injection is
a constant, predictable cost, and nothing is ranked because everything
relevant is present by construction.

## 2. Automatic writes, biased toward under-triggering

**Decision:** two write paths exist. Explicit `memory_add` (user-driven) and the
after-turn consolidator (automatic). The consolidator's gate is a local,
deterministic scan, and it is deliberately biased toward **under**-triggering.
There is deliberately **no user-confirmation step**.

**Why:** the failure modes are asymmetric. A missed consolidation costs the user
one repeated sentence, and is usually repaired by the next related turn. An
eager consolidator starts inventing memories, and a wrong memory poisons every
future session that reads it. As for confirmation: the plugin exists to remove
the "approve this fact about yourself" interruption, so the defense against bad
writes is the gate plus visible, deletable entries — not a dialog box.

## 3. Plain files, deliberately

**Decision:** each tier is a single readable JSON file, hand-editable and
diffable in git. Every mutation keeps the previous revision under `history/`
(per tier, capped at 20 files / 5 MiB).

**Why:** trust comes from inspectability. If a user cannot `cat` their own
memory, they cannot verify what the AI knows about them. Plain files are
git-versionable, survive uninstall, and make auditing a habit rather than a
feature request. JSON rather than a database is the same choice again: the file
*is* the interface.

## 4. Hard limits everywhere

**Decision:** entry count (per tier), entry size, tag count/length, injected
characters per request, changes per consolidation run (8), history backups
(20 files / 5 MiB per tier), and consolidation wall-clock are all
hard-ceilinged. Resource-shaped config options are clamped to these ceilings.

**Why:** an unbounded memory store is a denial-of-service against the user's
own context window. Limits are fail-safe: a store that hits its ceiling
degrades to "no new memory", which is the status quo ante — not a crash, and
not silent truncation.

## 5. The store is untrusted input

**Decision:** memory content is parsed defensively at load time, injected inside
`<untrusted-data>` boundaries, and wrapped with a "data, not instructions"
header. Out-of-bounds or forged stores are refused at load, never truncated.
Wrapper tags are stripped from entry text at write time so a stored entry cannot
forge its own closing tag.

**Why:** memory text flows into the system prompt of every future session. A
corrupted or hostile entry is not a data bug — it is a prompt-injection vector.
The parser therefore treats the store with the same suspicion as network input,
and correctness here is held by tests, not convention.

## 6. The writer is the most restricted component

**Decision:** the consolidator runs as a child agent whose only tools are
`memory_*`; everything else is removed from its prompt and refused at execution.
Its receipt is checked against actual store revisions, not trusted.

**Why:** anyone who can steer a conversation has a channel into the store,
because recording what was said is the consolidator's job. The design therefore
makes the writer incapable of acting on what it reads: it can remember a
conversation about running `rm -rf`, but it cannot run it, read files to
"verify" it, or fetch anything.

---

*These are argued positions, not defaults. If you disagree with one, open an
issue — that is what this file is for.*
