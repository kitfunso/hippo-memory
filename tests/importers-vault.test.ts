/**
 * K1 markdown-vault importer tests (real DB, no mocks).
 *
 * Covers tests (a)-(i) from docs/plans/2026-06-10-k1-vault-import.md:
 *   (a) fixture vault → ≥95% notes as kind='raw' with source:vault + vault:<name> tags
 *   (b) re-import idempotent (0 dups)
 *   (c) changed file → OLD archived + new kind='raw' with source:vault tag
 *   (d) deleted file → archived/invalidated
 *   (e) wikilinks → wikilink-candidate:<target> tags (incl [[a|b]]→a)
 *   (f) frontmatter tags/aliases mapped
 *   (g) no crash on dialect syntax (Obsidian/Foam/Dendron fixtures)
 *   (h) tenant isolation
 *   (i) LIKE-escape isolation (vault `a%` does not archive vault `ab`'s rows)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'node:url';
import { importVault, type ImportOptions } from '../src/importers.js';
import { loadAllEntries, initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

let tmpDir: string; // hippo root (the store)
let vaultDir: string; // a scratch vault folder we mutate per-test

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault-imports');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-vault-store-'));
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-vault-src-'));
  initStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

function writeNote(rel: string, content: string): void {
  const abs = path.join(vaultDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function opts(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return { hippoRoot: tmpDir, tenantId: 'default', ...overrides };
}

/** Read raw_archive rows directly for archive assertions. */
function archivedRows(): Array<{ memory_id: string; reason: string }> {
  const db = openHippoDb(tmpDir);
  try {
    return db
      .prepare(`SELECT memory_id, reason FROM raw_archive ORDER BY archived_at ASC`)
      .all() as Array<{ memory_id: string; reason: string }>;
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// (a) fixture vault imports as kind='raw' with provenance tags
// ---------------------------------------------------------------------------

describe('importVault (a) — fixture vault → kind=raw with source:vault tags', () => {
  it('imports ≥95% of obsidian fixture notes as raw with provenance tags', () => {
    const result = importVault(path.join(FIXTURES, 'obsidian-sample'), opts({ name: 'obs' }));
    expect(result.total).toBeGreaterThanOrEqual(3);
    expect(result.imported).toBe(result.total);
    expect(result.skipped).toBe(0);

    const all = loadAllEntries(tmpDir, 'default');
    expect(all.length).toBe(result.total);
    const raws = all.filter((e) => e.kind === 'raw');
    // ≥95% as kind='raw' with both provenance tags.
    const provenanced = raws.filter(
      (e) => e.tags.includes('source:vault') && e.tags.includes('vault:obs'),
    );
    expect(provenanced.length / all.length).toBeGreaterThanOrEqual(0.95);
    // Every imported row carries an artifactRef under the vault prefix.
    for (const e of all) {
      expect(e.artifact_ref).toMatch(/^vault:obs:/);
      expect(e.owner).toBe('agent:vault-import');
    }
  });
});

// ---------------------------------------------------------------------------
// (b) re-import idempotent
// ---------------------------------------------------------------------------

describe('importVault (b) — re-import is idempotent', () => {
  it('produces 0 dups and all-skipped on unchanged re-import', () => {
    writeNote('a.md', '# A\nbody a [[b]]');
    writeNote('b.md', '---\ntags: [t1]\n---\n# B\nbody b');

    const first = importVault(vaultDir, opts({ name: 'v' }));
    expect(first.imported).toBe(2);
    expect(first.skipped).toBe(0);

    const second = importVault(vaultDir, opts({ name: 'v' }));
    expect(second.total).toBe(2);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);

    // Still exactly 2 live rows — no duplicates.
    const all = loadAllEntries(tmpDir, 'default');
    expect(all.length).toBe(2);
    expect(archivedRows().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) changed file → old archived + new kind=raw with source:vault tag
// ---------------------------------------------------------------------------

describe('importVault (c) — changed file archives old + appends new raw', () => {
  it('archives the old raw row and writes a new kind=raw with source:vault', () => {
    writeNote('note.md', '# Note\noriginal content');
    const first = importVault(vaultDir, opts({ name: 'v' }));
    expect(first.imported).toBe(1);
    const originalId = loadAllEntries(tmpDir, 'default')[0].id;

    // Mutate the file.
    writeNote('note.md', '# Note\nCHANGED content');
    const second = importVault(vaultDir, opts({ name: 'v' }));
    expect(second.imported).toBe(1); // new raw appended
    expect(second.skipped).toBe(0);

    const all = loadAllEntries(tmpDir, 'default');
    // Exactly one LIVE row (old archived/deleted, new appended).
    expect(all.length).toBe(1);
    const live = all[0];
    expect(live.id).not.toBe(originalId);
    expect(live.kind).toBe('raw');
    expect(live.tags).toContain('source:vault');
    expect(live.content).toContain('CHANGED');

    // Old row is gone from memories and snapshotted in raw_archive with a
    // `changed:` reason.
    const archived = archivedRows();
    expect(archived.length).toBe(1);
    expect(archived[0].memory_id).toBe(originalId);
    expect(archived[0].reason).toMatch(/^changed:vault:v:note\.md$/);
  });
});

// ---------------------------------------------------------------------------
// (d) deleted file → archived
// ---------------------------------------------------------------------------

describe('importVault (d) — deleted source file archives the raw row', () => {
  it('archives the orphaned raw row on deletion-sync', () => {
    writeNote('keep.md', '# Keep\nstays');
    writeNote('drop.md', '# Drop\ngoes away');
    const first = importVault(vaultDir, opts({ name: 'v' }));
    expect(first.imported).toBe(2);

    const dropId = loadAllEntries(tmpDir, 'default').find((e) =>
      e.artifact_ref === 'vault:v:drop.md',
    )!.id;

    // Remove one note from the source folder.
    fs.rmSync(path.join(vaultDir, 'drop.md'));
    const second = importVault(vaultDir, opts({ name: 'v' }));
    expect(second.total).toBe(1); // only keep.md found
    expect(second.skipped).toBe(1); // keep.md unchanged

    const all = loadAllEntries(tmpDir, 'default');
    expect(all.length).toBe(1);
    expect(all[0].artifact_ref).toBe('vault:v:keep.md');

    const archived = archivedRows();
    expect(archived.length).toBe(1);
    expect(archived[0].memory_id).toBe(dropId);
    expect(archived[0].reason).toMatch(/^source_deleted:vault:v:drop\.md$/);
  });
});

// ---------------------------------------------------------------------------
// (e) wikilinks → wikilink-candidate:<target> tags (incl [[a|b]]→a)
// ---------------------------------------------------------------------------

describe('importVault (e) — wikilinks become wikilink-candidate tags', () => {
  it('maps [[target]] and [[target|alias]] to wikilink-candidate:<target>', () => {
    writeNote('w.md', '# W\nlinks [[plain-target]] and [[real|Display Alias]] and dup [[plain-target]]');
    importVault(vaultDir, opts({ name: 'v' }));

    const e = loadAllEntries(tmpDir, 'default')[0];
    expect(e.tags).toContain('wikilink-candidate:plain-target');
    expect(e.tags).toContain('wikilink-candidate:real'); // alias dropped
    expect(e.tags).not.toContain('wikilink-candidate:Display Alias');

    // Exact tag-array shape: no duplicate tags despite the repeated [[plain-target]].
    const uniq = new Set(e.tags);
    expect(uniq.size).toBe(e.tags.length);
    const wlCount = e.tags.filter((t) => t === 'wikilink-candidate:plain-target').length;
    expect(wlCount).toBe(1);
    // Full expected provenance + wikilink set (order-independent).
    expect(e.tags).toEqual(
      expect.arrayContaining([
        'source:vault',
        'vault:v',
        'wikilink-candidate:plain-target',
        'wikilink-candidate:real',
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// (f) frontmatter tags/aliases mapped
// ---------------------------------------------------------------------------

describe('importVault (f) — frontmatter tags and aliases map to tags', () => {
  it('maps flow-list + block-list tags and aliases (alias:<x>) with no dup surprises', () => {
    writeNote(
      'fm.md',
      '---\ntags: [alpha, beta]\naliases: [Nick, Other]\n---\n# FM\nbody no links',
    );
    importVault(vaultDir, opts({ name: 'v' }));
    const e = loadAllEntries(tmpDir, 'default')[0];

    expect(e.tags).toContain('alpha');
    expect(e.tags).toContain('beta');
    expect(e.tags).toContain('alias:Nick');
    expect(e.tags).toContain('alias:Other');
    expect(e.tags).toContain('source:vault');
    expect(e.tags).toContain('vault:v');

    // Tag-array shape: unique, and exactly the expected set (plus the
    // content-hash tag which we don't pin by value).
    const uniq = new Set(e.tags);
    expect(uniq.size).toBe(e.tags.length);
    const nonHash = e.tags.filter((t) => !t.startsWith('content-hash:')).sort();
    expect(nonHash).toEqual(
      ['alias:Nick', 'alias:Other', 'alpha', 'beta', 'source:vault', 'vault:v'].sort(),
    );
  });

  it('parses block-style (indented dash) frontmatter tag lists', () => {
    writeNote('fm2.md', '---\ntags:\n  - one\n  - two\n---\n# FM2\nbody');
    importVault(vaultDir, opts({ name: 'v' }));
    const e = loadAllEntries(tmpDir, 'default')[0];
    // Block-list YAML is not parsed by the minimal inline parser as a flow
    // list; the importer must still not crash and must still stamp provenance.
    expect(e.tags).toContain('source:vault');
    expect(e.tags).toContain('vault:v');
    expect(e.kind).toBe('raw');
  });
});

// ---------------------------------------------------------------------------
// (g) no crash on dialect syntax (all three fixtures)
// ---------------------------------------------------------------------------

describe('importVault (g) — dialect syntax does not crash', () => {
  it('imports Obsidian (^block-id, ![[embed]]) without error', () => {
    const r = importVault(path.join(FIXTURES, 'obsidian-sample'), opts({ name: 'obs' }));
    expect(r.imported).toBe(r.total);
    expect(r.total).toBeGreaterThan(0);
  });
  it('imports Foam (plain md) without error', () => {
    const r = importVault(path.join(FIXTURES, 'foam-sample'), opts({ name: 'foam' }));
    expect(r.imported).toBe(r.total);
    expect(r.total).toBeGreaterThan(0);
  });
  it('imports Dendron (dot-hierarchy filenames) without error', () => {
    const r = importVault(path.join(FIXTURES, 'dendron-sample'), opts({ name: 'den' }));
    expect(r.imported).toBe(r.total);
    expect(r.total).toBeGreaterThan(0);
    // Dot-hierarchy filename survives as a relpath-keyed artifactRef.
    const all = loadAllEntries(tmpDir, 'default');
    expect(all.some((e) => e.artifact_ref === 'vault:den:vault.note.child.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (h) tenant isolation
// ---------------------------------------------------------------------------

describe('importVault (h) — tenant isolation on deletion-sync', () => {
  it('a vault import in tenant A does not archive tenant B vault:<name> rows', () => {
    writeNote('shared.md', '# Shared\ntenant A+B both have this path');

    // Import the same vault name into two tenants.
    importVault(vaultDir, opts({ name: 'shared', tenantId: 'A' }));
    importVault(vaultDir, opts({ name: 'shared', tenantId: 'B' }));

    expect(loadAllEntries(tmpDir, 'A').length).toBe(1);
    expect(loadAllEntries(tmpDir, 'B').length).toBe(1);
    const bId = loadAllEntries(tmpDir, 'B')[0].id;

    // Now delete the file and re-import into tenant A only. Tenant B's row must
    // be untouched (the loader + deletion-sync are tenant-scoped).
    fs.rmSync(path.join(vaultDir, 'shared.md'));
    importVault(vaultDir, opts({ name: 'shared', tenantId: 'A' }));

    expect(loadAllEntries(tmpDir, 'A').length).toBe(0); // A's row archived
    const bAfter = loadAllEntries(tmpDir, 'B');
    expect(bAfter.length).toBe(1); // B untouched
    expect(bAfter[0].id).toBe(bId);

    // Exactly one archive (tenant A's), and it is not tenant B's id.
    const archived = archivedRows();
    expect(archived.length).toBe(1);
    expect(archived[0].memory_id).not.toBe(bId);
  });
});

// ---------------------------------------------------------------------------
// (i) LIKE-escape isolation
// ---------------------------------------------------------------------------

describe('importVault (i) — LIKE-escape isolation on vault name', () => {
  it('a vault named "a%" does not match/archive vault "ab" rows', () => {
    // Build vault "ab" with one note.
    writeNote('n.md', '# N\nab vault note');
    importVault(vaultDir, opts({ name: 'ab' }));
    const abId = loadAllEntries(tmpDir, 'default').find(
      (e) => e.artifact_ref === 'vault:ab:n.md',
    )!.id;

    // Build vault "a%" with its own note in a SEPARATE source folder.
    const otherVault = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-vault-pct-'));
    try {
      fs.writeFileSync(path.join(otherVault, 'm.md'), '# M\na-percent vault note', 'utf8');
      importVault(otherVault, opts({ name: 'a%' }));

      // Both vaults coexist: ab's row + a%'s row.
      const all = loadAllEntries(tmpDir, 'default');
      expect(all.some((e) => e.artifact_ref === 'vault:ab:n.md')).toBe(true);
      expect(all.some((e) => e.artifact_ref === 'vault:a%:m.md')).toBe(true);

      // Re-import "a%" with its file deleted. If the LIKE pattern were
      // unescaped, `vault:a%:%` would match `vault:ab:n.md` and archive it.
      fs.rmSync(path.join(otherVault, 'm.md'));
      importVault(otherVault, opts({ name: 'a%' }));

      const after = loadAllEntries(tmpDir, 'default');
      // ab's row survives (escape worked); a%'s row archived.
      const abLive = after.find((e) => e.id === abId);
      expect(abLive).toBeDefined();
      expect(abLive!.artifact_ref).toBe('vault:ab:n.md');
      expect(after.some((e) => e.artifact_ref === 'vault:a%:m.md')).toBe(false);

      const archived = archivedRows();
      expect(archived.length).toBe(1);
      expect(archived[0].memory_id).not.toBe(abId);
      expect(archived[0].reason).toMatch(/^source_deleted:vault:a%:m\.md$/);
    } finally {
      fs.rmSync(otherVault, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (j)(k) codex P2 — empty/frontmatter-only notes skipped, not thrown
// ---------------------------------------------------------------------------

describe('importVault (j) — empty/frontmatter-only notes are skipped, not thrown', () => {
  it('skips an empty note and a frontmatter-only note, still imports the real one', () => {
    writeNote('empty.md', '');
    writeNote('fm-only.md', '---\ntags: [x]\n---\n');
    writeNote('real.md', 'A genuine note body with enough content.');
    const result = importVault(vaultDir, opts({ name: 'v' }));
    expect(result.total).toBe(3);
    expect(result.imported).toBe(1); // only real.md
    expect(result.skipped).toBe(2); // empty + fm-only
    const raw = loadAllEntries(tmpDir).filter((e) => e.tags.includes('vault:v'));
    expect(raw.length).toBe(1);
    expect(raw[0].content).toContain('genuine note body');
  });
});

describe('importVault (k) — a note changed to empty keeps its prior memory (no mid-run archive)', () => {
  it('does not archive the prior raw row when a note becomes empty', () => {
    writeNote('note.md', 'Original content that is long enough.');
    importVault(vaultDir, opts({ name: 'v' }));
    const before = loadAllEntries(tmpDir).filter((e) => e.tags.includes('vault:v'));
    expect(before.length).toBe(1);
    const originalId = before[0].id;
    writeNote('note.md', '---\ntags: [y]\n---\n'); // body becomes empty
    const result = importVault(vaultDir, opts({ name: 'v' }));
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
    const after = loadAllEntries(tmpDir).filter((e) => e.tags.includes('vault:v'));
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(originalId); // prior kept, not archived
    expect(archivedRows().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (l)(m)(n) codex R2 — case-sensitive prefix, dryRun, block-style frontmatter
// ---------------------------------------------------------------------------

describe('importVault (l) — case-differing vault name does not archive the other vault', () => {
  it('vault A does not archive vault a rows (LIKE is case-insensitive; exact-prefix filter)', () => {
    writeNote('m.md', 'content for vault a note, long enough');
    importVault(vaultDir, opts({ name: 'a' }));
    const aRows = loadAllEntries(tmpDir).filter((e) => e.tags.includes('vault:a'));
    expect(aRows.length).toBe(1);
    const aId = aRows[0].id;
    const upperVault = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-vault-A-'));
    try {
      fs.writeFileSync(path.join(upperVault, 'x.md'), 'content for vault A note, long enough', 'utf8');
      importVault(upperVault, opts({ name: 'A' }));
      expect(loadAllEntries(tmpDir).filter((e) => e.id === aId).length).toBe(1); // 'a' untouched
      expect(archivedRows().length).toBe(0);
    } finally {
      fs.rmSync(upperVault, { recursive: true, force: true });
    }
  });
});

describe('importVault (m) — dryRun previews without mutating', () => {
  it('dryRun counts imports but writes nothing', () => {
    writeNote('m.md', 'a real note body, long enough to store');
    const result = importVault(vaultDir, opts({ name: 'v', dryRun: true }));
    expect(result.total).toBe(1);
    expect(result.imported).toBe(1); // preview counts it
    expect(loadAllEntries(tmpDir).filter((e) => e.tags.includes('vault:v')).length).toBe(0); // nothing written
  });
});

describe('importVault (n) — block-style frontmatter lists are parsed', () => {
  it('maps tags + aliases written as indented `- item` lists', () => {
    writeNote('n.md', '---\ntags:\n  - project\n  - urgent\naliases:\n  - Nickname\n---\nBody content here, long enough.');
    importVault(vaultDir, opts({ name: 'v' }));
    const row = loadAllEntries(tmpDir).filter((e) => e.tags.includes('vault:v'))[0];
    expect(row.tags).toContain('project');
    expect(row.tags).toContain('urgent');
    expect(row.tags).toContain('alias:Nickname');
  });
});

describe('importVault (o) — rejects a vault name containing the ":" delimiter', () => {
  it('throws on a name with ":" so it cannot over-match another vault prefix', () => {
    writeNote('m.md', 'some content long enough to store');
    expect(() => importVault(vaultDir, opts({ name: 'a:b' }))).toThrow(/must not contain/);
  });
});

describe('importVault (p) — rejects global mode', () => {
  it('throws on global:true (raw rows are tenant-local)', () => {
    writeNote('m.md', 'content long enough to store here');
    expect(() => importVault(vaultDir, opts({ name: 'v', global: true }))).toThrow(/global/);
  });
});

describe('importVault (q) — dryRun previews deletions without archiving', () => {
  it('counts would-be archives for a removed note without archiving it', () => {
    writeNote('keep.md', 'keep this note, long enough to store');
    writeNote('gone.md', 'this note will be removed, long enough');
    importVault(vaultDir, opts({ name: 'v' }));
    expect(loadAllEntries(tmpDir).filter((e) => e.tags.includes('vault:v')).length).toBe(2);
    fs.rmSync(path.join(vaultDir, 'gone.md'));
    const result = importVault(vaultDir, opts({ name: 'v', dryRun: true }));
    expect(result.archived).toBe(1); // would archive the removed note
    expect(archivedRows().length).toBe(0); // but nothing actually archived
    expect(loadAllEntries(tmpDir).filter((e) => e.tags.includes('vault:v')).length).toBe(2); // both still live
  });
});

describe('importVault (r) — does not import the Hippo store mirror files (codex R5 P1)', () => {
  it('skips .hippo / dot-dirs when the vault contains the store', () => {
    writeNote('real-note.md', 'a genuine vault note, long enough to store');
    // markdown mirror file inside a .hippo store dir under the vault
    fs.mkdirSync(path.join(vaultDir, '.hippo', 'episodic'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, '.hippo', 'episodic', 'mirror.md'), 'self-import mirror content must not be ingested', 'utf8');
    // and a .git internal markdown
    fs.mkdirSync(path.join(vaultDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, '.git', 'COMMIT_NOTE.md'), 'git internal not a note', 'utf8');
    const result = importVault(vaultDir, opts({ name: 'v' }));
    expect(result.total).toBe(1); // only real-note.md
    expect(result.imported).toBe(1);
    const rows = loadAllEntries(tmpDir).filter((e) => e.tags.includes('vault:v'));
    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain('genuine vault note');
  });
});

describe('importVault (s) — vault root IS the store imports nothing (codex R6 P2)', () => {
  it('returns empty when folderPath resolves to hippoRoot', () => {
    fs.mkdirSync(path.join(tmpDir, 'episodic'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'episodic', 'mirror.md'), 'store mirror content here', 'utf8');
    const result = importVault(tmpDir, opts({ name: 'v' })); // folderPath === hippoRoot
    expect(result.total).toBe(0);
    expect(result.imported).toBe(0);
  });
});
