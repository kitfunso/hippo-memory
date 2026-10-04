// Project ids in real stores: two `api` repos sharing a global store, the upgrade re-sync, folds the sync follows, and the repairs.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getContext } from '../src/api.js';
import { containerId, containerPrefix } from '../src/agent-memories/source.js';
import { importAtSessionEnd } from '../src/agent-memories/sync.js';
import { saveItems } from '../src/compaction-record.js';
import { listDormantSnapshots } from '../src/dormant.js';
import { runDoctor } from '../src/doctor.js';
import { createMemory, type MemoryEntry } from '../src/memory.js';
import { mergeProjects, planProjectRepair, repairProjects } from '../src/project-merge.js';
import { clearProjectIdentityCache, resolveProjectIdentity } from '../src/project-identity.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { initStore } from '../src/store/open.js';
import { closeWorld, ctxFor, liveRows, note, openWorld, projectNotes, toolTally, withDb, type World } from './_helpers/agent-memories-world.js';

const T = 'default';
let w: World;

beforeEach(() => {
  w = openWorld();
  clearProjectIdentityCache();
});
afterEach(() => {
  clearProjectIdentityCache();
  closeWorld(w);
});

/** A checkout under the world with `url` as its origin, written as git writes `.git/config`. */
function checkout(url: string, ...segments: string[]): string {
  const root = join(w.dir, ...segments);
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), `[remote "origin"]\n\turl = ${url}\n`);
  return root;
}

function globalConfig(remote: boolean): void {
  mkdirSync(w.global, { recursive: true });
  writeFileSync(join(w.global, 'config.json'), JSON.stringify({ projectIdentity: { remote }, embeddings: { enabled: false } }));
  clearProjectIdentityCache();
}

function pinned(root: string, content: string, origin: string): MemoryEntry {
  const entry = { ...createMemory(content, { tenantId: T, baseHalfLifeDays: 30, pinned: true }), origin_project: origin };
  writeEntry(root, entry);
  return entry;
}

function compaction(id: string, origin: string, cwd: string): void {
  withDb(w.global, (db) => db.prepare(
    `INSERT INTO compactions(tenant_id, id, session_id, origin_project, compact_trigger, cwd, transcript_path, started_at) VALUES (?, ?, ?, ?, 'auto', ?, NULL, ?)`,
  ).run(T, id, `s-${id}`, origin, cwd, new Date().toISOString()));
}

const texts = (r: Awaited<ReturnType<typeof getContext>>): string[] => r.entries.map((e) => e.entry.content);
const sync = (cwd: string) => importAtSessionEnd(cwd, undefined, { machine: w.machine });
const prefixFor = (cwd: string, origin: string): string =>
  containerPrefix('claude-code', containerId(projectNotes(w, cwd), 'project', process.platform, origin));

describe('two repos named api in one global store', () => {
  const OLD = 'OLD-API the old api rows predate project ids';
  const NEW_A = 'NEW-A the payments api retries twice';
  const NEW_B = 'NEW-B the search api pages by cursor';
  let a: string;
  let b: string;

  beforeEach(() => {
    initStore(w.global);
    a = checkout('git@github.com:acme-pay/api.git', 'pay', 'api');
    b = checkout('https://github.com/acme-search/api', 'search', 'api');
    pinned(w.global, OLD, 'api');
    pinned(w.global, NEW_A, resolveProjectIdentity(a).name);
    pinned(w.global, NEW_B, resolveProjectIdentity(b).name);
  });

  it('keeps new rows apart and shows the old rows to both through the legacy name', async () => {
    expect(resolveProjectIdentity(a)).toMatchObject({ name: 'github.com/acme-pay/api', legacyName: 'api' });
    for (const mode of [{ pinnedOnly: true }, { pinnedOnly: false }, { q: 'api' }]) {
      const inA = texts(await getContext(ctxFor(w.global), { currentProject: resolveProjectIdentity(a), ...mode }));
      const inB = texts(await getContext(ctxFor(w.global), { currentProject: resolveProjectIdentity(b), ...mode }));
      expect(inA).toEqual(expect.arrayContaining([OLD, NEW_A]));
      expect(inA).not.toContain(NEW_B);
      expect(inB).toEqual(expect.arrayContaining([OLD, NEW_B]));
      expect(inB).not.toContain(NEW_A);
    }
  });

  it('repair refuses to fold api into either, and doctor names both ids', () => {
    compaction('c-a', 'api', a);
    compaction('c-b', 'api', b);
    const plan = withDb(w.global, (db) => planProjectRepair(db, w.global, T));
    expect(plan.folds).toEqual([]);
    expect(plan.collisions).toEqual([{ name: 'api', ids: ['github.com/acme-pay/api', 'github.com/acme-search/api'] }]);
    const check = runDoctor({ cwd: a, home: w.home, version: 'test' }).checks.find((c) => c.id === 'projects');
    expect(check).toMatchObject({ status: 'warn' });
    expect(check?.detail).toContain('api (github.com/acme-pay/api, github.com/acme-search/api)');
  });

  it('repair folds a name whose folders all resolve to one id', () => {
    compaction('c-a', 'api', a);
    const plan = withDb(w.global, (db) => planProjectRepair(db, w.global, T));
    expect(plan.folds).toEqual([{ from: 'api', into: 'github.com/acme-pay/api' }]);
    expect(plan.collisions).toEqual([]);
  });

  it('a compaction item the legacy rows already hold is a repeat, not a new row', () => {
    const written = withDb(w.global, (db) => saveItems(db, w.global, {
      tenantId: T, recordId: null, sessionId: 's1', originProject: resolveProjectIdentity(a).name, cwd: a, items: [OLD],
    }, () => undefined));
    expect(written).toBe(0);
  });
});

describe('the upgrade re-sync', () => {
  const NOTES = ['Deploys need the schema check first.', 'The queue drains at midnight UTC.', 'Retries back off from two seconds.'];

  it('moves folder-named imports and their dormant snapshots under the id, importing nothing twice', () => {
    const api = checkout('git@github.com:acme/api.git', 'api');
    NOTES.forEach((text, i) => note(projectNotes(w, api), `n${i}.md`, text));
    globalConfig(false);
    sync(api);
    unlinkSync(join(projectNotes(w, api), 'n2.md'));
    expect(toolTally(sync(api), 'claude-code')).toMatchObject({ setAside: 1 });
    const before = liveRows(w.global);
    expect(before.map((e) => e.origin_project)).toEqual(['api', 'api']);

    globalConfig(true);
    expect(toolTally(sync(api), 'claude-code')).toMatchObject({ renamed: 2, imported: 0, setAside: 0 });
    const after = liveRows(w.global);
    expect(after.map((e) => e.id).sort()).toEqual(before.map((e) => e.id).sort());
    for (const e of after) expect(e).toMatchObject({ origin_project: 'github.com/acme/api', source: expect.stringContaining(prefixFor(api, 'github.com/acme/api')) });
    const [snap] = withDb(w.global, (db) => listDormantSnapshots(db, T));
    expect(snap.entry).toMatchObject({ origin_project: 'github.com/acme/api', source: expect.stringContaining(prefixFor(api, 'github.com/acme/api')) });

    expect(toolTally(sync(api), 'claude-code')).toMatchObject({ renamed: 0, imported: 0, unchanged: 2 });
    note(projectNotes(w, api), 'n2.md', NOTES[2]);
    expect(toolTally(sync(api), 'claude-code')).toMatchObject({ restored: 1, imported: 0 });
  });

  it('repair keeps folder-named imports in their own session folder, folds the name, and the next sync moves them', () => {
    const api = checkout('git@github.com:acme/api.git', 'api');
    NOTES.slice(0, 2).forEach((text, i) => note(projectNotes(w, api), `n${i}.md`, text));
    globalConfig(false);
    sync(api);
    globalConfig(true);
    const transcript = join(dirname(projectNotes(w, api)), 's.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ cwd: api })}\n`);
    withDb(w.global, (db) => db.prepare(
      `INSERT INTO compactions(tenant_id, id, session_id, origin_project, compact_trigger, cwd, transcript_path, started_at) VALUES (?, 'c1', 's1', 'api', 'auto', ?, ?, ?)`,
    ).run(T, api, transcript, new Date().toISOString()));

    const r = withDb(w.global, (db) => repairProjects(db, w.global, { tenantId: T, dryRun: false }));
    expect(r).toMatchObject({ copies: [], folds: [{ from: 'api', into: 'github.com/acme/api' }] });
    expect(toolTally(sync(api), 'claude-code')).toMatchObject({ renamed: 2, imported: 0 });
    expect(withDb(w.global, (db) => planProjectRepair(db, w.global, T)).copies).toEqual([]);
  });

  it('follows a merge: imports under the merged name move on the next sync instead of coming back as copies', () => {
    const svc = checkout('file:///srv/git/svc.git', 'svc');
    note(projectNotes(w, svc), 'a.md', NOTES[0]);
    writeFileSync(join(svc, '.hippo-project.json'), JSON.stringify({ id: 'old-svc' }));
    clearProjectIdentityCache();
    sync(svc);
    writeFileSync(join(svc, '.hippo-project.json'), JSON.stringify({ id: 'new-svc' }));
    clearProjectIdentityCache();
    const merged = withDb(w.global, (db) => mergeProjects(db, w.global, { tenantId: T, from: 'old-svc', into: 'new-svc', dryRun: false }));
    expect(merged.setAside).toEqual([]);

    expect(toolTally(sync(svc), 'claude-code')).toMatchObject({ renamed: 1, imported: 0 });
    expect(liveRows(w.global)).toMatchObject([{ content: NOTES[0], origin_project: 'new-svc', source: expect.stringContaining(prefixFor(svc, 'new-svc')) }]);
  });
});

describe('a project store with an id', () => {
  it('repair folds the store\'s own folder name into its id; nothing runs it unasked', () => {
    const svc = checkout('git@github.com:acme/svc.git', 'svc');
    const store = join(svc, '.hippo');
    initStore(store);
    const old = pinned(store, 'The svc store wrote this before ids.', 'svc');
    expect(loadAllEntries(store).find((e) => e.id === old.id)?.origin_project).toBe('svc');

    const r = withDb(store, (db) => repairProjects(db, store, { tenantId: T, dryRun: false }));
    expect(r.folds).toEqual([{ from: 'svc', into: 'github.com/acme/svc' }]);
    expect(loadAllEntries(store).find((e) => e.id === old.id)?.origin_project).toBe('github.com/acme/svc');
    expect(withDb(store, (db) => planProjectRepair(db, store, T)).folds).toEqual([]);
  });
});
