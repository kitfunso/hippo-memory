// The PR 2 list from the agent memory plan's Tests section, run against real stores in scratch folders.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { restoreDormant } from '../src/api.js';
import { consolidate } from '../src/consolidate.js';
import { importAtSessionEnd, importForStore, importProjectMemories, type Machine } from '../src/agent-memories/sync.js';
import type { ImportReport } from '../src/agent-memories/report.js';
import { insertDormantRow } from '../src/dormant.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { deriveOriginProject } from '../src/project-identity.js';
import { deleteEntryRowInTx, isInitialized, loadAllEntries, readEntry, removeEntryMirrors, writeEntry } from '../src/store.js';
import {
  agentRows, auditCount, closeWorld, ctxFor, dormantRows, expectedContainer, liveRows, liveTexts, note, openWorld, projectNotes, sha,
  tally, toolTally, withDb, type World,
} from './_helpers/agent-memories-world.js';

const DEPLOY = 'Run the schema check before this service deploys.';
const STAGING = 'The staging database moved to the eu-central region.';
// AWS's documented example access key: a public placeholder, not a credential.
const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';

let w: World;
beforeEach(() => {
  w = openWorld();
});
afterEach(() => closeWorld(w));

const sync = (): ImportReport => importForStore(w.local, { machine: w.machine });
const claude = (report: ImportReport) => toolTally(report, 'claude-code');

function legacyRow(content: string, file: string): MemoryEntry {
  const entry = createMemory(content, { tags: ['claude-code-memory'], source: `claude-memory:${file}`, tenantId: 'default', baseHalfLifeDays: 30 });
  writeEntry(w.local, entry);
  return entry;
}

describe('agent memory sync: the PR 2 list', () => {
  it('a new note is imported as one tagged, distilled row keyed by its folder, file and hash', () => {
    const dir = projectNotes(w);
    note(dir, 'deploy.md', DEPLOY);

    expect(claude(sync()).imported).toBe(1);
    const rows = liveRows(w.local);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      content: DEPLOY, tags: ['claude-code-memory'], kind: 'distilled', layer: Layer.Episodic, confidence: 'observed', origin_project: 'proj',
    });
    expect(rows[0].source).toBe(`agent-memory:claude-code:${expectedContainer(dir, 'p')}/deploy.md#${sha(DEPLOY).slice(0, 16)}`);
    expect(existsSync(join(w.local, 'episodic', `${rows[0].id}.md`))).toBe(true);
  });

  it('an unchanged note is skipped', () => {
    note(projectNotes(w), 'deploy.md', DEPLOY);
    sync();
    const [first] = liveRows(w.local);

    expect(claude(sync())).toMatchObject({ imported: 0, replaced: 0, unchanged: 1 });
    expect(agentRows(w.local).map((e) => e.id)).toEqual([first.id]);
  });

  it('an edit past character 1500 supersedes the row, though the stored text is the same', () => {
    const dir = projectNotes(w);
    const long = 'The deploy checklist says to run the schema check, then the smoke test, then tell the desk. '.repeat(20).trim();
    note(dir, 'checklist.md', long);
    sync();
    const [old] = liveRows(w.local);
    expect(old.content.endsWith(' [truncated]')).toBe(true);

    note(dir, 'checklist.md', `${long} Then close the ticket.`);
    expect(claude(sync())).toMatchObject({ replaced: 1, imported: 0 });
    const [now] = liveRows(w.local);
    expect(now.id).not.toBe(old.id);
    expect(now.content).toBe(old.content);
    expect(readEntry(w.local, old.id)?.superseded_by).toBe(now.id);
  });

  it('a deleted note is set aside through the real SQL, as source-deleted, and can be restored', () => {
    const file = note(projectNotes(w), 'deploy.md', DEPLOY);
    sync();
    const [row] = liveRows(w.local);

    unlinkSync(file);
    expect(claude(sync()).setAside).toBe(1);
    expect(liveRows(w.local)).toEqual([]);
    expect(withDb(w.local, (db) => db.prepare('SELECT 1 FROM memories WHERE id = ?').get(row.id))).toBeUndefined();
    expect(existsSync(join(w.local, 'episodic', `${row.id}.md`))).toBe(false);
    const dormant = dormantRows(w.local);
    expect(dormant).toMatchObject([{ id: row.id, content: DEPLOY, reason: 'source-deleted' }]);
    expect(dormant[0].tags).not.toContain('claude-code-memory');
    expect(auditCount(w.local, 'agent_memory_set_aside')).toBe(1);

    expect(restoreDormant(ctxFor(w.local), row.id).id).toBe(row.id);
    expect(liveRows(w.local).map((e) => e.id)).toEqual([row.id]);
  });

  it('a missing folder changes nothing', () => {
    const dir = projectNotes(w);
    note(dir, 'deploy.md', DEPLOY);
    sync();
    const [row] = liveRows(w.local);

    rmSync(dir, { recursive: true });
    expect(claude(sync())).toMatchObject({ setAside: 0, untagged: 0, imported: 0 });
    expect(liveRows(w.local)).toMatchObject([{ id: row.id, tags: ['claude-code-memory'] }]);
    expect(dormantRows(w.local)).toEqual([]);
  });

  it('a note whose row went dormant from decay gets its live row back, under the sync\'s own audit op', () => {
    note(projectNotes(w), 'deploy.md', DEPLOY);
    sync();
    const [row] = liveRows(w.local);
    withDb(w.local, (db) => {
      db.exec('BEGIN IMMEDIATE');
      insertDormantRow(db, { entry: row, strength: 0.01, reason: 'decay', dormantAt: new Date().toISOString() });
      deleteEntryRowInTx(db, row, 'test');
      db.exec('COMMIT');
    });
    removeEntryMirrors(w.local, row.id);
    expect(liveRows(w.local)).toEqual([]);

    expect(claude(sync())).toMatchObject({ restored: 1, imported: 0 });
    expect(liveRows(w.local)).toMatchObject([{ id: row.id, content: DEPLOY, tags: ['claude-code-memory'] }]);
    expect(dormantRows(w.local)).toEqual([]);
    expect(auditCount(w.local, 'agent_memory_restore')).toBe(1);
    expect(auditCount(w.local, 'dormant_restore')).toBe(0);
  });

  it('legacy rows are adopted from the store\'s own folder only: same text first, then one row per file name', () => {
    const dir = projectNotes(w);
    const OTHER = 'The billing queue drains at midnight in the other project.';
    note(dir, 'deploy.md', DEPLOY);
    note(dir, 'staging.md', STAGING);
    note(projectNotes(w, join(w.dir, 'other')), 'billing.md', OTHER);
    const renamed = legacyRow(DEPLOY, 'old-deploy-name.md');
    const edited = legacyRow('The staging database lives in us-east.', 'staging.md');
    const foreign = legacyRow(OTHER, 'billing.md');

    expect(claude(sync())).toMatchObject({ adopted: 1, replaced: 1, imported: 0 });
    expect(readEntry(w.local, renamed.id)).toMatchObject({
      source: `agent-memory:claude-code:${expectedContainer(dir, 'p')}/deploy.md#${sha(DEPLOY).slice(0, 16)}`, superseded_by: null,
    });
    const staging = liveRows(w.local).find((e) => e.content === STAGING);
    expect(readEntry(w.local, edited.id)?.superseded_by).toBe(staging?.id);
    expect(readEntry(w.local, foreign.id)).toMatchObject({ source: 'claude-memory:billing.md', superseded_by: null });
    expect(liveTexts(w.local)).toEqual([DEPLOY, STAGING].sort());
  });

  it.skipIf(process.platform !== 'win32')('Windows folder case is normalised: the same folders in another case are the same container', () => {
    note(projectNotes(w), 'deploy.md', DEPLOY);
    sync();
    const upper: Machine = { ...w.machine, env: { CLAUDE_CONFIG_DIR: join(w.home, '.claude').toUpperCase() } };

    const again = importProjectMemories(w.local.toUpperCase(), { machine: upper });
    expect(claude(again)).toMatchObject({ unchanged: 1, imported: 0, setAside: 0 });
    expect(liveRows(w.local)).toHaveLength(1);
  });

  it('a secret note is skipped and counted, at every sync', () => {
    const dir = projectNotes(w);
    note(dir, 'key.md', `The staging deploy user signs in with ${FAKE_KEY} on the build box.`);
    note(dir, 'deploy.md', DEPLOY);

    expect(claude(sync())).toMatchObject({ imported: 1, secret: 1 });
    expect(claude(sync())).toMatchObject({ imported: 0, secret: 1 });
    expect(liveTexts(w.local)).toEqual([DEPLOY]);
    expect(loadAllEntries(w.local).some((e) => e.content.includes(FAKE_KEY))).toBe(false);
  });

  it('the sync never writes to stdout or stderr, even when it skips, sets aside and warns', () => {
    const dir = projectNotes(w);
    const gone = note(dir, 'gone.md', 'This note is deleted before the second sync.');
    sync();
    unlinkSync(gone);
    note(dir, 'key.md', `The staging deploy user signs in with ${FAKE_KEY} on the build box.`);
    note(dir, 'deploy.md', DEPLOY);
    mkdirSync(join(w.home, '.codex', 'memories'), { recursive: true });
    writeFileSync(join(w.home, '.codex', 'memories', 'memory_summary.md'), 'not a Codex summary', 'utf8');

    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
      ...(['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined)),
    ];
    let report: ImportReport;
    try {
      report = sync();
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
    sync();
    const before = liveRows(w.local).map((e) => e.id).sort();
    expect(before).toHaveLength(3);

    const result = await consolidate(w.local, { dryRun: false, now: new Date() });
    expect(result).toMatchObject({ merged: 0, extractionCandidates: 0 });
    expect(liveRows(w.local).map((e) => e.id).sort()).toEqual(before);
    expect(loadAllEntries(w.local).filter((e) => e.layer === Layer.Semantic)).toEqual([]);
  });

  it('session end in a folder without a store imports the project and transcript notes into the global store with the project as origin', () => {
    const cwd = join(w.dir, 'hookproj');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    note(projectNotes(w, cwd), 'deploy.md', DEPLOY);
    const session = join(w.home, '.claude', 'projects', 'transcript-folder');
    const QUEUE = 'The session folder note says the queue drains at midnight.';
    note(join(session, 'memory'), 'queue.md', QUEUE);
    const transcript = join(session, 's1.jsonl');
    writeFileSync(transcript, '', 'utf8');

    expect(claude(importAtSessionEnd(cwd, transcript, { machine: w.machine })).imported).toBe(2);
    const origin = deriveOriginProject(cwd);
    expect(origin).not.toBe('');
    expect(liveTexts(w.global)).toEqual([DEPLOY, QUEUE].sort());
    expect(liveRows(w.global).map((e) => e.origin_project)).toEqual([origin, origin]);
    expect(isInitialized(join(cwd, '.hippo'))).toBe(false);
    expect(liveRows(w.local)).toEqual([]);
  });
});
