// The PR 2 list from the agent memory plan's Tests section, run against real stores in scratch folders.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dormantRestore } from '../../src/api/index.js';
import { stageSupersedeWinner } from '../_helpers/supersede-now.js';
import { consolidate } from '../../src/index.js';
import { importAtSessionEnd, importForStore, importProjectMemories } from '../../src/domain/agent-memories/sync.js';
import type { Machine } from '../../src/base/util/agent-homes.js';
import type { ImportReport } from '../../src/domain/agent-memories/report.js';
import { insertDormantRow } from '../../src/store/sqlite/dormant-rows.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { deriveOriginProject, isInitialized } from '../../src/base/scope/project-identity.js';
import { removeEntryMirrors } from '../../src/store/sqlite/mirrors.js';
import { deleteEntryRowInTx } from '../../src/store/sqlite/entry-writes.js';
import {
  agentRows,
  auditCount,
  closeWorld,
  ctxFor,
  dormantRows,
  expectedContainer,
  liveRows,
  liveTexts,
  note,
  openWorld,
  projectNotes,
  sha,
  tally,
  toolTally,
  withDb,
  type World,
} from '../_helpers/agent-memories-world.js';
import { loadConfig } from '../../src/base/config/config.js';
import { sqliteImportStores } from '../../src/store/sqlite/agent-import-stores.js';
import { writeEntry, loadAllEntries, readEntry } from '../_helpers/root-forms.js';

const DEPLOY = 'Run the schema check before this service deploys.';
const STAGING = 'The staging database moved to the eu-central region.';
// AWS's documented example access key: a public placeholder, not a credential.
const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';

let w: World;
beforeEach(() => {
  w = openWorld();
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

function legacyRow(content: string, file: string): MemoryEntry {
  const entry = createMemory(content, {
    tags: ['claude-code-memory'],
    source: `claude-memory:${file}`,
    tenantId: 'default',
    baseHalfLifeDays: 30,
  });
  writeEntry(w.local, entry);
  return entry;
}

describe('agent memory sync', () => {
  it('a new note is imported as one tagged, distilled row keyed by its folder, file and hash', async () => {
    const dir = projectNotes(w);
    note(dir, 'deploy.md', DEPLOY);

    expect(claude(await sync()).imported).toBe(1);
    const rows = liveRows(w.local);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      content: DEPLOY,
      tags: ['claude-code-memory'],
      kind: 'distilled',
      layer: Layer.Episodic,
      confidence: 'observed',
      originProject: 'proj',
    });
    expect(rows[0].source).toBe(
      `agent-memory:claude-code:${expectedContainer(dir, 'p')}/deploy.md#${sha(DEPLOY).slice(0, 16)}`,
    );
    expect(existsSync(join(w.local, 'episodic', `${rows[0].id}.md`))).toBe(true);
  });

  it('an unchanged note is skipped', async () => {
    note(projectNotes(w), 'deploy.md', DEPLOY);
    await sync();
    const [first] = liveRows(w.local);

    expect(claude(await sync())).toMatchObject({ imported: 0, replaced: 0, unchanged: 1 });
    expect(agentRows(w.local).map((e) => e.id)).toEqual([first.id]);
  });

  it('an edit past character 1500 supersedes the row, though the stored text is the same', async () => {
    const dir = projectNotes(w);
    const long = 'The deploy checklist says to run the schema check, then the smoke test, then tell the desk. '
      .repeat(20)
      .trim();
    note(dir, 'checklist.md', long);
    await sync();
    const [old] = liveRows(w.local);
    expect(old.content.endsWith(' [truncated]')).toBe(true);

    note(dir, 'checklist.md', `${long} Then close the ticket.`);
    expect(claude(await sync())).toMatchObject({ replaced: 1, imported: 0 });
    const [now] = liveRows(w.local);
    expect(now.id).not.toBe(old.id);
    expect(now.content).toBe(old.content);
    expect(readEntry(w.local, old.id)?.supersededBy).toBe(now.id);
  });

  it('a deleted note is set aside through the real SQL, as source-deleted, and can be restored', async () => {
    const file = note(projectNotes(w), 'deploy.md', DEPLOY);
    await sync();
    const [row] = liveRows(w.local);

    unlinkSync(file);
    expect(claude(await sync()).setAside).toBe(1);
    expect(liveRows(w.local)).toEqual([]);
    expect(withDb(w.local, (db) => db.prepare('SELECT 1 FROM memories WHERE id = ?').get(row.id))).toBeUndefined();
    expect(existsSync(join(w.local, 'episodic', `${row.id}.md`))).toBe(false);
    const dormant = dormantRows(w.local);
    expect(dormant).toMatchObject([{ id: row.id, content: DEPLOY, reason: 'source-deleted' }]);
    expect(dormant[0].tags).not.toContain('claude-code-memory');
    expect(auditCount(w.local, 'agent_memory_set_aside')).toBe(1);

    expect((await dormantRestore(ctxFor(w.local), row.id)).id).toBe(row.id);
    expect(liveRows(w.local).map((e) => e.id)).toEqual([row.id]);
  });

  it('a missing folder changes nothing', async () => {
    const dir = projectNotes(w);
    note(dir, 'deploy.md', DEPLOY);
    await sync();
    const [row] = liveRows(w.local);

    rmSync(dir, { recursive: true });
    expect(claude(await sync())).toMatchObject({ setAside: 0, untagged: 0, imported: 0 });
    expect(liveRows(w.local)).toMatchObject([{ id: row.id, tags: ['claude-code-memory'] }]);
    expect(dormantRows(w.local)).toEqual([]);
  });

  it("a note whose row went dormant from decay gets its live row back, under the sync's own audit op", async () => {
    note(projectNotes(w), 'deploy.md', DEPLOY);
    await sync();
    const [row] = liveRows(w.local);
    withDb(w.local, (db) => {
      db.exec('BEGIN IMMEDIATE');
      insertDormantRow(db, { entry: row, strength: 0.01, reason: 'decay', dormantAt: new Date().toISOString() });
      deleteEntryRowInTx(db, row, 'test');
      db.exec('COMMIT');
    });
    removeEntryMirrors(w.local, row.id);
    expect(liveRows(w.local)).toEqual([]);

    expect(claude(await sync())).toMatchObject({ restored: 1, imported: 0 });
    expect(liveRows(w.local)).toMatchObject([{ id: row.id, content: DEPLOY, tags: ['claude-code-memory'] }]);
    expect(dormantRows(w.local)).toEqual([]);
    expect(auditCount(w.local, 'agent_memory_restore')).toBe(1);
    expect(auditCount(w.local, 'dormant_restore')).toBe(0);
  });

  it("legacy rows are adopted from the store's own folder only: same text first, then one row per file name", async () => {
    const dir = projectNotes(w);
    const OTHER = 'The billing queue drains at midnight in the other project.';
    note(dir, 'deploy.md', DEPLOY);
    note(dir, 'staging.md', STAGING);
    note(projectNotes(w, join(w.dir, 'other')), 'billing.md', OTHER);
    const renamed = legacyRow(DEPLOY, 'old-deploy-name.md');
    const edited = legacyRow('The staging database lives in us-east.', 'staging.md');
    const foreign = legacyRow(OTHER, 'billing.md');

    expect(claude(await sync())).toMatchObject({ adopted: 1, replaced: 1, imported: 0 });
    expect(readEntry(w.local, renamed.id)).toMatchObject({
      source: `agent-memory:claude-code:${expectedContainer(dir, 'p')}/deploy.md#${sha(DEPLOY).slice(0, 16)}`,
      supersededBy: null,
    });
    const staging = liveRows(w.local).find((e) => e.content === STAGING);
    expect(readEntry(w.local, edited.id)?.supersededBy).toBe(staging?.id);
    expect(readEntry(w.local, foreign.id)).toMatchObject({ source: 'claude-memory:billing.md', supersededBy: null });
    expect(liveTexts(w.local)).toEqual([DEPLOY, STAGING].sort());
  });

  // The legacy match reads its rows before the container's transaction, so only the guarded UPDATE sees the other writer.
  it('a legacy row another writer superseded after the import matched it keeps the successor that writer gave it', async () => {
    note(projectNotes(w), 'staging.md', STAGING);
    const edited = legacyRow('The staging database lives in us-east.', 'staging.md');

    const winner = await stageSupersedeWinner(ctxFor(w.local), edited.id, 'The staging database lives in ap-south.');
    const report = await importForStore(w.local, {
      configAt: loadConfig,
      tenantId: 'default',
      stores: sqliteImportStores({}),
      machine: w.machine,
      busyWaitMs: 5000,
    });
    await winner.committed;

    // replaced: the plan still held the row, so the import did reach its supersede step with a stale copy.
    expect(claude(report)).toMatchObject({ replaced: 1, imported: 0 });
    expect(readEntry(w.local, edited.id)?.supersededBy).toBe(winner.successorId);
    expect(auditCount(w.local, 'supersede')).toBe(1);
  });

  it('an old row with an email in clear matches its masked note, and a copy already imported collapses into one row', async () => {
    const MAIL = 'Release notes go to ops-team@example.com before each tag.';
    const MASKED = 'Release notes go to [email] before each tag.';
    const dir = projectNotes(w);
    note(dir, 'release.md', MAIL);
    const renamed = legacyRow(MAIL, 'old-release-name.md');
    expect(claude(await sync())).toMatchObject({ adopted: 1, imported: 0 });
    expect(readEntry(w.local, renamed.id)?.supersededBy).toBeNull();

    note(dir, 'mail.md', MAIL.replace('Release', 'Weekly'));
    await sync();
    const stale = {
      ...createMemory(MAIL.replace('Release', 'Weekly'), {
        tags: ['claude-code-memory'],
        source: 'claude-memory:gone.md',
        tenantId: 'default',
      }),
      created: '2026-01-01T00:00:00.000Z',
    };
    writeEntry(w.local, stale);

    await sync();
    const copy = liveRows(w.local).find((e) => e.content === MASKED.replace('Release', 'Weekly'));
    expect(readEntry(w.local, stale.id)?.supersededBy).toBe(copy?.id);
    expect(liveRows(w.local).filter((e) => e.content.includes('Weekly'))).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'win32')(
    'Windows folder case is normalised: the same folders in another case are the same container',
    async () => {
      note(projectNotes(w), 'deploy.md', DEPLOY);
      await sync();
      const upper: Machine = { ...w.machine, env: { CLAUDE_CONFIG_DIR: join(w.home, '.claude').toUpperCase() } };

      const again = await importProjectMemories(w.local.toUpperCase(), {
        configAt: loadConfig,
        tenantId: 'default',
        stores: sqliteImportStores({}),
        machine: upper,
      });
      expect(claude(again)).toMatchObject({ unchanged: 1, imported: 0, setAside: 0 });
      expect(liveRows(w.local)).toHaveLength(1);
    },
  );

  it('a secret note is skipped and counted, at every sync', async () => {
    const dir = projectNotes(w);
    note(dir, 'key.md', `The staging deploy user signs in with ${FAKE_KEY} on the build box.`);
    note(dir, 'deploy.md', DEPLOY);

    expect(claude(await sync())).toMatchObject({ imported: 1, secret: 1 });
    expect(claude(await sync())).toMatchObject({ imported: 0, secret: 1 });
    expect(liveTexts(w.local)).toEqual([DEPLOY]);
    expect(loadAllEntries(w.local, 'default').some((e) => e.content.includes(FAKE_KEY))).toBe(false);
  });

  it('the sync never writes to stdout or stderr, even when it skips, sets aside and warns', async () => {
    const dir = projectNotes(w);
    const gone = note(dir, 'gone.md', 'This note is deleted before the second sync.');
    await sync();
    unlinkSync(gone);
    note(dir, 'key.md', `The staging deploy user signs in with ${FAKE_KEY} on the build box.`);
    note(dir, 'deploy.md', DEPLOY);
    mkdirSync(join(w.home, '.codex', 'memories'), { recursive: true });
    writeFileSync(join(w.home, '.codex', 'memories', 'memory_summary.md'), 'not a Codex summary', 'utf8');

    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
      ...(['log', 'info', 'warn', 'error'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => undefined),
      ),
    ];
    let report: ImportReport;
    try {
      report = await sync();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(spies.map((s) => s.mock.calls.length)).toEqual(spies.map(() => 0));
    expect(tally(report)).toMatchObject({ imported: 1, setAside: 1, secret: 1 });
    expect(report.warnings.some((line) => line.includes('not a Codex memory summary'))).toBe(true);
  });

  it('imported rows are never merged or sent to extraction by sleep', async () => {
    const BASE = 'Fixed the server crash due to memory overflow in the worker process `pool.ts`';
    const dir = projectNotes(w);
    [BASE, `${BASE} again today`, `${BASE} once more`].forEach((text, i) => note(dir, `crash-${i}.md`, text));
    await sync();
    const before = liveRows(w.local)
      .map((e) => e.id)
      .sort();
    expect(before).toHaveLength(3);

    const result = await consolidate(w.local, { dryRun: false, now: new Date() });
    expect(result).toMatchObject({ merged: 0, extractionCandidates: 0 });
    expect(
      liveRows(w.local)
        .map((e) => e.id)
        .sort(),
    ).toEqual(before);
    expect(loadAllEntries(w.local, 'default').filter((e) => e.layer === Layer.Semantic)).toEqual([]);
  });

  it('session end in a folder without a store imports the project and session folder notes into the global store with the project as origin', async () => {
    const cwd = join(w.dir, 'hookproj', 'src');
    mkdirSync(join(w.dir, 'hookproj', '.git'), { recursive: true });
    mkdirSync(cwd);
    note(projectNotes(w, cwd), 'deploy.md', DEPLOY);
    const QUEUE = 'The session folder note says the queue drains at midnight.';
    const transcript = join(dirname(note(projectNotes(w, dirname(cwd)), 'queue.md', QUEUE)), '..', 's1.jsonl');
    writeFileSync(transcript, '', 'utf8');

    expect(
      claude(
        await importAtSessionEnd(cwd, transcript, {
          configAt: loadConfig,
          tenantId: 'default',
          stores: sqliteImportStores({}),
          machine: w.machine,
        }),
      ).imported,
    ).toBe(2);
    const origin = deriveOriginProject(cwd);
    expect(origin).not.toBe('');
    expect(liveTexts(w.global)).toEqual([DEPLOY, QUEUE].sort());
    expect(liveRows(w.global).map((e) => e.originProject)).toEqual([origin, origin]);
    expect(isInitialized(join(cwd, '.hippo'))).toBe(false);
    expect(liveRows(w.local)).toEqual([]);
  });
});
