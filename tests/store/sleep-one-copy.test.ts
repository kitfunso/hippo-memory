// Sleep keeps no deep copy of the store: the "as loaded" copy of a row is rebuilt from the row that was read.
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { runSleep } from '../../src/api/sleep/sleep-run.js';
import { computeAmbientState } from '../../src/base/memory/ambient.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { MEMORY_SELECT_COLUMNS } from '../../src/store/sqlite/rows.js';
import { countMatching, recordStatementsAsync } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';

/** loadAllEntries' statement with no tenant: every full row of the store. */
// An every-tenant page reads each tenant on its own index; these stores hold one tenant.
const HOST_WIDE_READ = `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE 1 AND tenant_id = ? ORDER BY created ASC, id ASC`;

const roots: string[] = [];

function newRoot(): string {
  const root = makeRoot('one-copy');
  roots.push(root);
  return root;
}

const ctxFor = (hippoRoot: string): FullContext =>
  apiCtx(hippoRoot, 'default', { subject: 'one-copy-test', role: 'admin' });

afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('sleep after consolidation', () => {
  it('gives the ambient summary of the rows the audit left', async () => {
    const home = makeRoot('one-copy-home', { init: false });
    roots.push(home);
    vi.stubEnv('HIPPO_HOME', home);
    vi.stubEnv('HIPPO_FAKE_NOW', '2026-06-01T12:00:00.000Z');
    const root = newRoot();
    const kept = ['the deploy runs on friday', 'billing is owned by alice', 'staging restarts on sunday'];
    for (const text of kept) writeEntry(root, createMemory(text, { tags: ['ops'] }));
    const junk = createMemory('nope');
    writeEntry(root, junk);

    const result = await runSleep(ctxFor(root), { noShare: true });

    expect(result.audit?.errorsRemoved).toBe(1);
    const after = loadAllEntries(root, 'default');
    expect(after.some((e) => e.id === junk.id)).toBe(false);
    expect(result.ambient).toEqual(computeAmbientState(after.filter((e) => !e.supersededBy)));
  });

  it('adds no whole-store read for the share phase', async () => {
    const home = makeRoot('one-copy-home', { init: false });
    roots.push(home);
    vi.stubEnv('HIPPO_HOME', home);
    vi.stubEnv('HIPPO_FAKE_NOW', '2026-06-01T12:00:00.000Z');
    const wholeReads = async (noShare: boolean): Promise<number> => {
      const root = newRoot();
      for (const text of ['the deploy runs on friday', 'billing is owned by alice', 'staging restarts on sunday']) {
        writeEntry(root, createMemory(text, { tags: ['ops'] }));
      }
      const { result, statements } = await recordStatementsAsync(() => runSleep(ctxFor(root), { noShare }));
      expect(result.shared).toBeUndefined();
      return countMatching(statements, HOST_WIDE_READ);
    };
    const withoutShare = await wholeReads(true);
    // The first page of dedup, the audit and ambient: three rows fit one page each, and consolidation reads by id.
    expect(withoutShare).toBe(3);
    expect(await wholeReads(false)).toBe(withoutShare);
  });
});
