// The tool-failure listing through linked store paths, the controls, invariance I4 and the command line.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { blockHash } from '../../src/util/token-text.js';
import { realpathOrResolve } from '../../src/util/real-path.js';
import { hippoIn, type Project } from '../_helpers/delivery-boundary.js';
import { fireIn, seed, type TurnSpec, type Verdict } from '../_helpers/host-transcript.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import {
  SCRIPT,
  V,
  P1,
  P2,
  ERR_ALPHA,
  ERR_BETA,
  ROUTINE,
  rowsAt,
  num,
  payload,
  fail,
  link,
  toolFailureScratch,
} from '../_helpers/tool-failure-ledger.js';

let p: Project;

const { mk, rows, events, logs, lessons, lessonWith, list, read, doc } = toolFailureScratch(() => p);

describe('store paths through a link', () => {
  it('TF9a a project reached through a junction and directly writes one store hash, and both paths read every row', async (ctx) => {
    p = mk();
    const L = link(p.proj, path.join(p.dir, 'proj-link'));
    if (L === null) return ctx.skip();
    try {
      await fail(p, 'tf9a', { tool_use_id: 'toolu_via_link' }, { cwd: L });
      await fail(p, 'tf9a', { tool_use_id: 'toolu_direct', error: ERR_BETA });
      const ev = events('tf9a');
      expect(ev.map((e) => [e.event_type, e.turn_seq, e.ledger_version])).toEqual([
        ['tool-failure', 1, V],
        ['tool-failure', 2, V],
      ]);
      expect(ev.map((e) => e.store_hash)).toEqual(Array(2).fill(blockHash(realpathOrResolve(p.hippoRoot))));
      for (const store of [p.hippoRoot, path.join(L, '.hippo')]) {
        const listing = list('tf9a', { store });
        expect(listing.entries.map((e) => e.event_id)).toEqual(ev.map((e) => e.id));
        expect(listing.notes).toEqual([]);
      }
    } finally {
      fs.unlinkSync(L);
    }
  });

  it('TF9b a project .hippo that links to the global store reads its own rows in a class read', async (ctx) => {
    p = mk();
    initTestStore(p.globalRoot);
    fs.writeFileSync(
      path.join(p.globalRoot, 'config.json'),
      JSON.stringify({ deliveryLedger: { enabled: true }, pinnedInject: { promptRecall: false } }),
    );
    const proj2 = path.join(p.dir, 'proj2');
    fs.mkdirSync(path.join(proj2, '.git'), { recursive: true });
    const H = link(p.globalRoot, path.join(proj2, '.hippo'));
    if (H === null) return ctx.skip();
    try {
      await fail(p, 'tf9b', {}, { cwd: proj2 });
      const ev = events('tf9b', p.globalRoot);
      expect(ev.map((e) => [e.event_type, e.turn_seq, e.ledger_version])).toEqual([['tool-failure', 1, V]]);
      const want = blockHash(realpathOrResolve(p.globalRoot));
      expect(ev[0].store_hash).toBe(want);
      const lesson = String(lessons(p.globalRoot)[0].id);
      for (const store of [H, p.globalRoot]) {
        const v = read('tf9b', lesson, { store });
        expect([v.store_hash, v.origin, v.memory_id]).toEqual([want, ev[0].id, lesson]);
        expect(v.notes.some((n) => n.startsWith('foreign-store'))).toBe(false);
        expect(v.notes).toContain(`tool-failure:${ev[0].id}`);
      }
    } finally {
      fs.unlinkSync(H);
    }
  });

  it('TF10 version 3 rows keep the two-path rule behind a linked HIPPO_HOME, and a version 3 row with the version 4 hash is foreign', async (ctx) => {
    p = mk();
    initTestStore(p.globalRoot);
    fs.writeFileSync(
      path.join(p.globalRoot, 'config.json'),
      JSON.stringify({ deliveryLedger: { enabled: true }, pinnedInject: { promptRecall: false } }),
    );
    const G = link(p.globalRoot, path.join(p.dir, 'global-link'));
    if (G === null) return ctx.skip();
    try {
      const bare = path.join(p.dir, 'bare');
      fs.mkdirSync(bare);
      for (const [id, error] of [
        ['toolu_t10a', ERR_ALPHA],
        ['toolu_t10b', ERR_BETA],
        ['toolu_t10c', 'Command failed with exit code 4: the gamma queue worker ran out of memory'],
      ]) {
        await fail(p, 'tf10', { tool_use_id: id, error }, { cwd: bare, env: { HIPPO_HOME: G } });
      }
      const ev = events('tf10', p.globalRoot);
      const v4 = blockHash(realpathOrResolve(G));
      expect(ev.map((e) => [e.turn_seq, e.ledger_version, e.store_hash])).toEqual([1, 2, 3].map((n) => [n, V, v4]));
      const onLink = { store: G, global: G };
      expect(list('tf10', onLink).entries.map((e) => e.event_id)).toEqual(ev.map((e) => e.id));
      // Raw SQL: the test is about the reader's version rule, and no binary writes a version 3 row any more.
      const db = new DatabaseSync(path.join(p.globalRoot, 'hippo.db'));
      try {
        const set = db.prepare('UPDATE delivery_events SET ledger_version = 3, store_hash = ? WHERE id = ?');
        set.run(blockHash(path.resolve(G)), num(ev[0].id));
        set.run(blockHash(path.resolve(G)), num(ev[1].id));
        set.run(v4, num(ev[2].id));
      } finally {
        db.close();
      }
      const listing = list('tf10', onLink);
      expect(listing.entries.map((e) => e.event_id)).toEqual([ev[0].id, ev[1].id]);
      expect(listing.notes).toEqual([`foreign-store:${ev[2].id}`]);
      const first = String(lessons(p.globalRoot)[0].id);
      const v = read('tf10', first, { store: G, global: G });
      expect([v.origin, v.store_hash, v.notes.includes(`foreign-store:${ev[2].id}`)]).toEqual([
        ev[0].id,
        blockHash(path.resolve(G)),
        true,
      ]);
    } finally {
      fs.unlinkSync(G);
    }
  });
});

describe('controls', () => {
  const norm = (v: Verdict) => ({
    ...v,
    session_id: '',
    turn: v.turn === null ? null : v.turn.turn_seq,
    turns: v.turns.map((t) => ({
      ...t,
      event_id: 0,
      via_event_id: t.via_event_id === null ? null : 0,
      duplicates: t.duplicates.length,
    })),
    notes: v.notes.filter((n) => !n.startsWith('tool-failure')),
  });

  it('N-TF1 a routine failure between two prompts leaves a delivered and a never-loaded class read unchanged, turns included', async () => {
    p = mk();
    for (let i = 0; i < 3; i++) {
      seed(p.hippoRoot, `office note ${i}: the coffee machine schedule changes for team lunch on friday`, {
        created: `2026-06-0${i + 1}T00:00:00.000Z`,
      });
    }
    const away = seed(p.hippoRoot, 'a lesson from another repo: the staging cluster needs a manual warmup', {
      originProject: 'some-other-project',
      created: '2026-07-01T00:00:00.000Z',
    });
    const pin = String(rows('SELECT id FROM memories WHERE pinned = 1')[0].id);
    const turns = async (session: string, withFailure: boolean): Promise<TurnSpec[]> => {
      const a = await fireIn(p, session, P1);
      if (withFailure) await fail(p, session, ROUTINE);
      const b = await fireIn(p, session, P2);
      return [
        { prompt: P1, stdout: a.stdout },
        { prompt: P2, stdout: b.stdout },
      ];
    };
    const reads = (session: string, specs: TurnSpec[]) => ({
      pinned: read(session, pin, { transcript: doc(session, specs) }),
      away: read(session, away.id),
    });
    const plain = reads('ntf1-plain', await turns('ntf1-plain', false));
    const failed = reads('ntf1-fail', await turns('ntf1-fail', true));
    expect(events('ntf1-fail').map((e) => [e.event_type, e.turn_seq])).toEqual([
      ['prompt-submit', 1],
      ['tool-failure', 1],
      ['prompt-submit', 2],
    ]);
    expect(rows("SELECT outcome FROM failure_log WHERE outcome != 'skipped-routine'")).toEqual([]);
    expect([plain.pinned.class, plain.pinned.reason, plain.away.class, plain.away.reason]).toEqual([
      'application-unknown',
      null,
      'not-retrieved',
      'not-loaded',
    ]);
    expect(plain.away.turns).toHaveLength(2);
    expect(norm(failed.pinned)).toEqual(norm(plain.pinned));
    expect(norm(failed.away)).toEqual(norm(plain.away));
    const row = events('ntf1-fail')[1];
    expect(failed.away.notes).toContain(`tool-failure:${row.id}`);
  });

  it('N-TF3 a failure whose log row is gone, or never had one, reads log-missing with no lesson', async () => {
    p = mk();
    await fail(p, 'ntf3', { tool_use_id: 'toolu_gone' });
    await fail(p, 'ntf3', { tool_use_id: 'toolu_none', error: ERR_BETA });
    const ev = events('ntf3');
    const log = logs();
    expect(list('ntf3').entries.map((e) => [e.outcome, e.lesson === null])).toEqual([
      ['stored', false],
      ['stored', false],
    ]);
    // Raw SQL: pruning drops log rows on its own clock, and the reader's handling of the dangling id is what is tested.
    const db = new DatabaseSync(path.join(p.hippoRoot, 'hippo.db'));
    try {
      db.prepare('DELETE FROM failure_log WHERE id = ?').run(num(log[0].id));
      db.prepare('UPDATE delivery_events SET failure_id = NULL WHERE id = ?').run(num(ev[1].id));
    } finally {
      db.close();
    }
    expect(lessons()).toHaveLength(2);
    expect(list('ntf3').entries).toEqual([
      {
        event_id: ev[0].id,
        turn_seq: 1,
        after_prompt_turn: null,
        tool_use_id: 'toolu_gone',
        failure_id: log[0].id,
        outcome: 'log-missing',
        tool: null,
        duplicates: 0,
        lesson: null,
      },
      {
        event_id: ev[1].id,
        turn_seq: 2,
        after_prompt_turn: null,
        tool_use_id: 'toolu_none',
        failure_id: null,
        outcome: 'log-missing',
        tool: null,
        duplicates: 0,
        lesson: null,
      },
    ]);
    expect(read('ntf3', lessonWith('alpha')).origin).toBeNull();
  });

  it("N-TF4 another tenant's failure under the same session id is not listed", async () => {
    p = mk();
    await fail(p, 'ntf4', { tool_use_id: 'toolu_mine' });
    await fail(p, 'ntf4', { tool_use_id: 'toolu_theirs', error: ERR_BETA }, { env: { HIPPO_TENANT: 'other' } });
    expect(events('ntf4').map((e) => e.tool_use_id)).toEqual(['toolu_mine']);
    const theirs = events('ntf4', p.hippoRoot, 'other');
    expect(theirs.map((e) => [e.tenant_id, e.tool_use_id])).toEqual([['other', 'toolu_theirs']]);
    expect(list('ntf4').entries.map((e) => e.tool_use_id)).toEqual(['toolu_mine']);
    expect(list('ntf4', { tenant: 'other' }).entries.map((e) => [e.event_id, e.tool_use_id])).toEqual([
      [theirs[0].id, 'toolu_theirs'],
    ]);
  });

  it('N-TF5 a copied store lists nothing and notes the foreign row', async () => {
    p = mk();
    await fail(p, 'ntf5', { tool_use_id: 'toolu_copy' });
    const [row] = events('ntf5');
    const copyProj = path.join(p.dir, 'copy', 'proj');
    fs.cpSync(p.proj, copyProj, { recursive: true });
    const copy = path.join(copyProj, '.hippo');
    expect(events('ntf5', copy).map((e) => e.id)).toEqual([row.id]);
    expect(list('ntf5').entries).toHaveLength(1);
    expect(list('ntf5', { store: copy })).toEqual({ entries: [], notes: [`foreign-store:${row.id}`] });
  });
});

describe('invariance I4 and the command line', () => {
  const A = { tool_use_id: 'toolu_a' };
  const B = { tool_use_id: 'toolu_b' };
  const CALLS = {
    tf1: [payload('i4', { tool_use_id: 'toolu_tf1' })],
    tf2: [payload('i4', ROUTINE)],
    tf3: [payload('i4', A), payload('i4', A), payload('i4', B), payload('i4', B)],
  };

  async function drive(at: Project, calls: string[]) {
    const runs: Array<[number, string, string]> = [];
    for (const input of calls) {
      const r = await hippoIn(at, ['capture-error'], { input });
      runs.push([
        r.status,
        r.stdout,
        r.stderr
          .split(at.dir)
          .join('<dir>')
          .replace(/\(node:\d+\)/g, '(node:<pid>)'),
      ]);
    }
    const log = rowsAt(at.hippoRoot, 'SELECT * FROM failure_log ORDER BY id').map((r) =>
      Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id' && k !== 'ts')),
    );
    const memories = loadAllEntries(at.hippoRoot, 'default')
      .filter((m) => m.source === 'tool-failure')
      .map((m) => ({ content: m.content, tags: m.tags, source: m.source, confidence: m.confidence }));
    return { runs, log, memories };
  }
  const count = (at: Project): number => num(rowsAt(at.hippoRoot, 'SELECT COUNT(*) AS c FROM delivery_events')[0].c);

  it.each(Object.entries(CALLS))(
    'I4 %s: capture-error with the ledger off and on gives the same output, log row and memory',
    async (_name, calls) => {
      const off = mk({ ledger: false });
      const on = mk();
      const a = await drive(off, calls);
      const b = await drive(on, calls);
      expect([count(off), count(on)]).toEqual([0, calls.length]);
      expect(a.runs.map((r) => r[0])).toEqual(calls.map(() => 0));
      expect(b).toEqual(a);
      expect(a.log).toHaveLength(calls.length);
    },
  );

  it('TF-CLI the script prints the listing and refuses --memory, --key or a missing session', async () => {
    p = mk();
    await fail(p, 'cli', { tool_use_id: 'toolu_cli' });
    const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    const ok = run('--store', p.hippoRoot, '--session', 'cli', '--tool-failures', '--no-global');
    expect(ok.status, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual(JSON.parse(JSON.stringify(list('cli'))));
    expect(JSON.parse(ok.stdout).entries).toHaveLength(1);
    for (const extra of [
      ['--memory', 'mem_1'],
      ['--key', 'text'],
      ['--memory', 'mem_1', '--key', 'text'],
    ]) {
      const bad = run('--store', p.hippoRoot, '--session', 'cli', '--tool-failures', ...extra);
      expect([bad.status, bad.stdout, bad.stderr.includes('usage:')]).toEqual([2, '', true]);
    }
    const noSession = run('--store', p.hippoRoot, '--tool-failures');
    expect([noSession.status, noSession.stdout]).toEqual([2, '']);
  });
});
