// The delivery reader through the z10-reconstruct command line and through linked store paths.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { blockHash } from '../../src/util/token-text.js';
import { realpathOrResolve } from '../../src/util/real-path.js';
import { seed, verdictOf, writeHostTranscript, type Verdict } from '../_helpers/host-transcript.js';
import { dispose, project, type Project } from '../_helpers/delivery-boundary.js';
import { fire } from '../_helpers/host-transcript.js';
import { trySymlink } from '../_helpers/symlink.js';
import { initTestStore } from '../_helpers/store-template.js';
import {
  SCRIPT,
  dir,
  useExitReaderStore,
  event,
  row,
  write,
  read,
  present,
  transcript,
} from '../_helpers/delivery-exit-reader.js';

useExitReaderStore();

describe('the command line', () => {
  it('R13 the script prints the verdict the function returns', () => {
    const m = present();
    const block = 'the block that was sent';
    write(event('r13', { emittedHash: blockHash(block), promptHash: blockHash('a prompt'), candidates: [row(m.id)] }));
    const t = transcript([{ prompt: 'a prompt', attach: block }]);
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--store', dir, '--session', 'r13', '--memory', m.id, '--transcript', t, '--no-global'],
      { encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(JSON.stringify(read('r13', m.id, { transcript: t }))));
    expect(JSON.parse(r.stdout).class).toBe('application-unknown');
  });

  it.each([
    ['no arguments', []],
    ['both a memory and a key', ['--store', 'x', '--session', 's', '--memory', 'a', '--key', 'b']],
    ['neither a memory nor a key', ['--store', 'x', '--session', 's']],
    ['an unknown flag', ['--store', 'x', '--session', 's', '--memory', 'a', '--bogus']],
    ['a flag with no value', ['--store', 'x', '--session', 's', '--memory']],
  ])('R14 %s exits 2 with usage on stderr', (_name, args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    expect([r.status, r.stdout, r.stderr.includes('usage:')]).toEqual([2, '', true]);
  });
});

describe('store paths through a link', () => {
  const PROMPT = 'first question about deploys';
  let p: Project;
  afterEach(() => dispose(p));

  /** A junction to `target`, or null when this machine cannot create one. */
  function link(target: string, l: string): string | null {
    return trySymlink(target, l, 'junction') ? l : null;
  }

  const rawRows = (root: string) => {
    const db = new DatabaseSync(path.join(root, 'hippo.db'), { readOnly: true });
    try {
      return db.prepare('SELECT store_hash, write_store FROM delivery_events').all();
    } finally {
      db.close();
    }
  };

  it('R26 a project reached through a linked folder', (ctx) => {
    p = project();
    const L = link(p.proj, path.join(p.dir, 'proj-link'));
    if (L === null) return ctx.skip();
    try {
      const r = fire(p, 'r26', PROMPT, { cwd: L });
      const rows = rawRows(p.hippoRoot);
      const want = blockHash(path.join(realpathOrResolve(p.proj), '.hippo'));
      expect(rows.map((x) => x.store_hash)).toEqual([want]);
      const t = writeHostTranscript(p, [{ prompt: PROMPT, stdout: r.stdout }], { name: 'r26' });
      const db = new DatabaseSync(path.join(p.hippoRoot, 'hippo.db'), { readOnly: true });
      const id = String(db.prepare('SELECT id FROM memories WHERE pinned = 1').get()?.id);
      db.close();
      for (const store of [p.hippoRoot, path.join(L, '.hippo')]) {
        const v = verdictOf({ store, session: 'r26', memory: id, transcript: t });
        expect(v.class).toBe('application-unknown');
        expect(v.notes.some((n: string) => n.startsWith('foreign-store'))).toBe(false);
        expect(v.store_hash).toBe(want);
      }
    } finally {
      fs.unlinkSync(L);
    }
  });

  it('R27 the global store through a linked HIPPO_HOME', (ctx) => {
    p = project();
    initTestStore(p.globalRoot);
    fs.writeFileSync(
      path.join(p.globalRoot, 'config.json'),
      JSON.stringify({ deliveryLedger: { enabled: true }, pinnedInject: { promptRecall: false } }),
    );
    const g = seed(p.globalRoot, 'PINNED: the global release checklist lists every region first', { pinned: true });
    const G = link(p.globalRoot, path.join(p.dir, 'global-link'));
    if (G === null) return ctx.skip();
    try {
      const bare = path.join(p.dir, 'bare');
      fs.mkdirSync(bare);
      const r = fire(p, 'r27', PROMPT, { cwd: bare, env: { HIPPO_HOME: G } });
      const want = blockHash(realpathOrResolve(G));
      expect(rawRows(p.globalRoot).map((x) => [x.store_hash, x.write_store])).toEqual([[want, 'global']]);
      const t = writeHostTranscript(p, [{ prompt: PROMPT, stdout: r.stdout }], { name: 'r27' });
      const v = verdictOf({ store: G, global: G, session: 'r27', memory: g.id, transcript: t });
      expect(v.class).toBe('application-unknown');
      expect(v.notes.some((n: string) => n.startsWith('foreign-store'))).toBe(false);
      expect(v.store_hash).toBe(want);
    } finally {
      fs.unlinkSync(G);
    }
  });

  it('R28 the command line classifies the global store behind a linked HIPPO_HOME under --no-global, with the link above the store', (ctx) => {
    p = project();
    initTestStore(p.globalRoot);
    fs.writeFileSync(
      path.join(p.globalRoot, 'config.json'),
      JSON.stringify({ deliveryLedger: { enabled: true }, pinnedInject: { promptRecall: false } }),
    );
    const g = seed(p.globalRoot, 'PINNED: the global release checklist lists every region first', { pinned: true });
    const L = link(p.dir, `${p.dir}-link`);
    if (L === null) return ctx.skip();
    const G = path.join(L, 'global');
    try {
      const bare = path.join(p.dir, 'bare');
      fs.mkdirSync(bare);
      const r = fire(p, 'r28', PROMPT, { cwd: bare, env: { HIPPO_HOME: G } });
      const t = writeHostTranscript(p, [{ prompt: PROMPT, stdout: r.stdout }], { name: 'r28' });
      const out = spawnSync(
        process.execPath,
        [SCRIPT, '--store', G, '--session', 'r28', '--memory', g.id, '--transcript', t, '--no-global'],
        { encoding: 'utf8', env: { ...process.env, HIPPO_HOME: G } },
      );
      expect(out.status, out.stderr).toBe(0);
      // SAFETY: the script prints exactly the verdict shape.
      const v = JSON.parse(out.stdout) as Verdict;
      expect(v.class).toBe('application-unknown');
      expect(v.notes.some((n) => n.startsWith('foreign-store'))).toBe(false);
      expect(v.store_hash).toBe(blockHash(realpathOrResolve(G)));
    } finally {
      fs.unlinkSync(L);
    }
  });
});
