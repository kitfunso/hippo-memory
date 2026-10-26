// W2a work-queue cards: concurrent claim, completion, handoffs and the run each transition closes (tests 6-9).
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { cardDetailOf } from '../_helpers/card-detail.js';
import {
  createCard,
  loadCard,
  loadCardRuns,
  claimCard,
  blockCard,
  reviewCard,
  completeCard,
  saveSessionHandoff,
} from '../_helpers/root-forms.js';
import { root, useCardsRoot } from '../_helpers/work-queue-cards.js';

useCardsRoot();

// Runs a real second thread (its own node:sqlite connection) so the lock is genuinely
// held while this process's claimCard blocks under PRAGMA busy_timeout, not simulated in-process.
function holdLockThenRelease(dbPath: string, cardId: string, holdMs: number) {
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE cards SET status = 'running', assignee_runtime = 'first' WHERE id = ? AND status = 'ready'").run(workerData.cardId);
    parentPort.postMessage('locked');
    parentPort.once('message', () => setTimeout(() => {
      Atomics.store(workerData.holdEnded, 0, 1);
      db.exec('COMMIT');
      db.close();
      parentPort.postMessage('released');
    }, workerData.holdMs));
  `;
  // Set before COMMIT: the commit frees the lock, and the waiting call can return before this thread runs its next line.
  const holdEnded = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(workerCode, { eval: true, workerData: { dbPath, cardId, holdMs, holdEnded } });
  const locked = new Promise<void>((resolve) => {
    worker.once('message', (msg) => {
      if (msg === 'locked') resolve();
    });
  });
  const released = new Promise<void>((resolve) => {
    worker.on('message', (msg) => {
      if (msg === 'released') {
        worker.terminate();
        resolve();
      }
    });
  });
  // The hold is counted from this call, made right before the blocking one, so a stalled test thread cannot let the lock go early.
  const startHold = (): void => worker.postMessage('hold');
  return { locked, released, startHold, holdHadEnded: () => Atomics.load(holdEnded, 0) === 1 };
}

describe('concurrent claim', () => {
  it('a claim held open in another connection blocks claimCard, which then sees 0 rows once released', async () => {
    const card = await createCard(root, 'default', { title: 'Contested' });
    const dbPath = join(root, 'hippo.db');
    const { locked, released, startHold, holdHadEnded } = holdLockThenRelease(dbPath, card.id, 600);
    await locked;

    startHold();
    const result = await claimCard(root, 'default', card.id, 'second');
    const endedByReturn = holdHadEnded();

    expect(result).toBeNull();
    // A claim that did not wait returns while the lock is still held, before the hold ends.
    expect(endedByReturn).toBe(true);
    await released;
  });

  it('two sequential claims on the same ready card: the second returns null', async () => {
    const card = await createCard(root, 'default', { title: 'Sequential' });
    const first = await claimCard(root, 'default', card.id, 'first');
    const second = await claimCard(root, 'default', card.id, 'second');
    expect(first?.status).toBe('running');
    expect(second).toBeNull();
  });
});

describe('completeCard promotes only children whose parents are all done', () => {
  it('promotes B, leaves C in backlog, closes the open run', async () => {
    const a = await createCard(root, 'default', { title: 'A' });
    const d = await createCard(root, 'default', { title: 'D' });
    const b = await createCard(root, 'default', { title: 'B', dependsOn: [a.id] });
    const c = await createCard(root, 'default', { title: 'C', dependsOn: [a.id, d.id] });
    expect(b.status).toBe('backlog');
    expect(c.status).toBe('backlog');

    await claimCard(root, 'default', a.id, 'codex');
    await reviewCard(root, 'default', a.id);
    await claimCard(root, 'default', d.id, 'codex'); // D stays running, never completes.

    const result = await completeCard(root, 'default', a.id, 'success');
    expect(result).not.toBeNull();
    expect(result!.promotedChildren).toEqual([b.id]);
    expect((await loadCard(root, 'default', b.id))?.status).toBe('ready');
    expect((await loadCard(root, 'default', c.id))?.status).toBe('backlog');

    const runs = await loadCardRuns(root, 'default', a.id);
    expect(runs[0]?.ended).not.toBeNull();
    expect(runs[0]?.outcome).toBe('success');
  });
});

describe('claim -> block -> reclaim -> review -> complete closes exactly the live run', () => {
  it('the blocked run keeps outcome blocked; the reclaimed run gets the final outcome', async () => {
    const card = await createCard(root, 'default', { title: 'Reclaimed' });
    await claimCard(root, 'default', card.id, 'r1');
    await blockCard(root, 'default', card.id, 'waiting on input');
    await claimCard(root, 'default', card.id, 'r2');
    await reviewCard(root, 'default', card.id);
    const result = await completeCard(root, 'default', card.id, 'success');
    expect(result).not.toBeNull();

    const runs = await loadCardRuns(root, 'default', card.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.runtime).toBe('r2');
    expect(runs[0]?.ended).not.toBeNull();
    expect(runs[0]?.outcome).toBe('success');
    expect(runs[1]?.runtime).toBe('r1');
    expect(runs[1]?.ended).not.toBeNull();
    expect(runs[1]?.outcome).toBe('blocked');

    const finalCard = await loadCard(root, 'default', card.id);
    expect(finalCard?.status).toBe('done');
    expect(finalCard?.assigneeRuntime).toBe('r2');
  });
});

// Runs a real second connection that takes BEGIN IMMEDIATE, completes the parent, then
// commits, so createCard's parent-status probe is forced to happen after that commit.
function holdLockThenCompleteParent(dbPath: string, parentId: string, holdMs: number) {
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    parentPort.once('message', () => setTimeout(() => {
      db.prepare("UPDATE cards SET status = 'done', updated_at = ? WHERE id = ? AND tenant_id = ?")
        .run(new Date().toISOString(), workerData.parentId, 'default');
      Atomics.store(workerData.holdEnded, 0, 1);
      db.exec('COMMIT');
      db.close();
      parentPort.postMessage('released');
    }, workerData.holdMs));
  `;
  // Set before COMMIT: the commit frees the lock, and the waiting call can return before this thread runs its next line.
  const holdEnded = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(workerCode, { eval: true, workerData: { dbPath, parentId, holdMs, holdEnded } });
  const locked = new Promise<void>((resolve) => {
    worker.once('message', (msg) => {
      if (msg === 'locked') resolve();
    });
  });
  const released = new Promise<void>((resolve) => {
    worker.on('message', (msg) => {
      if (msg === 'released') {
        worker.terminate();
        resolve();
      }
    });
  });
  // The hold is counted from this call, made right before the blocking one, so a stalled test thread cannot let the lock go early.
  const startHold = (): void => worker.postMessage('hold');
  return { locked, released, startHold, holdHadEnded: () => Atomics.load(holdEnded, 0) === 1 };
}

describe('a parent completing while createCard waits for the write lock still yields a ready child', () => {
  it('createCard blocks on BEGIN IMMEDIATE, then reads the parent as done once the lock is released', async () => {
    const parent = await createCard(root, 'default', { title: 'Parent' });
    await claimCard(root, 'default', parent.id, 'codex');
    await reviewCard(root, 'default', parent.id); // in review, not done yet: a read before the commit would see this.

    const dbPath = join(root, 'hippo.db');
    const { locked, released, startHold, holdHadEnded } = holdLockThenCompleteParent(dbPath, parent.id, 300);
    await locked;

    startHold();
    const child = await createCard(root, 'default', { title: 'Child', dependsOn: [parent.id] });
    const endedByReturn = holdHadEnded();

    // A createCard that did not wait would return while the lock is still held, before the hold ends.
    expect(endedByReturn).toBe(true);
    expect(child.status).toBe('ready');
    expect((await loadCard(root, 'default', child.id))?.status).toBe('ready');
    await released;
  });
});

describe('completeCard from a non-review status returns null and touches nothing', () => {
  it('leaves card_deps and card_runs untouched', async () => {
    const parent = await createCard(root, 'default', { title: 'Still backlog' });
    const child = await createCard(root, 'default', { title: 'Child', dependsOn: [parent.id] });

    const before = (await cardDetailOf(root, 'default', child.id))?.deps;
    const result = await completeCard(root, 'default', parent.id, 'success');
    expect(result).toBeNull();

    const after = (await cardDetailOf(root, 'default', child.id))?.deps;
    expect(after).toEqual(before);
    expect(await loadCardRuns(root, 'default', parent.id)).toEqual([]);
    expect((await loadCard(root, 'default', parent.id))?.status).toBe('ready');
  });
});

describe('completeCard shelves a non-success outcome and releases no children', () => {
  it('failure leaves the card shelved, the child in backlog, and closes the run with outcome failure', async () => {
    const a = await createCard(root, 'default', { title: 'A' });
    const b = await createCard(root, 'default', { title: 'B', dependsOn: [a.id] });
    await claimCard(root, 'default', a.id, 'codex');
    await reviewCard(root, 'default', a.id);

    const result = await completeCard(root, 'default', a.id, 'failure');
    expect(result).not.toBeNull();
    expect(result!.card.status).toBe('shelved');
    expect(result!.promotedChildren).toEqual([]);
    expect((await loadCard(root, 'default', b.id))?.status).toBe('backlog');

    const runs = await loadCardRuns(root, 'default', a.id);
    expect(runs[0]?.ended).not.toBeNull();
    expect(runs[0]?.outcome).toBe('failure');
  });

  it('partial leaves the card shelved, the child in backlog, and closes the run with outcome partial', async () => {
    const a = await createCard(root, 'default', { title: 'A' });
    const b = await createCard(root, 'default', { title: 'B', dependsOn: [a.id] });
    await claimCard(root, 'default', a.id, 'codex');
    await reviewCard(root, 'default', a.id);

    const result = await completeCard(root, 'default', a.id, 'partial');
    expect(result).not.toBeNull();
    expect(result!.card.status).toBe('shelved');
    expect(result!.promotedChildren).toEqual([]);
    expect((await loadCard(root, 'default', b.id))?.status).toBe('backlog');

    const runs = await loadCardRuns(root, 'default', a.id);
    expect(runs[0]?.ended).not.toBeNull();
    expect(runs[0]?.outcome).toBe('partial');
  });

  it('a shelved parent never releases a child even after every other parent completes', async () => {
    const a = await createCard(root, 'default', { title: 'A' });
    const c = await createCard(root, 'default', { title: 'C' });
    const b = await createCard(root, 'default', { title: 'B', dependsOn: [a.id, c.id] });

    await claimCard(root, 'default', a.id, 'codex');
    await reviewCard(root, 'default', a.id);
    await completeCard(root, 'default', a.id, 'failure');
    expect((await loadCard(root, 'default', b.id))?.status).toBe('backlog');

    await claimCard(root, 'default', c.id, 'codex');
    await reviewCard(root, 'default', c.id);
    const result = await completeCard(root, 'default', c.id, 'success');
    expect(result!.promotedChildren).toEqual([]);
    expect((await loadCard(root, 'default', b.id))?.status).toBe('backlog');
  });

  it('createCard with dependsOn a shelved parent creates the child in backlog', async () => {
    const a = await createCard(root, 'default', { title: 'A' });
    await claimCard(root, 'default', a.id, 'codex');
    await reviewCard(root, 'default', a.id);
    await completeCard(root, 'default', a.id, 'failure');
    expect((await loadCard(root, 'default', a.id))?.status).toBe('shelved');

    const b = await createCard(root, 'default', { title: 'B', dependsOn: [a.id] });
    expect(b.status).toBe('backlog');
  });
});

describe('the latest handoff filed against a card', () => {
  it('round-trips a handoff saved with a matching cardId and ignores others', async () => {
    const card = await createCard(root, 'default', { title: 'Handoff target' });
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-1',
      summary: 'wrong card',
      nextAction: undefined,
      artifacts: [],
      cardId: 'other-card',
    });
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-2',
      summary: 'no card',
      nextAction: undefined,
      artifacts: [],
    });
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-3',
      summary: 'right card',
      nextAction: undefined,
      artifacts: [],
      cardId: card.id,
    });

    const handoff = (await cardDetailOf(root, 'default', card.id))?.handoff;
    expect(handoff?.summary).toBe('right card');
    expect(handoff?.constraints).toEqual([]);
  });
});
