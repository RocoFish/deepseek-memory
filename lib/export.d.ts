import type { ArbitrationView } from './arbitrate.ts';
import type { MemoryEntry, MemoryScope } from './store.ts';
/** Bumped when the export shape changes. */
export declare const EXPORTER_VERSION = "1";
/** Which scopes landed in the export, and which tiers supplied them. */
export interface ExportSelection {
    readonly entries: readonly MemoryEntry[];
    /** Scopes the export deliberately left out, with why. */
    readonly exclusions: readonly {
        reason: string;
        count: number;
    }[];
    /** Whether personal-global cards are in this export (an explicit switch). */
    readonly includesPersonalGlobal: boolean;
}
/** Per-kind counts of masked secrets. */
export type RedactionReport = readonly {
    label: string;
    count: number;
}[];
/**
 * Mask credential-shaped substrings in one text, counting per kind.
 *
 * Pure: the store is never touched, only the exported copy. An empty report
 * means nothing matched, which the manifest records explicitly — the absence
 * of redaction is itself a fact worth writing down.
 */
export declare function redactSecrets(text: string): {
    text: string;
    report: RedactionReport;
};
/** SHA-256 hex of a buffer. */
export declare function sha256Hex(data: Buffer): string;
/** One file destined for a bundle. */
export interface BundleFile {
    /** Path inside the bundle, forward slashes. */
    readonly path: string;
    readonly data: Buffer;
}
/** One entry of MANIFEST.json's file table. */
export interface ManifestEntry {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
}
/** The manifest contract; {@link verifyExport} checks exactly this. */
export interface ExportManifest {
    readonly schemaVersion: number;
    readonly createdAt: number;
    readonly exporterVersion: string;
    readonly files: readonly ManifestEntry[];
    /** Scopes present in this export. */
    readonly scopes: readonly MemoryScope[];
    /** What was deliberately left out, and why. */
    readonly exclusions: readonly {
        reason: string;
        count: number;
    }[];
    /** What was masked, and how many times. */
    readonly redaction: RedactionReport;
    readonly includesPersonalGlobal: boolean;
}
/**
 * Render one card as a Markdown document with YAML frontmatter.
 *
 * The frontmatter carries the household registration; the body is the card's
 * own text. Strings are emitted JSON-style, which is a valid YAML double-
 * quoted scalar, so hand-editing the file cannot corrupt the escape syntax.
 */
export declare function cardToMarkdown(entry: MemoryEntry): string;
/** Render the human-facing INDEX.md. */
export declare function indexToMarkdown(meta: {
    createdAt: number;
    entryCount: number;
    scopes: readonly MemoryScope[];
    view: ArbitrationView;
    selection: ExportSelection;
    redaction: RedactionReport;
}): string;
/** Build MANIFEST.json's payload for one bundle. */
export declare function buildManifest(meta: {
    createdAt: number;
    files: readonly BundleFile[];
    selection: ExportSelection;
    scopes: readonly MemoryScope[];
    redaction: RedactionReport;
}): ExportManifest;
/** CRC-32 (IEEE), the checksum ZIP's stored entries carry. */
export declare function crc32(data: Buffer): number;
/**
 * Assemble one ZIP archive from stored (uncompressed) entries.
 *
 * Local header + data per file, then the central directory and the end record.
 * Bit 11 marks UTF-8 names so CJK card text in file names survives round
 * trips through mainstream unzip tools.
 */
export declare function buildZip(files: readonly BundleFile[], now?: number): Buffer;
/**
 * Assemble the full file set for one export: per-card Markdown, `INDEX.md`,
 * `memories.jsonl`, and `MANIFEST.json` (which signs the other three).
 */
export declare function assembleBundle(meta: {
    createdAt: number;
    selection: ExportSelection;
    view: ArbitrationView;
    scopes: readonly MemoryScope[];
}): {
    files: BundleFile[];
    redaction: RedactionReport;
};
/** Write a Markdown or JSONL export (flat directory) plus the ZIP next to it when asked. */
export declare function writeBundle(dir: string, bundle: {
    files: BundleFile[];
    redaction: RedactionReport;
}, zip: boolean, now?: number): {
    dir: string;
    zipPath?: string;
};
/**
 * Verify an export directory against its MANIFEST.json: every listed file
 * present, every SHA-256 matching. Returns located problems, not a boolean,
 * because "a card is missing" only helps if you know which one.
 */
export declare function verifyExport(dir: string): {
    ok: boolean;
    missing: string[];
    mismatched: string[];
};
//# sourceMappingURL=export.d.ts.map