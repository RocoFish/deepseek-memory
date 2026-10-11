/**
 * Store invariant tests: the limits are the feature.
 *
 * These run against the pure store, so they need no harness and no filesystem.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MemoryError,
  MemoryStore,
  STORE_FORMAT,
  codePointLength,
  entryId,
  normalizeEntryText,
} from '../src/store.ts'

const limits = { maxEntries: 3, maxEntryChars: 40 }

function fresh(): MemoryStore {
  return new MemoryStore('project', limits)
}

test('normalizeEntryText collapses whitespace and strips harness framing', () => {
  assert.equal(normalizeEntryText('  a   b \n c '), 'a b c')
  assert.equal(normalizeEntryText('<system-reminder>x</system-reminder>'), 'x')
})

test('codePointLength counts characters, not UTF-16 units', () => {
  // Emoji and CJK must not be counted double, or the cap means different things
  // in different languages.
  assert.equal(codePointLength('记忆索引'), 4)
  assert.equal(codePointLength('👍'), 1)
})

test('entryId is stable and case-insensitive', () => {
  assert.equal(entryId('Use pnpm'), entryId('use PNPM'))
  assert.notEqual(entryId('use pnpm'), entryId('use npm'))
})

test('add validates emptiness and length', () => {
  const store = fresh()
  assert.throws(() => store.add({ text: '   ', origin: 'user', now: 1 }), /cannot be empty/)
  assert.throws(
    () => store.add({ text: 'x'.repeat(41), origin: 'user', now: 1 }),
    (error: unknown) => error instanceof MemoryError && error.code === 'MEMORY_ENTRY_TOO_LONG',
  )
})

test('add is idempotent for the same fact', () => {
  const store = fresh()
  const first = store.add({ text: 'The user prefers pnpm', origin: 'user', now: 1 })
  const second = store.add({ text: 'the user PREFERS pnpm', origin: 'user', now: 2 })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(store.size, 1)
  assert.equal(store.revision, 1, 'a duplicate add must not bump the revision')
})

test('add refuses past the entry ceiling instead of silently dropping', () => {
  const store = fresh()
  for (let i = 0; i < limits.maxEntries; i += 1) {
    store.add({ text: `fact number ${i} that is distinct`, origin: 'user', now: i })
  }
  assert.equal(store.size, limits.maxEntries)
  assert.throws(
    () => store.add({ text: 'one fact too many here', origin: 'user', now: 9 }),
    (error: unknown) => error instanceof MemoryError && error.code === 'MEMORY_STORE_FULL',
  )
})

test('update rewrites in place and keeps identity and creation time', () => {
  const store = fresh()
  const { entry } = store.add({ text: 'User lives in Beijing', origin: 'user', now: 100 })
  const updated = store.update({ id: entry.id, text: 'User lives in Shanghai', origin: 'user', now: 200 })
  assert.equal(updated.createdAt, 100, 'creation time must survive the rewrite')
  assert.equal(updated.updatedAt, 200)
  assert.equal(updated.id, entry.id, 'identity must survive the rewrite')
  assert.equal(store.size, 1)
  assert.equal(store.revision, 2)
})

test('update refuses an unknown id with teaching text', () => {
  const store = fresh()
  assert.throws(
    () => store.update({ id: 'mnope', text: 'x', origin: 'user', now: 1 }),
    (error: unknown) => error instanceof MemoryError && error.code === 'MEMORY_ENTRY_NOT_FOUND',
  )
})

test('update refuses to rewrite one entry into another entry text', () => {
  const store = fresh()
  store.add({ text: 'first distinct fact here', origin: 'user', now: 1 })
  const second = store.add({ text: 'second distinct fact here', origin: 'user', now: 2 })
  // Rewriting `second` onto `first`'s text would leave two entries that are the
  // same fact, which is exactly the duplication memory_update exists to prevent.
  assert.throws(
    () => store.update({ id: second.entry.id, text: 'first distinct fact here', origin: 'user', now: 3 }),
    (error: unknown) => error instanceof MemoryError && error.code === 'MEMORY_ENTRY_DUPLICATE',
  )
})

test('remove deletes one entry and reports an unknown id', () => {
  const store = fresh()
  const { entry } = store.add({ text: 'a fact worth deleting', origin: 'user', now: 1 })
  const removed = store.remove(entry.id, 2)
  assert.equal(removed.id, entry.id)
  assert.equal(store.size, 0)
  assert.throws(() => store.remove(entry.id, 3), /no memory entry with id/)
})

test('list filters by literal substring across text and tags', () => {
  const store = fresh()
  store.add({ text: 'The build uses pnpm', tags: ['build'], origin: 'user', now: 1 })
  store.add({ text: 'User prefers concise answers', tags: ['style'], origin: 'user', now: 2 })
  assert.equal(store.list().length, 2)
  assert.equal(store.list('pnpm').length, 1)
  assert.equal(store.list('STYLE').length, 1, 'the filter must be case-insensitive')
  assert.equal(store.list('nothing here').length, 0)
})

test('entries are returned newest-updated first', () => {
  const store = fresh()
  store.add({ text: 'older fact about the project', origin: 'user', now: 10 })
  const newer = store.add({ text: 'newer fact about the project', origin: 'user', now: 20 })
  assert.equal(store.entries()[0]?.id, newer.entry.id)
})

test('round-trips through the file format', () => {
  const store = fresh()
  store.add({ text: 'the project uses esm modules', tags: ['build'], origin: 'consolidator', now: 5 })
  const file = JSON.parse(JSON.stringify(store.toFile(6)))

  const restored = fresh()
  restored.load(file, 'test')
  assert.equal(restored.size, 1)
  assert.equal(restored.revision, store.revision)
  assert.equal(restored.entries()[0]?.text, 'the project uses esm modules')
})

test('load refuses an unknown format rather than guessing', () => {
  const store = fresh()
  assert.throws(
    () => store.load({ format: STORE_FORMAT + 1, entries: [] }, 'test'),
    (error: unknown) => error instanceof MemoryError && error.code === 'MEMORY_STORE_FORMAT',
  )
  assert.throws(() => store.load({ entries: [] }, 'test'), /format/)
  assert.throws(() => store.load(null, 'test'), /not an object/)
  assert.throws(() => store.load({ format: STORE_FORMAT }, 'test'), /entries array/)
})

test('load skips unusable entries instead of failing the whole store', () => {
  const store = fresh()
  store.load({
    format: STORE_FORMAT,
    revision: 4,
    entries: [
      { id: 'good', text: 'a perfectly good fact', tags: ['x'], createdAt: 1, updatedAt: 1, origin: 'user' },
      { text: '   ' },
      null,
      { text: 'an entry with no id gets one derived', origin: 'consolidator' },
    ],
  }, 'test')
  assert.equal(store.size, 2)
  assert.equal(store.revision, 4)
})
