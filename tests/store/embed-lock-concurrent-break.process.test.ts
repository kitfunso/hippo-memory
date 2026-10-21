// Two processes find the same dead holder's lock at once: exactly one takes it and the other waits.
import { describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRoot } from '../_helpers/make-root.js';

const CONTENDER = join(import.meta.dirname, '..', '_helpers', 'embed-lock-contender.mjs');
const START_DELAY_MS = 2_000;
const POLL_MS = 50;
const POLLS = 400;

/** The pid of a process that has already exited. */
const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid;

const exited = (child: ChildProcess): Promise<void> => new Promise((resolve) => child.once('close', () => resolve()));

async function resultOf(root: string, id: string): Promise<{ token: string | null }> {
  const file = join(root, `result-${id}.json`);
  for (let i = 0; i < POLLS && !existsSync(file); i++) await new Promise((r) => setTimeout(r, POLL_MS));
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('breaking a dead holder embedding lock from two processes', () => {
  it('lets exactly one waiter take it', async () => {
    const root = makeRoot('embed-lock-break');
    writeFileSync(join(root, 'embeddings.lock'), `${deadPid()}:gone`);
    const goAt = String(Date.now() + START_DELAY_MS);
    const children = ['a', 'b'].map((id) => spawn(process.execPath, [CONTENDER, root, id, goAt], { stdio: 'inherit' }));

    const results = [await resultOf(root, 'a'), await resultOf(root, 'b')];
    writeFileSync(join(root, 'done'), '');
    await Promise.all(children.map(exited));

    expect(results.filter((r) => r.token !== null)).toHaveLength(1);
    expect(results.filter((r) => r.token === null)).toHaveLength(1);
  }, 30_000);
});
