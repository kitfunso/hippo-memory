// A waiter breaks a dead holder's embedding lock only by creating the breaker file, and re-reads the holder first.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { releaseEmbedLock, tryEmbedLock } from '../../src/store/sqlite/embed-lock.js';
import { makeRoot } from '../_helpers/make-root.js';

const deadPid = (): number => spawnSync(process.execPath, ['-e', '0']).pid;

interface DeadHolderRoot {
  root: string;
  lock: string;
  breaker: string;
}

function takeLock(root: string): string {
  const token = tryEmbedLock(root);
  if (token === null) throw new Error('the lock was busy');
  return token;
}

function rootWithDeadHolder(): DeadHolderRoot {
  const root = makeRoot('embed-lock-unit');
  const lock = join(root, 'embeddings.lock');
  writeFileSync(lock, `${deadPid()}:gone`);
  return { root, lock, breaker: `${lock}.breaker` };
}

describe('tryEmbedLock on a dead holder', () => {
  it('takes the lock and leaves no breaker file behind', () => {
    const { root, lock, breaker } = rootWithDeadHolder();
    const token = takeLock(root);
    expect(readFileSync(lock, 'utf8')).toBe(token);
    expect(existsSync(breaker)).toBe(false);
    releaseEmbedLock(root, token);
  });

  it('waits while another waiter is breaking it, and leaves the dead lock to that waiter', () => {
    const { root, lock, breaker } = rootWithDeadHolder();
    const before = readFileSync(lock, 'utf8');
    writeFileSync(breaker, 'other-waiter');
    expect(tryEmbedLock(root)).toBeNull();
    expect(readFileSync(lock, 'utf8')).toBe(before);
    expect(readFileSync(breaker, 'utf8')).toBe('other-waiter');
  });

  it('clears a breaker file its waiter died holding, then takes the lock on the next ask', () => {
    const { root, breaker } = rootWithDeadHolder();
    writeFileSync(breaker, 'crashed-waiter');
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(breaker, longAgo, longAgo);
    expect(tryEmbedLock(root)).toBeNull();
    expect(existsSync(breaker)).toBe(false);
    releaseEmbedLock(root, takeLock(root));
  });
});
