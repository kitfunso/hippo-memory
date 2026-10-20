// Design 6's edge rows from the plan's Added list: supersede, restore, collapse, pin, refuse and the dormant lookups.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { forget, reject, dormantRestore, supersede } from '../../src/api/index.js';
import { importForStore } from '../../src/domain/agent-memories/sync.js';
import type { ImportReport } from '../../src/domain/agent-memories/report.js';
import { insertDormantRow } from '../../src/store/sqlite/dormant-rows.js';
import { createMemory, type MemoryEntry } from '../../src/base/memory/memory.js';
import { removeEntryMirrors } from '../../src/store/sqlite/mirrors.js';
import { deleteEntryRowInTx } from '../../src/store/sqlite/entry-writes.js';
import {
  auditCount,
  auditTotal,
  closeWorld,
  codexSummary,
  ctxFor,
  dormantRows,
  expectedContainer,
  liveRows,
  liveTexts,
  note,
  openWorld,
  projectNotes,
  sha,
  toolTally,
  withDb,
  type World,
} from '../_helpers/agent-memories-world.js';
import { loadConfig } from '../../src/base/config/config.js';
import { sqliteImportStores } from '../../src/store/sqlite/agent-import-stores.js';
import { writeEntry, readEntry } from '../_helpers/root-forms.js';

// Every sync asks git for each folder's layout in a child process, and a case runs several syncs.
vi.setConfig({ testTimeout: 20_000 });

const A = 'Run the schema check before this service deploys.';
const B = 'Run the schema check and the smoke test before each deploy.';
const TAG = 'claude-code-memory';
// AWS's documented example access key: a public placeholder, not a credential.
const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';

let w: World;
let dir: string;
beforeEach(() => {
  w = openWorld();
  dir = projectNotes(w);
});
afterEach(() => closeWorld(w));

const sync = (): Promise<ImportReport> =>
  importForStore(w.local, {
    configAt: loadConfig,
    tenantId: 'default',
    stores: sqliteImportStores({}),
    machine: w.machine,
  });
const claude = (report: ImportReport) => toolTally(report, 'claude-code');
const only = (): MemoryEntry => {
  const rows = liveRows(w.local);
  expect(rows).toHaveLength(1);
  return rows[0];
};

async function importThenDelete(text = A): Promise<string> {
  const file = note(dir, 'deploy.md', text);
  await sync();
  const { id } = only();
  unlinkSync(file);
  expect(claude(await sync()).setAside).toBe(1);
  return id;
}

describe('agent memory sync: the Added list', () => {
  it('a user-superseded row is left alone while the note is unchanged, then superseded when it changes', async () => {
    note(dir, 'deploy.md', A);
    await sync();
    const USER = 'Run the schema check, then page the on-call engineer, before deploys.';
    const { newId } = await supersede(ctxFor(w.local), only().id, USER);

    expect(claude(await sync())).toMatchObject({ unchanged: 1, imported: 0, replaced: 0 });
    expect(only()).toMatchObject({ id: newId, content: USER, tags: [TAG] });

    note(dir, 'deploy.md', B);
    expect(claude(await sync()).replaced).toBe(1);
    expect(only().content).toBe(B);
    expect(readEntry(w.local, newId)?.supersededBy).toBe(only().id);
  });

  it('a deleted note that comes back unchanged is restored from dormant with its id', async () => {
    const id = await importThenDelete();
    note(dir, 'deploy.md', A);

    expect(claude(await sync())).toMatchObject({ restored: 1, imported: 0 });
    expect(only()).toMatchObject({ id, tags: [TAG] });
    expect(auditCount(w.local, 'agent_memory_restore')).toBe(1);
  });

  it('a restored set-aside row is left alone while the note stays gone', async () => {
    const id = await importThenDelete();
    await dormantRestore(ctxFor(w.local), id);

    for (let i = 0; i < 2; i++) {
      expect(claude(await sync())).toMatchObject({ setAside: 0, untagged: 0, retagged: 0, imported: 0 });
      expect(only()).toMatchObject({ id, content: A });
      expect(only().tags).not.toContain(TAG);
    }
  });

  it('A to B to A writes a new row each time, each superseding the last', async () => {
    note(dir, 'deploy.md', A);
    await sync();
    const a1 = only();
    note(dir, 'deploy.md', B);
    expect(claude(await sync()).replaced).toBe(1);
    const b = only();
    note(dir, 'deploy.md', A);
    expect(claude(await sync()).replaced).toBe(1);
    const a2 = only();

    expect(a2.id).not.toBe(a1.id);
    expect([readEntry(w.local, a1.id)?.supersededBy, readEntry(w.local, b.id)?.supersededBy]).toEqual([b.id, a2.id]);
  });

  it('two tagged rows for one key collapse to the newest', async () => {
    note(dir, 'deploy.md', A);
    await sync();
    const newest = only();
    const older = {
      ...newest,
      id: createMemory(A, { baseHalfLifeDays: 30 }).id,
      created: new Date(Date.parse(newest.created) - 60_000).toISOString(),
    };
    writeEntry(w.local, older);

    expect(claude(await sync())).toMatchObject({ collapsed: 1, unchanged: 0, imported: 0 });
    expect(only().id).toBe(newest.id);
    expect(readEntry(w.local, older.id)?.supersededBy).toBe(newest.id);
  });

  it('a restore after a rewrite survives two syncs', async () => {
    const a = await importThenDelete();
    note(dir, 'deploy.md', B);
    expect(claude(await sync()).imported).toBe(1);
    await dormantRestore(ctxFor(w.local), a);

    for (let i = 0; i < 2; i++) {
      expect(claude(await sync())).toMatchObject({ unchanged: 1, setAside: 0, replaced: 0, imported: 0 });
      expect(liveTexts(w.local)).toEqual([B, A].sort());
    }
  });

  it('a pinned row loses its tag and stays live when its note goes', async () => {
    const file = note(dir, 'deploy.md', A);
    await sync();
    const row = only();
    writeEntry(w.local, { ...row, pinned: true });
    unlinkSync(file);

    expect(claude(await sync())).toMatchObject({ untagged: 1, setAside: 0 });
    expect(only()).toMatchObject({ id: row.id, pinned: true });
    expect(only().tags).not.toContain(TAG);
    expect(dormantRows(w.local)).toEqual([]);
  });

  it('an unread item (over 256 KB, or holding a NUL byte) leaves its row alone', async () => {
    note(dir, 'big.md', A);
    note(dir, 'nul.md', B);
    await sync();
    const before = liveRows(w.local)
      .map((e) => e.id)
      .sort();
    note(dir, 'big.md', `${A} ${'padding line for the size cap\n'.repeat(10_000)}`);
    note(dir, 'nul.md', `${B}\u0000`);

    expect(claude(await sync())).toMatchObject({ unread: 2, setAside: 0, replaced: 0, imported: 0 });
    expect(
      liveRows(w.local)
        .map((e) => e.id)
        .sort(),
    ).toEqual(before);
  });

  it('an emptied file, as a tool leaves it mid-rewrite, leaves its rows alone', async () => {
    const file = note(dir, 'deploy.md', A);
    const memory = join(w.home, '.openclaw', 'workspace', 'MEMORY.md');
    mkdirSync(dirname(memory), { recursive: true });
    writeFileSync(memory, `- ${B}\n`, 'utf8');
    await sync();
    const ids = (): string[] => [...liveRows(w.local), ...liveRows(w.global)].map((e) => e.id).sort();
    const before = ids();
    expect(before).toHaveLength(2);
    writeFileSync(file, '');
    writeFileSync(memory, '');

    const report = await sync();
    expect(claude(report)).toMatchObject({ unread: 1, setAside: 0 });
    expect(toolTally(report, 'openclaw')).toMatchObject({ unreadable: 1, setAside: 0 });
    expect(ids()).toEqual(before);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a note that fails to read leaves its row alone (chmod cannot block a read on Windows or as root)',
    async () => {
      const file = note(dir, 'deploy.md', A);
      await sync();
      const { id } = only();
      chmodSync(file, 0o000);
      try {
        expect(claude(await sync())).toMatchObject({ unread: 1, setAside: 0 });
      } finally {
        chmodSync(file, 0o600);
      }
      expect(only().id).toBe(id);
    },
  );

  it('a refused item (edited to hold a secret, cut under 10 characters, or rejected) sets its tagged row aside', async () => {
    const REJECTED = 'The release branch is cut every second Thursday.';
    note(dir, 'secret.md', A);
    note(dir, 'short.md', B);
    note(dir, 'rejected.md', 'The release branch is cut on the first Monday.');
    await sync();
    expect(liveRows(w.local)).toHaveLength(3);
    await reject(ctxFor(w.local), { value: REJECTED, reason: 'wrong cadence' });

    note(dir, 'secret.md', `Deploys sign in with ${FAKE_KEY} on the build box.`);
    note(dir, 'short.md', 'tiny note');
    note(dir, 'rejected.md', REJECTED);
    expect(claude(await sync())).toMatchObject({
      secret: 1,
      short: 1,
      rejected: 1,
      setAside: 3,
      imported: 0,
      replaced: 0,
    });
    expect(liveRows(w.local)).toEqual([]);
    expect(dormantRows(w.local).map((d) => d.reason)).toEqual(['source-deleted', 'source-deleted', 'source-deleted']);
  });

  it('a note holding a Bearer header or a JWT is refused, and an email address is stored masked', async () => {
    note(dir, 'bearer.md', 'The staging API takes Authorization: Bearer abcdefghijklmnop123456 on every call.');
    note(
      dir,
      'jwt.md',
      'Replay the session with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl to reproduce it.',
    );
    note(dir, 'email.md', 'Send the release notes to alice@example.com before tagging.');

    expect(claude(await sync())).toMatchObject({ secret: 2, imported: 1 });
    expect(liveTexts(w.local)).toEqual(['Send the release notes to [email] before tagging.']);
  });

  it('a rejected value is counted with no write and no audit row, at every sync', async () => {
    const REJECTED = 'The release branch is cut every second Thursday.';
    await reject(ctxFor(w.local), { value: REJECTED, reason: 'wrong cadence' });
    note(dir, 'release.md', REJECTED);

    for (let i = 0; i < 2; i++) {
      const before = auditTotal(w.local);
      expect(claude(await sync())).toMatchObject({ rejected: 1, imported: 0 });
      expect(auditTotal(w.local)).toBe(before);
    }
    expect(liveRows(w.local)).toEqual([]);
  });

  it('a forgotten row is imported again while its note exists', async () => {
    note(dir, 'deploy.md', A);
    await sync();
    const { id } = only();
    await forget(ctxFor(w.local), id);

    expect(claude(await sync()).imported).toBe(1);
    expect(only().id).not.toBe(id);
  });

  it('a malformed dormant snapshot does not stop the sync', async () => {
    const id = await importThenDelete();
    const source = `agent-memory:claude-code:${expectedContainer(dir, 'p')}/deploy.md#${sha(A).slice(0, 16)}`;
    withDb(w.local, (db) => {
      const put = db.prepare(
        `INSERT INTO dormant_memories (tenant_id, id, content, entry_json, reason, strength, dormant_at) VALUES ('default', ?, ?, ?, 'decay', 0.1, ?)`,
      );
      put.run('mem_broken_json', A, '{not json', new Date().toISOString());
      put.run('mem_broken_entry', A, JSON.stringify({ source }), new Date(Date.now() + 1000).toISOString());
    });
    note(dir, 'deploy.md', A);

    const report = await sync();
    expect(claude(report)).toMatchObject({ restored: 1, imported: 0 });
    expect(report.warnings).toEqual([]);
    expect(only().id).toBe(id);
  });

  it('a superseded dormant snapshot is never restored', async () => {
    note(dir, 'deploy.md', A);
    await sync();
    const row = only();
    withDb(w.local, (db) => {
      db.exec('BEGIN IMMEDIATE');
      insertDormantRow(db, {
        entry: { ...row, supersededBy: 'mem_elsewhere' },
        strength: 0.1,
        reason: 'decay',
        dormantAt: new Date().toISOString(),
      });
      deleteEntryRowInTx(db, row, 'test');
      db.exec('COMMIT');
    });
    removeEntryMirrors(w.local, row.id);

    expect(claude(await sync())).toMatchObject({ imported: 1, restored: 0 });
    expect(only().id).not.toBe(row.id);
  });

  it('duplicate bullets under one heading get ~2', async () => {
    const file = codexSummary(w, '- Prefers tabs over spaces in Go files.', '- Prefers tabs over spaces in Go files.');
    const text = 'User Profile: Prefers tabs over spaces in Go files.';
    const base = `agent-memory:codex:${expectedContainer(file, 'u')}/user-profile/${sha(text).slice(0, 12)}`;

    expect(toolTally(await sync(), 'codex').imported).toBe(2);
    expect(
      liveRows(w.global)
        .map((e) => e.source)
        .sort(),
    ).toEqual([`${base}#${sha(text).slice(0, 16)}`, `${base}~2#${sha(text).slice(0, 16)}`]);
    writeFileSync(
      file,
      ['v1', '', '## User Profile', '', '- Prefers tabs over spaces in Go files.', ''].join('\n'),
      'utf8',
    );
    expect(toolTally(await sync(), 'codex')).toMatchObject({ unchanged: 1, setAside: 1 });
    expect(liveRows(w.global).map((e) => e.source)).toEqual([`${base}#${sha(text).slice(0, 16)}`]);
  });
});
