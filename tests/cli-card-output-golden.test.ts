// Pins every `hippo card` subcommand's stdout, stderr and exit code, in process, so a reshuffle of cmdCard
// that changes a byte or an exit path fails here. Ids and timestamps are masked; their order is kept.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { cmdCard } from '../src/cli/card.js';
import { runInProcess } from './_helpers/run-in-process.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-card-golden-'));
  vi.stubEnv('HIPPO_HOME', join(root, 'global'));
  vi.stubEnv('HIPPO_TENANT', '');
  initStore(join(root, 'local'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** Replaces each distinct card id with its first-seen order and every ISO timestamp with <ts>. */
function masker(): (text: string) => string {
  const ids = new Map<string, string>();
  return (text) => text
    .replace(/card_[A-Za-z0-9]+/g, (id) => {
      if (!ids.has(id)) ids.set(id, `card_#${ids.size + 1}`);
      return ids.get(id)!;
    })
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>');
}

type Flags = Record<string, string | boolean | string[]>;

describe('hippo card output (in process)', () => {
  it('prints the same bytes and exit codes across every subcommand', async () => {
    const store = join(root, 'local');
    const mask = masker();
    const transcript: string[] = [];
    const ids: string[] = [];
    const step = async (label: string, args: string[], flags: Flags = {}): Promise<string> => {
      const r = await runInProcess(() => cmdCard(store, args, flags));
      transcript.push(`$ card ${label} -> ${r.status}\n--- stdout\n${mask(r.stdout)}--- stderr\n${mask(r.stderr)}`);
      return r.stdout;
    };
    const created = async (label: string, flags: Flags): Promise<string> => {
      const out = await step(label, ['create'], flags);
      const id = /Created card (card_\S+)/.exec(out)?.[1];
      if (!id) throw new Error(`no card id in: ${out}`);
      ids.push(id);
      return id;
    };

    await step('list (empty)', ['list']);
    await step('create (no title)', ['create']);
    await step('create (bad budget)', ['create'], { title: 't', budget: 'x' });
    await step('create (valueless depends-on)', ['create'], { title: 't', 'depends-on': true });
    await step('create (unknown flag)', ['create'], { title: 't', 'depend-on': 'x' });
    await step('create (missing parent)', ['create'], { title: 't', 'depends-on': ['card_missing'] });
    const parent = await created('create parent', { title: 'parent', repo: 'hippo', contract: 'ship it', budget: '3' });
    const child = await created('create child', { title: 'child', 'depends-on': [parent] });
    await step('list', ['list']);
    await step('list --json', ['list'], { json: true });
    await step('list --status bogus', ['list'], { status: 'bogus' });
    await step('list --status ready', ['list'], { status: 'ready' });
    await step('show (no id)', ['show']);
    await step('show (missing)', ['show', 'card_missing']);
    await step('claim (no runtime)', ['claim', parent]);
    await step('claim', ['claim', parent], { runtime: 'codex', session: 's1' });
    await step('claim (again)', ['claim', parent], { runtime: 'codex' });
    await step('heartbeat (bad run)', ['heartbeat', parent], { run: '0' });
    await step('heartbeat (no run)', ['heartbeat', parent]);
    await step('heartbeat (wrong run)', ['heartbeat', parent], { run: '99' });
    await step('heartbeat', ['heartbeat', parent], { run: '1' });
    await step('comment (no id)', ['comment']);
    await step('comment (missing card)', ['comment', 'card_missing'], { body: 'x' });
    await step('comment (no body)', ['comment', parent]);
    await step('comment', ['comment', parent], { body: 'first note', author: 'keith' });
    await step('show', ['show', parent]);
    await step('show child', ['show', child]);
    await step('block (no reason)', ['block', child]);
    await step('block (not running)', ['block', child], { reason: 'waiting' });
    await step('review (no id)', ['review']);
    await step('review (wrong run)', ['review', parent], { run: '99' });
    await step('review', ['review', parent], { run: '1' });
    await step('complete (bad outcome)', ['complete', parent], { outcome: 'meh' });
    await step('complete (wrong run)', ['complete', parent], { outcome: 'success', run: '99' });
    await step('complete', ['complete', parent], { outcome: 'success', run: '1' });
    await step('show --json', ['show', parent], { json: true });
    await step('claim child', ['claim', child], { runtime: 'claude' });
    await step('block', ['block', child], { reason: 'needs input', run: '2' });
    await step('reclaim (with id)', ['reclaim', child]);
    await step('reclaim', ['reclaim']);
    await step('unknown subcommand', ['bogus']);
    await step('no subcommand', []);

    expect(ids).toHaveLength(2);
    expect(transcript.join('\n')).toMatchSnapshot();
  });
});
