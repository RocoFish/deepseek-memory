/**
 * Export: take the memory library out of the plugin, in a form a human can
 * read on a phone and a machine can verify and re-import.
 *
 * Three shapes, never mixed in one file:
 *
 * - a **Markdown package** — one `.md` per card with YAML frontmatter, plus an
 *   `INDEX.md` a human can open cold and understand;
 * - a **JSONL stream** — one card per line, fields intact, for diffing and
 *   machine recovery;
 * - a **ZIP bundle** — both of the above plus a `MANIFEST.json`, for backup
 *   and migration.
 *
 * Two hard rules, fixed in advance:
 *
 * 1. **Export is lossless but never leaks secrets.** Anything that looks like
 *    a token, a PAT, or a private key is masked in place and reported by
 *    count and kind — silently exporting a credential would turn a backup
 *    into a breach.
 * 2. **Every bundle verifies.** `MANIFEST.json` carries a SHA-256 per file;
 *    {@link verifyExport} re-checks them, so a truncated copy or a missing
 *    card is a located problem, not a silent gap.
 *
 * The ZIP writer is hand-rolled (stored, no compression) to keep the package
 * dependency-free: a memory store is small plain text, and a stored entry is
 * byte-identical to its source, which is exactly what a backup wants.
 *
 * @module deepseek-memory/export
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ArbitrationView } from './arbitrate.ts'
import type { MemoryEntry, MemoryScope } from './store.ts'
import { STORE_FORMAT } from './store.ts'

/** Bumped when the export shape changes. */
export const EXPORTER_VERSION = '1'

/** Which scopes landed in the export, and which tiers supplied them. */
export interface ExportSelection {
  readonly entries: readonly MemoryEntry[]
  /** Scopes the export deliberately left out, with why. */
  readonly exclusions: readonly { reason: string; count: number }[]
  /** Whether personal-global cards are in this export (an explicit switch). */
  readonly includesPersonalGlobal: boolean
}

/** Per-kind counts of masked secrets. */
export type RedactionReport = readonly { label: string; count: number }[]

// Well-known credential shapes, kept conservative on purpose: a pattern that
// ever fires on ordinary prose costs trust in every export after it.
const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'github-token', pattern: /ghp_[A-Za-z0-9]{36}/g },
  { label: 'github-fine-grained-token', pattern: /github_pat_[A-Za-z0-9_]{22,}/g },
  { label: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    label: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
]

/**
 * Mask credential-shaped substrings in one text, counting per kind.
 *
 * Pure: the store is never touched, only the exported copy. An empty report
 * means nothing matched, which the manifest records explicitly — the absence
 * of redaction is itself a fact worth writing down.
 */
export function redactSecrets(text: string): { text: string; report: RedactionReport } {
  let output = text
  const report: { label: string; count: number }[] = []
  for (const { label, pattern } of SECRET_PATTERNS) {
    let count = 0
    output = output.replace(pattern, () => {
      count += 1
      return `[REDACTED:${label}]`
    })
    if (count > 0) report.push({ label, count })
  }
  return { text: output, report }
}

/** SHA-256 hex of a buffer. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** One file destined for a bundle. */
export interface BundleFile {
  /** Path inside the bundle, forward slashes. */
  readonly path: string
  readonly data: Buffer
}

/** One entry of MANIFEST.json's file table. */
export interface ManifestEntry {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

/** The manifest contract; {@link verifyExport} checks exactly this. */
export interface ExportManifest {
  readonly schemaVersion: number
  readonly createdAt: number
  readonly exporterVersion: string
  readonly files: readonly ManifestEntry[]
  /** Scopes present in this export. */
  readonly scopes: readonly MemoryScope[]
  /** What was deliberately left out, and why. */
  readonly exclusions: readonly { reason: string; count: number }[]
  /** What was masked, and how many times. */
  readonly redaction: RedactionReport
  readonly includesPersonalGlobal: boolean
}

/**
 * Render one card as a Markdown document with YAML frontmatter.
 *
 * The frontmatter carries the household registration; the body is the card's
 * own text. Strings are emitted JSON-style, which is a valid YAML double-
 * quoted scalar, so hand-editing the file cannot corrupt the escape syntax.
 */
export function cardToMarkdown(entry: MemoryEntry): string {
  const frontmatter = [
    '---',
    `id: ${JSON.stringify(entry.id)}`,
    `scope: ${entry.scope}`,
    `subject: ${JSON.stringify(entry.subject)}`,
    `key: ${JSON.stringify(entry.key)}`,
    `status: ${entry.status}`,
    `confidence: ${entry.confidence}`,
    `source: ${entry.source}`,
    `updated_at: ${JSON.stringify(new Date(entry.updatedAt).toISOString().slice(0, 10))}`,
    `supersedes: [${entry.supersedes.map(id => JSON.stringify(id)).join(', ')}]`,
    `tags: [${entry.tags.map(tag => JSON.stringify(tag)).join(', ')}]`,
    '---',
    '',
    entry.text,
    '',
  ].join('\n')
  return frontmatter
}

/** Render the human-facing INDEX.md. */
export function indexToMarkdown(meta: {
  createdAt: number
  entryCount: number
  scopes: readonly MemoryScope[]
  view: ArbitrationView
  selection: ExportSelection
  redaction: RedactionReport
}): string {
  const date = new Date(meta.createdAt).toISOString()
  const competing = meta.view.groups.filter(group => group.decidedBy !== undefined).length
  const pending = meta.view.flagged.length
    + meta.view.groups.reduce((sum, group) => sum + group.cards.filter(card => card.layer === 'pending').length, 0)
  const lines = [
    '# Memory Export',
    '',
    `- exported_at: ${date}`,
    `- schema_version: ${STORE_FORMAT}`,
    `- exporter_version: ${EXPORTER_VERSION}`,
    `- entries: ${meta.entryCount}`,
    `- scopes: ${meta.scopes.join(', ') || '(none)'}`,
    `- includes_personal_global: ${meta.selection.includesPersonalGlobal}`,
    `- competing_groups: ${competing}`,
    `- pending_confirmation: ${pending}`,
    `- redactions: ${meta.redaction.length === 0 ? 'none' : meta.redaction.map(item => `${item.label} x${item.count}`).join(', ')}`,
    '',
    '## Exclusions',
    '',
  ]
  if (meta.selection.exclusions.length === 0) lines.push('None.')
  else for (const exclusion of meta.selection.exclusions) lines.push(`- ${exclusion.reason}: ${exclusion.count}`)
  lines.push('', '## Cards', '')
  // The view arrives unredacted (it describes the store); INDEX.md leaves the
  // bundle, so every text it prints goes through the same masking as the
  // cards. Redacting an already-masked string is a no-op.
  for (const group of meta.view.groups) {
    for (const card of group.cards) {
      const tier = card.layer === 'effective' ? '+' : '-'
      lines.push(`${tier} [${card.entry.id}] (${card.entry.scope}) ${redactSecrets(card.entry.text).text}`)
    }
  }
  for (const flagged of meta.view.flagged) {
    lines.push(`- [${flagged.entry.id}] (${flagged.entry.scope}, ${flagged.reason}) ${redactSecrets(flagged.entry.text).text}`)
  }
  return `${lines.join('\n')}\n`
}

/** Build MANIFEST.json's payload for one bundle. */
export function buildManifest(meta: {
  createdAt: number
  files: readonly BundleFile[]
  selection: ExportSelection
  scopes: readonly MemoryScope[]
  redaction: RedactionReport
}): ExportManifest {
  return {
    schemaVersion: STORE_FORMAT,
    createdAt: meta.createdAt,
    exporterVersion: EXPORTER_VERSION,
    files: meta.files.map(file => ({ path: file.path, sha256: sha256Hex(file.data), bytes: file.data.length })),
    scopes: meta.scopes,
    exclusions: meta.selection.exclusions,
    redaction: meta.redaction,
    includesPersonalGlobal: meta.selection.includesPersonalGlobal,
  }
}

// ---------------------------------------------------------------------------
// Minimal stored-method ZIP writer (see the module doc for why).
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 (IEEE), the checksum ZIP's stored entries carry. */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** DOS date/time for ZIP headers, from epoch milliseconds. */
function dosDateTime(now: number): { time: number; date: number } {
  const d = new Date(now)
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/**
 * Assemble one ZIP archive from stored (uncompressed) entries.
 *
 * Local header + data per file, then the central directory and the end record.
 * Bit 11 marks UTF-8 names so CJK card text in file names survives round
 * trips through mainstream unzip tools.
 */
export function buildZip(files: readonly BundleFile[], now: number = Date.now()): Buffer {
  const { time, date } = dosDateTime(now)
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const crc = crc32(file.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names.
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(file.data.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, name, file.data)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4)
    record.writeUInt16LE(20, 6)
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(0, 10)
    record.writeUInt16LE(time, 12)
    record.writeUInt16LE(date, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(file.data.length, 20)
    record.writeUInt32LE(file.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([record, name]))
    offset += 30 + name.length + file.data.length
  }
  const centralStart = offset
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(centralStart, 16)
  return Buffer.concat([...chunks, centralBuffer, end])
}

// ---------------------------------------------------------------------------
// Writing a bundle to disk, and verifying it back.
// ---------------------------------------------------------------------------

/** Card file names are ids plus `.md`; ids are hash-derived and safe. */
function cardPath(entry: MemoryEntry): string {
  return `cards/${entry.id}.md`
}

/**
 * Assemble the full file set for one export: per-card Markdown, `INDEX.md`,
 * `memories.jsonl`, and `MANIFEST.json` (which signs the other three).
 */
export function assembleBundle(meta: {
  createdAt: number
  selection: ExportSelection
  view: ArbitrationView
  scopes: readonly MemoryScope[]
}): { files: BundleFile[]; redaction: RedactionReport } {
  const redactions = new Map<string, number>()
  const files: BundleFile[] = []
  const jsonl: string[] = []
  for (const entry of meta.selection.entries) {
    const redacted = redactSecrets(entry.text)
    for (const item of redacted.report) redactions.set(item.label, (redactions.get(item.label) ?? 0) + item.count)
    const exported: MemoryEntry = redacted.text === entry.text ? entry : { ...entry, text: redacted.text }
    files.push({ path: cardPath(entry), data: Buffer.from(cardToMarkdown(exported), 'utf8') })
    jsonl.push(JSON.stringify(exported))
  }
  const redaction = [...redactions.entries()].map(([label, count]) => ({ label, count }))
  files.push({ path: 'INDEX.md', data: Buffer.from(indexToMarkdown({
    createdAt: meta.createdAt,
    entryCount: meta.selection.entries.length,
    scopes: meta.scopes,
    view: meta.view,
    selection: meta.selection,
    redaction,
  }), 'utf8') })
  files.push({ path: 'memories.jsonl', data: Buffer.from(`${jsonl.join('\n')}${jsonl.length > 0 ? '\n' : ''}`, 'utf8') })
  files.push({ path: 'MANIFEST.json', data: Buffer.from(`${JSON.stringify(buildManifest({
    createdAt: meta.createdAt,
    files,
    selection: meta.selection,
    scopes: meta.scopes,
    redaction,
  }), undefined, 2)}\n`, 'utf8') })
  return { files, redaction }
}

/** Write a Markdown or JSONL export (flat directory) plus the ZIP next to it when asked. */
export function writeBundle(dir: string, bundle: { files: BundleFile[]; redaction: RedactionReport }, zip: boolean, now: number = Date.now()): { dir: string; zipPath?: string } {
  mkdirSync(dir, { recursive: true })
  for (const file of bundle.files) {
    const target = join(dir, ...file.path.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data)
  }
  if (!zip) return { dir }
  const zipPath = join(dir, 'memory-export.zip')
  writeFileSync(zipPath, buildZip(bundle.files, now))
  return { dir, zipPath }
}

/**
 * Verify an export directory against its MANIFEST.json: every listed file
 * present, every SHA-256 matching. Returns located problems, not a boolean,
 * because "a card is missing" only helps if you know which one.
 */
export function verifyExport(dir: string): { ok: boolean; missing: string[]; mismatched: string[] } {
  const manifestPath = join(dir, 'MANIFEST.json')
  if (!existsSync(manifestPath)) {
    return { ok: false, missing: ['MANIFEST.json'], mismatched: [] }
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ExportManifest
  const missing: string[] = []
  const mismatched: string[] = []
  for (const entry of manifest.files ?? []) {
    const file = join(dir, ...entry.path.split('/'))
    if (!existsSync(file)) {
      missing.push(entry.path)
      continue
    }
    if (sha256Hex(readFileSync(file)) !== entry.sha256) mismatched.push(entry.path)
  }
  // A bundle that gained files the manifest never signed is also dishonest.
  const onDisk = new Set<string>()
  const walk = (relative: string): void => {
    for (const item of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const child = relative === '' ? item.name : `${relative}/${item.name}`
      if (item.isDirectory()) walk(child)
      else onDisk.add(child)
    }
  }
  walk('')
  for (const path of onDisk) {
    if (path === 'MANIFEST.json' || path === 'memory-export.zip') continue
    if (!(manifest.files ?? []).some(entry => entry.path === path)) missing.push(`unsigned:${path}`)
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched }
}
