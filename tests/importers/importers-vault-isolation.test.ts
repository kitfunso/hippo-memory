// K1 vault importer: tenant and vault-name isolation, skipped and emptied notes, dry runs and rejected names (tests h-s).
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { importVault } from '../../src/entry/importers.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { tmpDir, vaultDir, useVaultImport, writeNote, opts, archivedRows } from '../_helpers/importers-vault.js';

useVaultImport();

// ---------------------------------------------------------------------------
// (h) tenant isolation
// ---------------------------------------------------------------------------

describe('importVault (h) — tenant isolation on deletion-sync', () => {
  it('a vault import in tenant A does not archive tenant B vault:<name> rows', async () => {
    writeNote('shared.md', '# Shared\ntenant A+B both have this path');

    // Import the same vault name into two tenants.
    await importVault(vaultDir, opts({ name: 'shared', tenantId: 'A' }));
    await importVault(vaultDir, opts({ name: 'shared', tenantId: 'B' }));

    expect(loadAllEntries(tmpDir, 'A').length).toBe(1);
    expect(loadAllEntries(tmpDir, 'B').length).toBe(1);
    const bId = loadAllEntries(tmpDir, 'B')[0].id;

    // Now delete the file and re-import into tenant A only. Tenant B's row must
    // be untouched (the loader + deletion-sync are tenant-scoped).
    fs.rmSync(path.join(vaultDir, 'shared.md'));
    await importVault(vaultDir, opts({ name: 'shared', tenantId: 'A' }));

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
  it('a vault named "a%" does not match/archive vault "ab" rows', async () => {
    // Build vault "ab" with one note.
    writeNote('n.md', '# N\nab vault note');
    await importVault(vaultDir, opts({ name: 'ab' }));
    const abId = loadAllEntries(tmpDir, 'default').find((e) => e.artifactRef === 'vault:ab:n.md')!.id;

    // Build vault "a%" with its own note in a SEPARATE source folder.
    const otherVault = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-vault-pct-'));
    try {
      fs.writeFileSync(path.join(otherVault, 'm.md'), '# M\na-percent vault note', 'utf8');
      await importVault(otherVault, opts({ name: 'a%' }));

      // Both vaults coexist: ab's row + a%'s row.
      const all = loadAllEntries(tmpDir, 'default');
      expect(all.some((e) => e.artifactRef === 'vault:ab:n.md')).toBe(true);
      expect(all.some((e) => e.artifactRef === 'vault:a%:m.md')).toBe(true);

      // Re-import "a%" with its file deleted. If the LIKE pattern were
      // unescaped, `vault:a%:%` would match `vault:ab:n.md` and archive it.
      fs.rmSync(path.join(otherVault, 'm.md'));
      await importVault(otherVault, opts({ name: 'a%' }));

      const after = loadAllEntries(tmpDir, 'default');
      // ab's row survives (escape worked); a%'s row archived.
      const abLive = after.find((e) => e.id === abId);
      expect(abLive).toBeDefined();
      expect(abLive!.artifactRef).toBe('vault:ab:n.md');
      expect(after.some((e) => e.artifactRef === 'vault:a%:m.md')).toBe(false);

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
  it('skips an empty note and a frontmatter-only note, still imports the real one', async () => {
    writeNote('empty.md', '');
    writeNote('fm-only.md', '---\ntags: [x]\n---\n');
    writeNote('real.md', 'A genuine note body with enough content.');
    const result = await importVault(vaultDir, opts({ name: 'v' }));
    expect(result.total).toBe(3);
    expect(result.imported).toBe(1); // only real.md
    expect(result.skipped).toBe(2); // empty + fm-only
    const raw = loadAllEntries(tmpDir, 'default').filter((e) => e.tags.includes('vault:v'));
    expect(raw.length).toBe(1);
    expect(raw[0].content).toContain('genuine note body');
  });
});

describe('importVault (k) — a note emptied at source archives its prior memory', () => {
  it('archives the prior raw row when a note becomes frontmatter-only (no stale body left live)', async () => {
    writeNote('note.md', 'Original content that is long enough.');
    await importVault(vaultDir, opts({ name: 'v' }));
    const before = loadAllEntries(tmpDir, 'default').filter((e) => e.tags.includes('vault:v'));
    expect(before.length).toBe(1);
    const originalId = before[0].id;
    writeNote('note.md', '---\ntags: [y]\n---\n'); // body becomes empty (frontmatter-only)
    const result = await importVault(vaultDir, opts({ name: 'v' }));
    expect(result.skipped).toBe(1); // nothing storable -> no new write
    expect(result.imported).toBe(0);
    expect(result.archived).toBe(1); // but the stale prior IS archived (codex R12 P2)
    const after = loadAllEntries(tmpDir, 'default').filter((e) => e.tags.includes('vault:v'));
    expect(after.length).toBe(0); // prior gone; the deleted body is not left searchable
    const archived = archivedRows();
    expect(archived.length).toBe(1);
    expect(archived[0].memory_id).toBe(originalId);
    expect(archived[0].reason).toBe('emptied:vault:v:note.md');
  });
});

// ---------------------------------------------------------------------------
// (l)(m)(n) codex R2 — case-sensitive prefix, dryRun, block-style frontmatter
// ---------------------------------------------------------------------------

describe('importVault (l) — case-differing vault name does not archive the other vault', () => {
  it('vault A does not archive vault a rows (LIKE is case-insensitive; exact-prefix filter)', async () => {
    writeNote('m.md', 'content for vault a note, long enough');
    await importVault(vaultDir, opts({ name: 'a' }));
    const aRows = loadAllEntries(tmpDir, 'default').filter((e) => e.tags.includes('vault:a'));
    expect(aRows.length).toBe(1);
    const aId = aRows[0].id;
    const upperVault = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-vault-A-'));
    try {
      fs.writeFileSync(path.join(upperVault, 'x.md'), 'content for vault A note, long enough', 'utf8');
      await importVault(upperVault, opts({ name: 'A' }));
      expect(loadAllEntries(tmpDir, 'default').filter((e) => e.id === aId).length).toBe(1); // 'a' untouched
      expect(archivedRows().length).toBe(0);
    } finally {
      fs.rmSync(upperVault, { recursive: true, force: true });
    }
  });
});

describe('importVault (m) — dryRun previews without mutating', () => {
  it('dryRun counts imports but writes nothing', async () => {
    writeNote('m.md', 'a real note body, long enough to store');
    const result = await importVault(vaultDir, opts({ name: 'v', dryRun: true }));
    expect(result.total).toBe(1);
    expect(result.imported).toBe(1); // preview counts it
    expect(loadAllEntries(tmpDir, 'default').filter((e) => e.tags.includes('vault:v')).length).toBe(0); // nothing written
  });
});

describe('importVault (n) — block-style frontmatter lists are parsed', () => {
  it('maps tags + aliases written as indented `- item` lists', async () => {
    writeNote(
      'n.md',
      '---\ntags:\n  - project\n  - urgent\naliases:\n  - Nickname\n---\nBody content here, long enough.',
    );
    await importVault(vaultDir, opts({ name: 'v' }));
    const row = loadAllEntries(tmpDir, 'default').filter((e) => e.tags.includes('vault:v'))[0];
    expect(row.tags).toContain('project');
    expect(row.tags).toContain('urgent');
    expect(row.tags).toContain('alias:Nickname');
  });
});

describe('importVault (o) — rejects a vault name containing the ":" delimiter', () => {
  it('throws on a name with ":" so it cannot over-match another vault prefix', async () => {
    writeNote('m.md', 'some content long enough to store');
    await expect(importVault(vaultDir, opts({ name: 'a:b' }))).rejects.toThrow(/must not contain/);
  });
});

describe('importVault (p) — rejects global mode', () => {
  it('throws on global:true (raw rows are tenant-local)', async () => {
    writeNote('m.md', 'content long enough to store here');
    await expect(importVault(vaultDir, opts({ name: 'v', global: true }))).rejects.toThrow(/global/);
  });
});

describe('importVault (q) — dryRun previews deletions without archiving', () => {
  it('counts would-be archives for a removed note without archiving it', async () => {
    writeNote('keep.md', 'keep this note, long enough to store');
    writeNote('gone.md', 'this note will be removed, long enough');
    await importVault(vaultDir, opts({ name: 'v' }));
    expect(loadAllEntries(tmpDir, 'default').filter((e) => e.tags.includes('vault:v')).length).toBe(2);
    fs.rmSync(path.join(vaultDir, 'gone.md'));
    const result = await importVault(vaultDir, opts({ name: 'v', dryRun: true }));
    expect(result.archived).toBe(1); // would archive the removed note
    expect(archivedRows().length).toBe(0); // but nothing actually archived
    expect(loadAllEntries(tmpDir, 'default').filter((e) => e.tags.includes('vault:v')).length).toBe(2); // both still live
  });
});

describe('importVault (r): does not import the Hippo store mirror files', () => {
  it('skips .hippo / dot-dirs when the vault contains the store', async () => {
    writeNote('real-note.md', 'a genuine vault note, long enough to store');
    // markdown mirror file inside a .hippo store dir under the vault
    fs.mkdirSync(path.join(vaultDir, '.hippo', 'episodic'), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, '.hippo', 'episodic', 'mirror.md'),
      'self-import mirror content must not be ingested',
      'utf8',
    );
    // and a .git internal markdown
    fs.mkdirSync(path.join(vaultDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, '.git', 'COMMIT_NOTE.md'), 'git internal not a note', 'utf8');
    const result = await importVault(vaultDir, opts({ name: 'v' }));
    expect(result.total).toBe(1); // only real-note.md
    expect(result.imported).toBe(1);
    const rows = loadAllEntries(tmpDir, 'default').filter((e) => e.tags.includes('vault:v'));
    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain('genuine vault note');
  });
});

describe('importVault (s): vault root IS the store imports nothing', () => {
  it('returns empty when folderPath resolves to hippoRoot', async () => {
    fs.mkdirSync(path.join(tmpDir, 'episodic'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'episodic', 'mirror.md'), 'store mirror content here', 'utf8');
    const result = await importVault(tmpDir, opts({ name: 'v' })); // folderPath === hippoRoot
    expect(result.total).toBe(0);
    expect(result.imported).toBe(0);
  });
});
