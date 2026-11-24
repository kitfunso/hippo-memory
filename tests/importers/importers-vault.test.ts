import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { importVault } from '../../src/entry/importers.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import {
  tmpDir,
  vaultDir,
  FIXTURES,
  useVaultImport,
  writeNote,
  opts,
  archivedRows,
} from '../_helpers/importers-vault.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

sessionPerTest();

useVaultImport();

describe('importVault (a) — fixture vault → kind=raw with source:vault tags', () => {
  it('imports ≥95% of obsidian fixture notes as raw with provenance tags', async () => {
    const result = await importVault(path.join(FIXTURES, 'obsidian-sample'), opts({ name: 'obs' }));
    expect(result.total).toBeGreaterThanOrEqual(3);
    expect(result.imported).toBe(result.total);
    expect(result.skipped).toBe(0);

    const all = loadAllEntries(tmpDir, 'default');
    expect(all.length).toBe(result.total);
    const raws = all.filter((e) => e.kind === 'raw');
    const provenanced = raws.filter((e) => e.tags.includes('source:vault') && e.tags.includes('vault:obs'));
    expect(provenanced.length / all.length).toBeGreaterThanOrEqual(0.95);
    for (const e of all) {
      expect(e.artifactRef).toMatch(/^vault:obs:/);
      expect(e.owner).toBe('agent:vault-import');
    }
  });
});

describe('importVault (b) — re-import is idempotent', () => {
  it('produces 0 dups and all-skipped on unchanged re-import', async () => {
    writeNote('a.md', '# A\nbody a [[b]]');
    writeNote('b.md', '---\ntags: [t1]\n---\n# B\nbody b');

    const first = await importVault(vaultDir, opts({ name: 'v' }));
    expect(first.imported).toBe(2);
    expect(first.skipped).toBe(0);

    const second = await importVault(vaultDir, opts({ name: 'v' }));
    expect(second.total).toBe(2);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);

    const all = loadAllEntries(tmpDir, 'default');
    expect(all.length).toBe(2);
    expect(archivedRows().length).toBe(0);
  });
});

describe('importVault (c) — changed file archives old + appends new raw', () => {
  it('archives the old raw row and writes a new kind=raw with source:vault', async () => {
    writeNote('note.md', '# Note\noriginal content');
    const first = await importVault(vaultDir, opts({ name: 'v' }));
    expect(first.imported).toBe(1);
    const originalId = loadAllEntries(tmpDir, 'default')[0].id;

    writeNote('note.md', '# Note\nCHANGED content');
    const second = await importVault(vaultDir, opts({ name: 'v' }));
    expect(second.imported).toBe(1);
    expect(second.skipped).toBe(0);

    const all = loadAllEntries(tmpDir, 'default');
    expect(all.length).toBe(1);
    const live = all[0];
    expect(live.id).not.toBe(originalId);
    expect(live.kind).toBe('raw');
    expect(live.tags).toContain('source:vault');
    expect(live.content).toContain('CHANGED');

    const archived = archivedRows();
    expect(archived.length).toBe(1);
    expect(archived[0].memory_id).toBe(originalId);
    expect(archived[0].reason).toMatch(/^changed:vault:v:note\.md$/);
  });
});

describe('importVault (d) — deleted source file archives the raw row', () => {
  it('archives the orphaned raw row on deletion-sync', async () => {
    writeNote('keep.md', '# Keep\nstays');
    writeNote('drop.md', '# Drop\ngoes away');
    const first = await importVault(vaultDir, opts({ name: 'v' }));
    expect(first.imported).toBe(2);

    const dropId = loadAllEntries(tmpDir, 'default').find((e) => e.artifactRef === 'vault:v:drop.md')!.id;

    fs.rmSync(path.join(vaultDir, 'drop.md'));
    const second = await importVault(vaultDir, opts({ name: 'v' }));
    expect(second.total).toBe(1);
    expect(second.skipped).toBe(1);

    const all = loadAllEntries(tmpDir, 'default');
    expect(all.length).toBe(1);
    expect(all[0].artifactRef).toBe('vault:v:keep.md');

    const archived = archivedRows();
    expect(archived.length).toBe(1);
    expect(archived[0].memory_id).toBe(dropId);
    expect(archived[0].reason).toMatch(/^source_deleted:vault:v:drop\.md$/);
  });
});

describe('importVault (e) — wikilinks become wikilink-candidate tags', () => {
  it('maps [[target]] and [[target|alias]] to wikilink-candidate:<target>', async () => {
    writeNote('w.md', '# W\nlinks [[plain-target]] and [[real|Display Alias]] and dup [[plain-target]]');
    await importVault(vaultDir, opts({ name: 'v' }));

    const e = loadAllEntries(tmpDir, 'default')[0];
    expect(e.tags).toContain('wikilink-candidate:plain-target');
    expect(e.tags).toContain('wikilink-candidate:real');
    expect(e.tags).not.toContain('wikilink-candidate:Display Alias');

    const uniq = new Set(e.tags);
    expect(uniq.size).toBe(e.tags.length);
    const wlCount = e.tags.filter((t) => t === 'wikilink-candidate:plain-target').length;
    expect(wlCount).toBe(1);
    expect(e.tags).toEqual(
      expect.arrayContaining(['source:vault', 'vault:v', 'wikilink-candidate:plain-target', 'wikilink-candidate:real']),
    );
  });
});

describe('importVault (f) — frontmatter tags and aliases map to tags', () => {
  it('maps flow-list + block-list tags and aliases (alias:<x>) with no dup surprises', async () => {
    writeNote('fm.md', '---\ntags: [alpha, beta]\naliases: [Nick, Other]\n---\n# FM\nbody no links');
    await importVault(vaultDir, opts({ name: 'v' }));
    const e = loadAllEntries(tmpDir, 'default')[0];

    expect(e.tags).toContain('alpha');
    expect(e.tags).toContain('beta');
    expect(e.tags).toContain('alias:Nick');
    expect(e.tags).toContain('alias:Other');
    expect(e.tags).toContain('source:vault');
    expect(e.tags).toContain('vault:v');

    const uniq = new Set(e.tags);
    expect(uniq.size).toBe(e.tags.length);
    const nonHash = e.tags.filter((t) => !t.startsWith('content-hash:')).sort();
    expect(nonHash).toEqual(['alias:Nick', 'alias:Other', 'alpha', 'beta', 'source:vault', 'vault:v'].sort());
  });

  it('parses block-style (indented dash) frontmatter tag lists', async () => {
    writeNote('fm2.md', '---\ntags:\n  - one\n  - two\n---\n# FM2\nbody');
    await importVault(vaultDir, opts({ name: 'v' }));
    const e = loadAllEntries(tmpDir, 'default')[0];
    expect(e.tags).toContain('source:vault');
    expect(e.tags).toContain('vault:v');
    expect(e.kind).toBe('raw');
  });
});

describe('importVault (g) — dialect syntax does not crash', () => {
  it('imports Obsidian (^block-id, ![[embed]]) without error', async () => {
    const r = await importVault(path.join(FIXTURES, 'obsidian-sample'), opts({ name: 'obs' }));
    expect(r.imported).toBe(r.total);
    expect(r.total).toBe(3);
  });
  it('imports Foam (plain md) without error', async () => {
    const r = await importVault(path.join(FIXTURES, 'foam-sample'), opts({ name: 'foam' }));
    expect(r.imported).toBe(r.total);
    expect(r.total).toBe(3);
  });
  it('imports Dendron (dot-hierarchy filenames) without error', async () => {
    const r = await importVault(path.join(FIXTURES, 'dendron-sample'), opts({ name: 'den' }));
    expect(r.imported).toBe(r.total);
    expect(r.total).toBe(2);
    const all = loadAllEntries(tmpDir, 'default');
    expect(all.some((e) => e.artifactRef === 'vault:den:vault.note.child.md')).toBe(true);
  });
});
