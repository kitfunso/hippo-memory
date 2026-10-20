// K1 vault importer: duplicate raw rows, importing the store path, nested stores and envelope-aware idempotency (tests t-x).
import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'node:crypto';
import { importVault } from '../../src/entry/importers.js';
import { remember } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { tmpDir, vaultDir, useVaultImport, writeNote, opts, archivedRows } from '../_helpers/importers-vault.js';

useVaultImport();

// ---------------------------------------------------------------------------
// (t) duplicate live raw rows for one artifactRef → archive ALL on change/delete
//     (codex R7 P2). The importer is not re-entrant: two concurrent runs can each
//     see a note as absent and double-insert. A later changed/deletion pass must
//     archive EVERY matching row, not just the last one scanned.
// ---------------------------------------------------------------------------

const vaultCtx = (): FullContext => apiCtx(tmpDir, 'default', { subject: 'connector:vault', role: 'admin' });

/** Inject a SECOND live raw row sharing dup.md's artifactRef + content-hash,
 *  exactly as a concurrent importVault run would. Returns both live row ids. */
async function seedDuplicateRawRow(): Promise<string[]> {
  const raw = fs.readFileSync(path.join(vaultDir, 'dup.md'), 'utf8');
  const hash = createHash('sha256').update(raw).digest('hex');
  await remember(vaultCtx(), {
    content: raw, // no frontmatter in the fixture, so body === raw
    kind: 'raw',
    artifactRef: 'vault:v:dup.md',
    owner: 'agent:vault-import',
    tags: ['source:vault', 'vault:v', `content-hash:${hash}`],
  });
  const ids = loadAllEntries(tmpDir, 'default')
    .filter((e) => e.artifactRef === 'vault:v:dup.md')
    .map((e) => e.id);
  expect(ids.length).toBe(2); // precondition: two live rows for one ref
  return ids;
}

describe('importVault (t) — duplicate raw rows for one artifactRef archive ALL', () => {
  it('archives BOTH duplicates when the source file changes (not just the last)', async () => {
    writeNote('dup.md', '# Dup\noriginal content');
    expect((await importVault(vaultDir, opts({ name: 'v' }))).imported).toBe(1);
    const dupIds = await seedDuplicateRawRow();

    writeNote('dup.md', '# Dup\nCHANGED content');
    const second = await importVault(vaultDir, opts({ name: 'v' }));
    expect(second.imported).toBe(1); // one new raw appended
    expect(second.archived).toBe(2); // BOTH old rows archived, not one

    const live = loadAllEntries(tmpDir, 'default');
    expect(live.length).toBe(1); // exactly one live row remains
    expect(live[0].content).toContain('CHANGED');
    expect(dupIds).not.toContain(live[0].id);

    const archived = archivedRows();
    expect(archived.length).toBe(2);
    expect(new Set(archived.map((a) => a.memory_id))).toEqual(new Set(dupIds));
    for (const a of archived) expect(a.reason).toBe('changed:vault:v:dup.md');
  });

  it('archives BOTH duplicates when the source file is deleted (not just the last)', async () => {
    writeNote('dup.md', '# Dup\noriginal content');
    expect((await importVault(vaultDir, opts({ name: 'v' }))).imported).toBe(1);
    const dupIds = await seedDuplicateRawRow();

    fs.rmSync(path.join(vaultDir, 'dup.md'));
    const second = await importVault(vaultDir, opts({ name: 'v' }));
    expect(second.total).toBe(0); // vault now empty
    expect(second.archived).toBe(2); // BOTH rows archived on deletion-sync

    const live = loadAllEntries(tmpDir, 'default').filter((e) => e.artifactRef === 'vault:v:dup.md');
    expect(live.length).toBe(0);

    const archived = archivedRows();
    expect(archived.length).toBe(2);
    expect(new Set(archived.map((a) => a.memory_id))).toEqual(new Set(dupIds));
    for (const a of archived) expect(a.reason).toBe('source_deleted:vault:v:dup.md');
  });

  it('skips cleanly when duplicates all carry the current hash (unchanged re-import)', async () => {
    writeNote('dup.md', '# Dup\noriginal content');
    expect((await importVault(vaultDir, opts({ name: 'v' }))).imported).toBe(1);
    await seedDuplicateRawRow();

    // Unchanged re-import: every live row already carries the current content-hash,
    // so the file is skipped and NO archive fires (duplicates are identical content,
    // not stale; codex P2 is about stale content after change/delete, not redundancy).
    const second = await importVault(vaultDir, opts({ name: 'v' }));
    expect(second.skipped).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.archived).toBe(0);
    expect(archivedRows().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (u) importing the store path is a no-op, NOT a mass-archive of live rows
//     (codex R8 P1). The self-store guard returns an empty file scan; without
//     a control-flow short-circuit, deletion-sync reads "empty scan" as "all
//     notes deleted" and irreversibly archives every live vault:<name>:* row.
// ---------------------------------------------------------------------------

describe('importVault (u) — importing the store path preserves existing vault rows', () => {
  it('does not archive live rows when folderPath resolves to the store (with rows present)', async () => {
    // A real import first, so live vault rows exist to be (wrongly) archived.
    writeNote('keep.md', '# Keep\na genuine vault note worth keeping');
    expect((await importVault(vaultDir, opts({ name: 'v' }))).imported).toBe(1);
    const before = loadAllEntries(tmpDir, 'default').filter((e) => e.artifactRef?.startsWith('vault:v:'));
    expect(before.length).toBe(1);

    // Now point the importer at the STORE itself. This must be a no-op, NOT a
    // deletion-sync that archives every live row because the scan found nothing.
    const selfImport = await importVault(tmpDir, opts({ name: 'v' }));
    expect(selfImport.total).toBe(0);
    expect(selfImport.imported).toBe(0);
    expect(selfImport.archived).toBe(0); // the regression guard

    const after = loadAllEntries(tmpDir, 'default').filter((e) => e.artifactRef?.startsWith('vault:v:'));
    expect(after.length).toBe(1); // row survived
    expect(after[0].id).toBe(before[0].id);
    expect(archivedRows().length).toBe(0); // nothing archived at all
  });

  it('is a no-op for a child of the store too (nested store path)', async () => {
    writeNote('keep.md', '# Keep\nanother genuine vault note');
    expect((await importVault(vaultDir, opts({ name: 'v' }))).imported).toBe(1);

    // A subdirectory INSIDE the store resolves under hippoRoot → same guard.
    const childOfStore = path.join(tmpDir, 'episodic');
    fs.mkdirSync(childOfStore, { recursive: true });
    const selfImport = await importVault(childOfStore, opts({ name: 'v' }));
    expect(selfImport.total).toBe(0);
    expect(selfImport.archived).toBe(0);
    expect(loadAllEntries(tmpDir, 'default').filter((e) => e.artifactRef?.startsWith('vault:v:')).length).toBe(1);
    expect(archivedRows().length).toBe(0);
  });

  it('treats a junction/symlink to the store as self-store', async () => {
    writeNote('keep.md', '# Keep\na real note that must survive an aliased self-import');
    expect((await importVault(vaultDir, opts({ name: 'v' }))).imported).toBe(1);

    // An aliased path (junction on Windows, symlink on POSIX) pointing AT the
    // store. path.resolve(link) !== resolve(store) textually, so only a realpath
    // canonicalization recognizes it as self-store.
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-vault-link-'));
    const link = path.join(linkParent, 'store-alias');
    let created = true;
    try {
      fs.symlinkSync(tmpDir, link, 'junction');
    } catch {
      created = false; // no privilege / unsupported on this host -> can't assert
    }
    try {
      if (created) {
        const aliased = await importVault(link, opts({ name: 'v' }));
        expect(aliased.total).toBe(0);
        expect(aliased.archived).toBe(0); // the regression guard
        const live = loadAllEntries(tmpDir, 'default').filter((e) => e.artifactRef?.startsWith('vault:v:'));
        expect(live.length).toBe(1);
        expect(archivedRows().length).toBe(0);
      }
    } finally {
      // Remove ONLY the link (never recurse into the target store): unlink for a
      // POSIX symlink, rmdir for a Windows junction. Both are non-recursive.
      try {
        fs.unlinkSync(link);
      } catch {
        try {
          fs.rmdirSync(link);
        } catch {
          /* link already gone */
        }
      }
      try {
        fs.rmdirSync(linkParent);
      } catch {
        /* leave the empty temp dir for the OS to reap */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (w) a NON-dot store nested in the vault is skipped even when hippoRoot is an
//     aliased path (junction / Windows case variant). The R9 fix canonicalized
//     the importVault self-store guard but NOT this sibling walk-skip, so an
//     aliased hippoRoot let the walk descend into the store and self-import its
//     markdown mirror files (compensating-review P1, codex R9 follow-up).
// ---------------------------------------------------------------------------

describe('importVault (w) — nested non-dot store skipped under an aliased hippoRoot', () => {
  it('does not self-import store mirror files when hippoRoot is a junction to a nested store', async () => {
    // A non-dot store dir INSIDE the vault (the HIPPO_HOME-inside-vault config
    // the collectMarkdownFiles JSDoc claims to support).
    const realStore = path.join(vaultDir, 'Store');
    fs.mkdirSync(realStore, { recursive: true });

    // Reach that store via a junction, so path.resolve(alias) !== the on-disk
    // path (exactly like a case-variant HIPPO_HOME on Windows). Only realpath
    // canonicalizes the alias back to realStore.
    const aliasParent = makeRoot('vault-hr', { init: false });
    const hippoAlias = path.join(aliasParent, 'store-alias');
    let created = true;
    try {
      fs.symlinkSync(realStore, hippoAlias, 'junction');
    } catch {
      created = false; // no privilege / unsupported -> can't assert
    }
    try {
      if (created) {
        initTestStore(hippoAlias);
        // A mirror-like markdown file living inside the nested store.
        fs.mkdirSync(path.join(realStore, 'episodic'), { recursive: true });
        fs.writeFileSync(
          path.join(realStore, 'episodic', 'mirror.md'),
          'store mirror content that must NOT be self-imported as a vault note',
          'utf8',
        );
        writeNote('realnote.md', '# Real\na genuine vault note worth importing');

        const result = await importVault(vaultDir, {
          hippoRoot: hippoAlias,
          tenantId: 'default',
          name: 'v',
        });
        // Only the real note imports; the nested store's mirror file is skipped.
        expect(result.total).toBe(1);
        expect(result.imported).toBe(1);
        const rows = loadAllEntries(hippoAlias, 'default').filter((e) => e.tags.includes('vault:v'));
        expect(rows.length).toBe(1);
        expect(rows[0].artifactRef).toBe('vault:v:realnote.md');
        expect(rows.some((e) => (e.artifactRef ?? '').includes('Store/'))).toBe(false);
      }
    } finally {
      // Remove ONLY the junction link, never recurse into realStore (which lives
      // under vaultDir and is cleaned by afterEach).
      try {
        fs.unlinkSync(hippoAlias);
      } catch {
        try {
          fs.rmdirSync(hippoAlias);
        } catch {
          /* link already gone */
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (x) explicit vault name is required (no path-basename default), and a re-import
//     that changes the ENVELOPE (--scope / extra tags) re-writes rather than
//     skipping on content-hash alone (codex R10 P2 x2).
// ---------------------------------------------------------------------------

describe('importVault (x) — explicit name + envelope-aware idempotency', () => {
  it('throws when no vault name is given (no basename default that could collide)', async () => {
    writeNote('a.md', '# A\nbody content long enough to store');
    await expect(importVault(vaultDir, { hippoRoot: tmpDir, tenantId: 'default' })).rejects.toThrow(
      /explicit vault name/,
    );
    // A blank/whitespace name is rejected the same way.
    await expect(importVault(vaultDir, opts({ name: '   ' }))).rejects.toThrow(/explicit vault name/);
  });

  it('re-imports an unchanged file when --scope changes (archive old + new scoped row)', async () => {
    writeNote('note.md', '# Note\nstable content across the scope change');
    expect((await importVault(vaultDir, opts({ name: 'v' }))).imported).toBe(1); // unscoped
    const firstId = loadAllEntries(tmpDir, 'default')[0].id;
    expect(loadAllEntries(tmpDir, 'default')[0].scope ?? null).toBe(null);

    // Same bytes, now request a (properly source-prefixed) private scope -> re-write.
    const second = await importVault(vaultDir, opts({ name: 'v', scope: 'vault:private:v' }));
    expect(second.skipped).toBe(0);
    expect(second.imported).toBe(1);
    expect(second.archived).toBe(1);

    const live = loadAllEntries(tmpDir, 'default');
    expect(live.length).toBe(1);
    expect(live[0].id).not.toBe(firstId);
    expect(live[0].scope).toBe('vault:private:v'); // the requested envelope was applied

    // A third identical run at the SAME scope is idempotent again.
    const third = await importVault(vaultDir, opts({ name: 'v', scope: 'vault:private:v' }));
    expect(third.skipped).toBe(1);
    expect(third.imported).toBe(0);
    expect(third.archived).toBe(0);
  });

  it('rejects a bare-private scope recall would not treat as private', async () => {
    writeNote('note.md', '# Note\nsensitive content the user wants private');
    // Bare `private` / `private:<x>` are NOT default-denied by recall, so reject
    // them rather than store public-visible "private" notes.
    await expect(importVault(vaultDir, opts({ name: 'v', scope: 'private' }))).rejects.toThrow(
      /not recognized as private/,
    );
    await expect(importVault(vaultDir, opts({ name: 'v', scope: 'private:secret' }))).rejects.toThrow(
      /not recognized as private/,
    );
    // Nothing was written by the rejected runs; the source-prefixed form is accepted.
    expect(loadAllEntries(tmpDir, 'default').length).toBe(0);
    const ok = await importVault(vaultDir, opts({ name: 'v', scope: 'vault:private:v' }));
    expect(ok.imported).toBe(1);
    expect(loadAllEntries(tmpDir, 'default')[0].scope).toBe('vault:private:v');
  });

  it('re-imports an unchanged file when an extra tag is added', async () => {
    writeNote('note.md', '# Note\nstable content across the tag change');
    expect((await importVault(vaultDir, opts({ name: 'v' }))).imported).toBe(1);

    const second = await importVault(vaultDir, opts({ name: 'v', extraTags: ['campaign:q3'] }));
    expect(second.imported).toBe(1);
    expect(second.archived).toBe(1);
    const live = loadAllEntries(tmpDir, 'default');
    expect(live.length).toBe(1);
    expect(live[0].tags).toContain('campaign:q3');
  });

  it('re-imports an unchanged file when an extra tag is REMOVED', async () => {
    writeNote('note.md', '# Note\nstable content across the tag removal');
    expect((await importVault(vaultDir, opts({ name: 'v', extraTags: ['campaign:q3'] }))).imported).toBe(1);
    expect(loadAllEntries(tmpDir, 'default')[0].tags).toContain('campaign:q3');

    // Re-import the SAME bytes WITHOUT the extra tag: a subset check would skip
    // (vacuously true) and leave the stale tag live; the full-set check treats the
    // removal as an envelope change and re-writes.
    const second = await importVault(vaultDir, opts({ name: 'v' }));
    expect(second.skipped).toBe(0);
    expect(second.imported).toBe(1);
    expect(second.archived).toBe(1);
    const live = loadAllEntries(tmpDir, 'default');
    expect(live.length).toBe(1);
    expect(live[0].tags).not.toContain('campaign:q3'); // stale tag gone
  });

  it('two same-basename vaults stay isolated under distinct explicit names', async () => {
    // Distinct names -> distinct vault:<name>:* prefixes -> deletion-sync of one
    // never touches the other (the failure mode the basename default caused).
    writeNote('shared.md', '# Work\nwork note body content');
    expect((await importVault(vaultDir, opts({ name: 'work' }))).imported).toBe(1);

    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-vault-src2-'));
    try {
      fs.writeFileSync(path.join(other, 'shared.md'), '# Personal\npersonal note body', 'utf8');
      const second = await importVault(other, opts({ name: 'personal' }));
      expect(second.imported).toBe(1);
      expect(second.archived).toBe(0); // did NOT archive the work vault's row

      const all = loadAllEntries(tmpDir, 'default');
      expect(all.length).toBe(2);
      expect(all.some((e) => e.artifactRef === 'vault:work:shared.md')).toBe(true);
      expect(all.some((e) => e.artifactRef === 'vault:personal:shared.md')).toBe(true);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
