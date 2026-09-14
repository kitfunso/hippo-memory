// W2b leases, heartbeat and reclaim (trajectories/01M2EA6D1PVF2H25CGHE12JJ44/plan.md).
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import {
  createCard,
  loadCard,
  loadCardRuns,
  loadCardComments,
  claimCard,
  heartbeatCard,
  blockCard,
  reviewCard,
  completeCard,
  reclaimExpiredCards,
  saveSessionHandoff,
  loadLatestHandoffForCard,
} from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { CARD_LEASE_MS } from '../src/card.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-w2b-leases-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function pastIso(): string {
  return new Date(Date.now() - 1000).toISOString();
}

describe('T1 claim', () => {
  it('sets a CARD_LEASE_MS lease and returns the live run id; a second claim after a block gets a new run id', () => {
    const card = createCard(root, 'default', { title: 'T1 ready' });
    const claimed = claimCard(root, 'default', card.id, 'r1');
    expect(claimed).not.toBeNull();
    const liveRun = loadCardRuns(root, 'default', card.id).find((r) => !r.ended);
    expect(claimed!.runId).toBe(liveRun!.id);
    expect(claimed!.leaseUntil).toHaveLength(24);
    expect(claimed!.heartbeatAt).toHaveLength(24);
    expect(Date.parse(claimed!.leaseUntil!) - Date.parse(claimed!.heartbeatAt!)).toBe(CARD_LEASE_MS);
    expect(claimed!.heartbeatAt).toBe(claimed!.updatedAt);

    blockCard(root, 'default', card.id, 'why');
    const reclaimed = claimCard(root, 'default', card.id, 'r2');
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.runId).not.toBe(claimed!.runId);
  });

  it('sets a lease when claimed from blocked', () => {
    const card = createCard(root, 'default', { title: 'T1 blocked' });
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET status = 'blocked' WHERE id = ?`).run(card.id);
    } finally {
      closeHippoDb(db);
    }
    const claimed = claimCard(root, 'default', card.id, 'r1');
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('running');
    expect(claimed!.leaseUntil).toHaveLength(24);
    const liveRun = loadCardRuns(root, 'default', card.id).find((r) => !r.ended);
    expect(liveRun!.id).toBe(claimed!.runId);
  });
});

describe('T2 heartbeat', () => {
  it('extends a future lease and leaves updatedAt unchanged', () => {
    const card = createCard(root, 'default', { title: 'T2 future' });
    const claimed = claimCard(root, 'default', card.id, 'r1')!;
    const hb = heartbeatCard(root, 'default', card.id, claimed.runId);
    expect(hb).not.toBeNull();
    expect(Date.parse(hb!.leaseUntil!)).toBeGreaterThanOrEqual(Date.parse(claimed.leaseUntil!));
    expect(hb!.updatedAt).toBe(claimed.updatedAt);
  });

  it('revives a passed lease and leaves updatedAt unchanged', () => {
    const card = createCard(root, 'default', { title: 'T2 passed' });
    const claimed = claimCard(root, 'default', card.id, 'r1')!;
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET lease_until = ? WHERE id = ?`).run(pastIso(), card.id);
    } finally {
      closeHippoDb(db);
    }
    const hb = heartbeatCard(root, 'default', card.id, claimed.runId);
    expect(hb).not.toBeNull();
    expect(Date.parse(hb!.leaseUntil!)).toBeGreaterThan(Date.now());
    expect(hb!.updatedAt).toBe(claimed.updatedAt);
  });

  it('adopts a NULL lease left by a 1.40.0-era claim and leaves updatedAt unchanged', () => {
    const card = createCard(root, 'default', { title: 'T2 null' });
    const claimed = claimCard(root, 'default', card.id, 'r1')!;
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET lease_until = NULL, heartbeat_at = NULL WHERE id = ?`).run(card.id);
    } finally {
      closeHippoDb(db);
    }
    const hb = heartbeatCard(root, 'default', card.id, claimed.runId);
    expect(hb).not.toBeNull();
    expect(hb!.leaseUntil).not.toBeNull();
    expect(hb!.updatedAt).toBe(claimed.updatedAt);
  });
});

describe('T3 refusals', () => {
  it('a stale run id returns null on heartbeat and leaves the row identical', () => {
    const card = createCard(root, 'default', { title: 'T3 stale' });
    claimCard(root, 'default', card.id, 'r1');
    blockCard(root, 'default', card.id, 'why');
    const first = loadCardRuns(root, 'default', card.id).find((r) => r.runtime === 'r1')!;
    claimCard(root, 'default', card.id, 'r2');
    const before = loadCard(root, 'default', card.id);
    expect(heartbeatCard(root, 'default', card.id, first.id)).toBeNull();
    expect(loadCard(root, 'default', card.id)).toEqual(before);
  });

  it('an unknown card id or another tenant\'s throws unknown card id on heartbeat', () => {
    const card = createCard(root, 'default', { title: 'T3 unknown hb' });
    claimCard(root, 'default', card.id, 'r1');
    expect(() => heartbeatCard(root, 'default', 'nope', 1)).toThrow('unknown card id: nope');
    expect(() => heartbeatCard(root, 'tenant2', card.id, 1)).toThrow(`unknown card id: ${card.id}`);
  });

  it('an unknown card id or another tenant\'s throws unknown card id on block, review and complete even with a run id', () => {
    const card = createCard(root, 'default', { title: 'T3 unknown brc' });
    const claimed = claimCard(root, 'default', card.id, 'r1')!;
    expect(() => blockCard(root, 'default', 'nope', 'why', claimed.runId)).toThrow('unknown card id: nope');
    expect(() => blockCard(root, 'tenant2', card.id, 'why', claimed.runId)).toThrow(`unknown card id: ${card.id}`);
    expect(() => reviewCard(root, 'default', 'nope', claimed.runId)).toThrow('unknown card id: nope');
    expect(() => reviewCard(root, 'tenant2', card.id, claimed.runId)).toThrow(`unknown card id: ${card.id}`);
    expect(() => completeCard(root, 'default', 'nope', 'success', claimed.runId)).toThrow('unknown card id: nope');
    expect(() => completeCard(root, 'tenant2', card.id, 'success', claimed.runId)).toThrow(`unknown card id: ${card.id}`);
  });

  it('heartbeat returns null, not throws, for every non-running status', () => {
    const nonRunning = ['backlog', 'ready', 'blocked', 'review', 'done', 'shelved'];
    for (const status of nonRunning) {
      const card = createCard(root, 'default', { title: `T3 ${status}` });
      const db = openHippoDb(root);
      try {
        db.prepare(`UPDATE cards SET status = ? WHERE id = ?`).run(status, card.id);
      } finally {
        closeHippoDb(db);
      }
      expect(heartbeatCard(root, 'default', card.id, 1)).toBeNull();
    }
  });

  it('an invalid run id throws Invalid run id on heartbeat, block, review and complete before the store opens', () => {
    const card = createCard(root, 'default', { title: 'T3 invalid run id' });
    claimCard(root, 'default', card.id, 'r1');
    const badRunIds = [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1];
    for (const bad of badRunIds) {
      const message = `Invalid run id: ${bad} (expected a positive integer)`;
      expect(() => heartbeatCard(root, 'default', card.id, bad)).toThrow(message);
      expect(() => blockCard(root, 'default', card.id, 'why', bad)).toThrow(message);
      expect(() => reviewCard(root, 'default', card.id, bad)).toThrow(message);
      expect(() => completeCard(root, 'default', card.id, 'success', bad)).toThrow(message);
    }
  });
});

describe('T4 sweep', () => {
  it('reclaims running cards with a passed or NULL lease, in id order, and leaves everything else alone', () => {
    const passed = createCard(root, 'default', { title: 'T4 passed' });
    const future = createCard(root, 'default', { title: 'T4 future' });
    const nullLease = createCard(root, 'default', { title: 'T4 null' });
    const readyCard = createCard(root, 'default', { title: 'T4 ready' });
    const backlogParent = createCard(root, 'default', { title: 'T4 backlog parent' });
    const backlogCard = createCard(root, 'default', { title: 'T4 backlog', dependsOn: [backlogParent.id] });
    const reviewingCard = createCard(root, 'default', { title: 'T4 review' });
    const blockedCard = createCard(root, 'default', { title: 'T4 blocked' });
    const doneCard = createCard(root, 'default', { title: 'T4 done' });
    const shelvedCard = createCard(root, 'default', { title: 'T4 shelved' });
    const otherTenant = createCard(root, 'tenant2', { title: 'T4 other tenant' });

    claimCard(root, 'default', passed.id, 'r1');
    claimCard(root, 'default', future.id, 'r2');
    claimCard(root, 'default', nullLease.id, 'r3');
    claimCard(root, 'default', reviewingCard.id, 'r5');
    reviewCard(root, 'default', reviewingCard.id);
    claimCard(root, 'default', blockedCard.id, 'r6');
    blockCard(root, 'default', blockedCard.id, 'why');
    claimCard(root, 'default', doneCard.id, 'r7');
    reviewCard(root, 'default', doneCard.id);
    completeCard(root, 'default', doneCard.id, 'success');
    claimCard(root, 'default', shelvedCard.id, 'r8');
    reviewCard(root, 'default', shelvedCard.id);
    completeCard(root, 'default', shelvedCard.id, 'failure');
    claimCard(root, 'tenant2', otherTenant.id, 'r9');

    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET lease_until = ? WHERE id = ?`).run(pastIso(), passed.id);
      db.prepare(`UPDATE cards SET lease_until = NULL, heartbeat_at = NULL WHERE id = ?`).run(nullLease.id);
      db.prepare(`UPDATE cards SET lease_until = ? WHERE id = ? AND tenant_id = ?`).run(pastIso(), otherTenant.id, 'tenant2');
    } finally {
      closeHippoDb(db);
    }

    saveSessionHandoff(root, 'default', {
      version: 1, sessionId: 'sess-1', summary: 'before sweep', nextAction: undefined, artifacts: [], cardId: passed.id,
    });
    const handoffBefore = loadLatestHandoffForCard(root, 'default', passed.id);

    const reclaimed = reclaimExpiredCards(root, 'default');
    expect(reclaimed).toHaveLength(2);
    expect(new Set(reclaimed)).toEqual(new Set([passed.id, nullLease.id]));
    expect(reclaimed).toEqual([...reclaimed].sort());

    for (const id of reclaimed) {
      const card = loadCard(root, 'default', id);
      expect(card?.status).toBe('ready');
      expect(card?.assigneeRuntime).toBeNull();
      expect(card?.leaseUntil).toBeNull();
      expect(card?.heartbeatAt).toBeNull();
      const runs = loadCardRuns(root, 'default', id);
      expect(runs[0]?.ended).not.toBeNull();
      expect(runs[0]?.outcome).toBe('reclaimed');
    }

    expect(loadCard(root, 'default', future.id)?.status).toBe('running');
    expect(loadCard(root, 'default', readyCard.id)?.status).toBe('ready');
    expect(loadCard(root, 'default', reviewingCard.id)?.status).toBe('review');
    expect(loadCard(root, 'default', blockedCard.id)?.status).toBe('blocked');
    expect(loadCard(root, 'default', backlogCard.id)?.status).toBe('backlog');
    expect(loadCard(root, 'default', doneCard.id)?.status).toBe('done');
    expect(loadCard(root, 'default', shelvedCard.id)?.status).toBe('shelved');
    expect(loadCard(root, 'tenant2', otherTenant.id)?.status).toBe('running');

    expect(loadLatestHandoffForCard(root, 'default', passed.id)).toEqual(handoffBefore);
    expect(loadCardComments(root, 'default', passed.id)).toEqual([]);
  });
});

describe('T5 a reclaimed runtime\'s run id is refused', () => {
  it('rejects the old run id after reclaim and a new claim; the new run id is accepted', () => {
    const parent = createCard(root, 'default', { title: 'T5 parent' });
    const child = createCard(root, 'default', { title: 'T5 child', dependsOn: [parent.id] });
    const r1 = claimCard(root, 'default', parent.id, 'r1')!;

    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET lease_until = ? WHERE id = ?`).run(pastIso(), parent.id);
    } finally {
      closeHippoDb(db);
    }
    expect(reclaimExpiredCards(root, 'default')).toEqual([parent.id]);

    const r2 = claimCard(root, 'default', parent.id, 'r2')!;
    expect(r2.runId).not.toBe(r1.runId);

    const before = loadCard(root, 'default', parent.id);
    expect(heartbeatCard(root, 'default', parent.id, r1.runId)).toBeNull();
    expect(blockCard(root, 'default', parent.id, 'why', r1.runId)).toBeNull();
    expect(reviewCard(root, 'default', parent.id, r1.runId)).toBeNull();
    expect(loadCard(root, 'default', parent.id)).toEqual(before);

    const reviewed = reviewCard(root, 'default', parent.id, r2.runId);
    expect(reviewed?.status).toBe('review');

    expect(completeCard(root, 'default', parent.id, 'success', r1.runId)).toBeNull();
    expect(completeCard(root, 'default', parent.id, 'failure', r1.runId)).toBeNull();
    expect(completeCard(root, 'default', parent.id, 'partial', r1.runId)).toBeNull();
    expect(loadCard(root, 'default', parent.id)?.status).toBe('review');
    const liveRuns = loadCardRuns(root, 'default', parent.id).filter((run) => !run.ended);
    expect(liveRuns).toHaveLength(1);
    expect(liveRuns[0]?.id).toBe(r2.runId);
    expect(loadCard(root, 'default', child.id)?.status).toBe('backlog');

    const completed = completeCard(root, 'default', parent.id, 'success', r2.runId);
    expect(completed?.card.status).toBe('done');
    expect(completed?.promotedChildren).toEqual([child.id]);
  });
});

describe('T6 without a run id', () => {
  it('block, review and complete behave as in 1.40.0 when runId is omitted', () => {
    const card = createCard(root, 'default', { title: 'T6 no run id' });
    claimCard(root, 'default', card.id, 'r1');
    const blocked = blockCard(root, 'default', card.id, 'why');
    expect(blocked?.status).toBe('blocked');
    claimCard(root, 'default', card.id, 'r2');
    const reviewed = reviewCard(root, 'default', card.id);
    expect(reviewed?.status).toBe('review');
    const completed = completeCard(root, 'default', card.id, 'success');
    expect(completed?.card.status).toBe('done');
  });

  it('a card whose lease has passed but is not yet swept still takes a block or review with its live run id', () => {
    const card = createCard(root, 'default', { title: 'T6 passed not swept' });
    const claimed = claimCard(root, 'default', card.id, 'r1')!;
    const blockMe = createCard(root, 'default', { title: 'T6 passed not swept, block' });
    const blockClaim = claimCard(root, 'default', blockMe.id, 'r2')!;
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET lease_until = ? WHERE id = ?`).run(pastIso(), card.id);
      db.prepare(`UPDATE cards SET lease_until = ? WHERE id = ?`).run(pastIso(), blockMe.id);
    } finally {
      closeHippoDb(db);
    }
    const reviewed = reviewCard(root, 'default', card.id, claimed.runId);
    expect(reviewed?.status).toBe('review');
    const blocked = blockCard(root, 'default', blockMe.id, 'why', blockClaim.runId);
    expect(blocked?.status).toBe('blocked');
  });
});

describe('T7 invariant', () => {
  function assertInvariant(id: string) {
    const card = loadCard(root, 'default', id)!;
    expect(card.status === 'running').toBe(card.leaseUntil !== null);
    expect(card.status === 'running').toBe(card.heartbeatAt !== null);
    const liveRuns = loadCardRuns(root, 'default', id).filter((run) => !run.ended);
    expect(liveRuns.length === 1).toBe(card.status === 'running' || card.status === 'review');
  }

  it('holds after claim, heartbeat, block, a second claim, review, complete, reclaim and promotion', () => {
    const parent = createCard(root, 'default', { title: 'T7 parent' });
    const child = createCard(root, 'default', { title: 'T7 child', dependsOn: [parent.id] });
    assertInvariant(parent.id);
    assertInvariant(child.id);

    const claimed = claimCard(root, 'default', parent.id, 'r1')!;
    assertInvariant(parent.id);

    heartbeatCard(root, 'default', parent.id, claimed.runId);
    assertInvariant(parent.id);

    blockCard(root, 'default', parent.id, 'why');
    assertInvariant(parent.id);

    const second = claimCard(root, 'default', parent.id, 'r2')!;
    assertInvariant(parent.id);

    reviewCard(root, 'default', parent.id, second.runId);
    assertInvariant(parent.id);

    completeCard(root, 'default', parent.id, 'success', second.runId);
    assertInvariant(parent.id);
    assertInvariant(child.id);

    claimCard(root, 'default', child.id, 'r3');
    assertInvariant(child.id);
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET lease_until = ? WHERE id = ?`).run(pastIso(), child.id);
    } finally {
      closeHippoDb(db);
    }
    reclaimExpiredCards(root, 'default');
    assertInvariant(child.id);
  });
});

// Runs a real second thread (its own node:sqlite connection) so the write lock is genuinely
// held while this process's reclaimExpiredCards blocks under PRAGMA busy_timeout, not simulated in-process.
function holdLockThenRun(dbPath: string, sql: string, params: unknown[], holdMs: number) {
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    db.prepare(workerData.sql).run(...workerData.params);
    parentPort.postMessage('locked');
    setTimeout(() => {
      db.exec('COMMIT');
      db.close();
      parentPort.postMessage('released');
    }, workerData.holdMs);
  `;
  const worker = new Worker(workerCode, { eval: true, workerData: { dbPath, sql, params, holdMs } });
  const locked = new Promise<void>((resolve) => {
    worker.once('message', (msg) => { if (msg === 'locked') resolve(); });
  });
  const released = new Promise<void>((resolve) => {
    worker.on('message', (msg) => { if (msg === 'released') { worker.terminate(); resolve(); } });
  });
  return { locked, released };
}

describe('T8a reclaim under a real second connection', () => {
  it('reclaims an expired card while a real second connection holds the write lock with an unrelated write', async () => {
    const expiredCard = createCard(root, 'default', { title: 'T8a expired' });
    claimCard(root, 'default', expiredCard.id, 'r1');
    const otherReady = createCard(root, 'default', { title: 'T8a unrelated ready' });

    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET lease_until = ? WHERE id = ?`).run(pastIso(), expiredCard.id);
    } finally {
      closeHippoDb(db);
    }

    const dbPath = join(root, 'hippo.db');
    const { locked, released } = holdLockThenRun(
      dbPath,
      `UPDATE cards SET title = ? WHERE id = ?`,
      ['retitled', otherReady.id],
      600,
    );
    await locked;

    const started = Date.now();
    const reclaimed = reclaimExpiredCards(root, 'default');
    const elapsedMs = Date.now() - started;

    expect(reclaimed).toEqual([expiredCard.id]);
    expect(elapsedMs).toBeGreaterThan(300);
    await released;
  });
});

describe('T8b a heartbeat that commits while the sweep waits wins', () => {
  it('the sweep sees the revived lease and returns no ids; the card stays running with its run live', async () => {
    const card = createCard(root, 'default', { title: 'T8b revived' });
    const claimed = claimCard(root, 'default', card.id, 'r1')!;
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET lease_until = ? WHERE id = ?`).run(pastIso(), card.id);
    } finally {
      closeHippoDb(db);
    }

    const dbPath = join(root, 'hippo.db');
    const futureLease = new Date(Date.now() + CARD_LEASE_MS).toISOString();
    const { locked, released } = holdLockThenRun(
      dbPath,
      `UPDATE cards SET lease_until = ? WHERE id = ?`,
      [futureLease, card.id],
      600,
    );
    await locked;

    const reclaimed = reclaimExpiredCards(root, 'default');
    expect(reclaimed).toEqual([]);
    await released;

    const after = loadCard(root, 'default', card.id);
    expect(after?.status).toBe('running');
    const liveRuns = loadCardRuns(root, 'default', card.id).filter((run) => !run.ended);
    expect(liveRuns).toHaveLength(1);
    expect(liveRuns[0]?.id).toBe(claimed.runId);
  });
});

describe('CLI cases C1-C7: card heartbeat and reclaim through the built CLI', () => {
  const REPO_ROOT = join(__dirname, '..');
  const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js');

  beforeAll(() => {
    if (!existsSync(CLI_PATH) || !statSync(CLI_PATH).isFile()) {
      throw new Error(`dist/cli.js not found at ${CLI_PATH}. Run \`npm run build\` first.`);
    }
  });

  function toUtf8(value: string | Buffer | undefined): string {
    if (value === undefined) return '';
    return Buffer.isBuffer(value) ? value.toString('utf8') : value;
  }

  function runCli(cwd: string, env: Record<string, string>, ...args: string[]) {
    try {
      const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
        cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { out: stdout, status: 0 };
    } catch (e) {
      // SAFETY: execFileSync throws this exact shape (stdout/stderr/status) on a non-zero exit.
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
      return { out: toUtf8(err.stdout) + toUtf8(err.stderr), status: err.status ?? 1 };
    }
  }

  function setupCliHome() {
    const home = mkdtempSync(join(tmpdir(), 'hippo-w2b-cli-'));
    const globalDir = join(home, 'global');
    mkdirSync(globalDir, { recursive: true });
    const env = { HIPPO_HOME: globalDir };
    execSync('git init', { cwd: home, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: home, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: home, stdio: 'ignore' });
    execSync('git commit --allow-empty -m "init"', { cwd: home, stdio: 'ignore' });
    const init = runCli(home, env, 'init');
    expect(init.status, init.out).toBe(0);
    return { home, env };
  }

  // HIPPO_HOME isolates only the global store; the local store this drives follows cwd (home/.hippo).
  function backdateLease(home: string, cardId: string) {
    const db = openHippoDb(join(home, '.hippo'));
    try {
      db.prepare(`UPDATE cards SET lease_until = ? WHERE id = ?`).run(pastIso(), cardId);
    } finally {
      closeHippoDb(db);
    }
  }

  it('C1: card claim prints the run id and lease; card show prints Lease/Heartbeat/run lines', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'card', 'create', '--title', 't');
      const id = create.out.match(/Created card (\S+)/)?.[1]!;
      expect(id).toBeTruthy();

      const claim = runCli(home, env, 'card', 'claim', id, '--runtime', 'r1');
      expect(claim.status, claim.out).toBe(0);
      expect(claim.out).toMatch(/run \d+, lease until/);

      const show = runCli(home, env, 'card', 'show', id);
      expect(show.status, show.out).toBe(0);
      expect(show.out).toContain('- Lease until:');
      expect(show.out).toContain('- Heartbeat:');
      expect(show.out).toMatch(/- run \d+: r1 started/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C2: card heartbeat succeeds with the right run id and is refused with the wrong one, missing or invalid', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'card', 'create', '--title', 't');
      const id = create.out.match(/Created card (\S+)/)?.[1]!;
      const claim = runCli(home, env, 'card', 'claim', id, '--runtime', 'r1');
      const runId = claim.out.match(/run (\d+),/)?.[1]!;
      expect(runId).toBeTruthy();

      const ok = runCli(home, env, 'card', 'heartbeat', id, '--run', runId);
      expect(ok.status, ok.out).toBe(0);
      expect(ok.out).toContain('lease until');

      const wrong = runCli(home, env, 'card', 'heartbeat', id, '--run', '999');
      expect(wrong.status).toBe(1);
      expect(wrong.out).toContain('status running');
      expect(wrong.out).toContain('live run');

      const noRun = runCli(home, env, 'card', 'heartbeat', id);
      expect(noRun.status).toBe(1);
      expect(noRun.out).toContain('Usage: hippo card heartbeat <id> --run <n>');

      const badAbc = runCli(home, env, 'card', 'heartbeat', id, '--run', 'abc');
      expect(badAbc.status).toBe(1);
      expect(badAbc.out).toContain('Invalid --run');

      const badZero = runCli(home, env, 'card', 'heartbeat', id, '--run', '0');
      expect(badZero.status).toBe(1);
      expect(badZero.out).toContain('Invalid --run');

      const valueLess = runCli(home, env, 'card', 'heartbeat', id, '--run');
      expect(valueLess.status).toBe(1);
      expect(valueLess.out).toContain('--run requires a value');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C3, ROADMAP.md:1222 end to end: reclaim returns a crashed claimant\'s card to ready with its handoff intact', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'card', 'create', '--title', 't');
      const id = create.out.match(/Created card (\S+)/)?.[1]!;
      const claim = runCli(home, env, 'card', 'claim', id, '--runtime', 'r1');
      expect(claim.status, claim.out).toBe(0);

      const nothingYet = runCli(home, env, 'card', 'reclaim');
      expect(nothingYet.status, nothingYet.out).toBe(0);
      expect(nothingYet.out).toContain('No expired leases.');

      const handoff = runCli(home, env, 'handoff', 'create', '--summary', 's', '--card-id', id);
      expect(handoff.status, handoff.out).toBe(0);

      backdateLease(home, id);

      const swept = runCli(home, env, 'card', 'reclaim');
      expect(swept.status, swept.out).toBe(0);
      expect(swept.out).toContain(`Reclaimed card ${id} (now ready)`);

      const show = runCli(home, env, 'card', 'show', id, '--json');
      expect(show.status, show.out).toBe(0);
      const parsed = JSON.parse(show.out);
      expect(parsed.card.status).toBe('ready');
      expect(parsed.runs[0].outcome).toBe('reclaimed');
      expect(parsed.handoff.summary).toBe('s');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C4: card reclaim <id> prints the reclaim usage, exits 1 and reclaims nothing', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'card', 'create', '--title', 't');
      const id = create.out.match(/Created card (\S+)/)?.[1]!;
      runCli(home, env, 'card', 'claim', id, '--runtime', 'r1');
      backdateLease(home, id);

      const reclaim = runCli(home, env, 'card', 'reclaim', id);
      expect(reclaim.status).toBe(1);
      expect(reclaim.out).toContain('Usage: hippo card reclaim (sweeps every expired lease; use hippo card block <id> for one card)');

      const show = runCli(home, env, 'card', 'show', id, '--json');
      expect(JSON.parse(show.out).card.status).toBe('running');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C5: block, review and complete refuse a wrong --run and succeed with the right one', () => {
    const { home, env } = setupCliHome();
    try {
      const blockCase = runCli(home, env, 'card', 'create', '--title', 'block me');
      const blockId = blockCase.out.match(/Created card (\S+)/)?.[1]!;
      const blockClaim = runCli(home, env, 'card', 'claim', blockId, '--runtime', 'r1');
      const blockRunId = blockClaim.out.match(/run (\d+),/)?.[1]!;

      const blockWrong = runCli(home, env, 'card', 'block', blockId, '--reason', 'why', '--run', '999');
      expect(blockWrong.status).toBe(1);
      expect(blockWrong.out).toContain('status running');
      const blockRight = runCli(home, env, 'card', 'block', blockId, '--reason', 'why', '--run', blockRunId);
      expect(blockRight.status, blockRight.out).toBe(0);

      const reviewCase = runCli(home, env, 'card', 'create', '--title', 'review me');
      const reviewId = reviewCase.out.match(/Created card (\S+)/)?.[1]!;
      const reviewClaim = runCli(home, env, 'card', 'claim', reviewId, '--runtime', 'r1');
      const reviewRunId = reviewClaim.out.match(/run (\d+),/)?.[1]!;

      const reviewWrong = runCli(home, env, 'card', 'review', reviewId, '--run', '999');
      expect(reviewWrong.status).toBe(1);
      expect(reviewWrong.out).toContain('status running');
      const reviewRight = runCli(home, env, 'card', 'review', reviewId, '--run', reviewRunId);
      expect(reviewRight.status, reviewRight.out).toBe(0);

      const completeCase = runCli(home, env, 'card', 'create', '--title', 'complete me');
      const completeId = completeCase.out.match(/Created card (\S+)/)?.[1]!;
      const completeClaim = runCli(home, env, 'card', 'claim', completeId, '--runtime', 'r1');
      const completeRunId = completeClaim.out.match(/run (\d+),/)?.[1]!;
      runCli(home, env, 'card', 'review', completeId);

      const completeWrong = runCli(home, env, 'card', 'complete', completeId, '--outcome', 'success', '--run', '999');
      expect(completeWrong.status).toBe(1);
      expect(completeWrong.out).toContain('status review');
      const completeRight = runCli(home, env, 'card', 'complete', completeId, '--outcome', 'success', '--run', completeRunId);
      expect(completeRight.status, completeRight.out).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C6: --run is accepted on heartbeat, block, review and complete; card reclaim --force is refused', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'card', 'create', '--title', 't');
      const id = create.out.match(/Created card (\S+)/)?.[1]!;
      const claim = runCli(home, env, 'card', 'claim', id, '--runtime', 'r1');
      const runId = claim.out.match(/run (\d+),/)?.[1]!;

      const hb = runCli(home, env, 'card', 'heartbeat', id, '--run', runId);
      expect(hb.status, hb.out).toBe(0);

      const block = runCli(home, env, 'card', 'block', id, '--reason', 'why', '--run', runId);
      expect(block.status, block.out).toBe(0);

      const reclaim = runCli(home, env, 'card', 'claim', id, '--runtime', 'r2');
      const runId2 = reclaim.out.match(/run (\d+),/)?.[1]!;
      const review = runCli(home, env, 'card', 'review', id, '--run', runId2);
      expect(review.status, review.out).toBe(0);

      const complete = runCli(home, env, 'card', 'complete', id, '--outcome', 'success', '--run', runId2);
      expect(complete.status, complete.out).toBe(0);

      const reclaimForce = runCli(home, env, 'card', 'reclaim', '--force');
      expect(reclaimForce.status).toBe(1);
      expect(reclaimForce.out).toContain('Unknown flag --force for hippo card reclaim. Valid flags: (none)');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('C7 adversarial argv (feedback_drive_built_cli_after_each_fix_round): unknown ids, invalid --run and proto-key subcommands all fail cleanly', () => {
    const { home, env } = setupCliHome();
    try {
      const ctor = runCli(home, env, 'card', 'heartbeat', 'constructor', '--run', '1');
      expect(ctor.status).toBe(1);
      expect(ctor.out).toContain('unknown card id');

      const proto = runCli(home, env, 'card', 'heartbeat', '__proto__', '--run', '1');
      expect(proto.status).toBe(1);
      expect(proto.out).toContain('unknown card id');

      const create = runCli(home, env, 'card', 'create', '--title', 't');
      const id = create.out.match(/Created card (\S+)/)?.[1]!;
      runCli(home, env, 'card', 'claim', id, '--runtime', 'r1');

      const runCtor = runCli(home, env, 'card', 'heartbeat', id, '--run', 'constructor');
      expect(runCtor.status).toBe(1);
      expect(runCtor.out).toContain('Invalid --run: "constructor"');

      const runNeg = runCli(home, env, 'card', 'heartbeat', id, '--run', '-5');
      expect(runNeg.status).toBe(1);
      expect(runNeg.out).toContain('Invalid --run: "-5"');

      const runHuge = runCli(home, env, 'card', 'heartbeat', id, '--run', '9007199254740993');
      expect(runHuge.status).toBe(1);
      expect(runHuge.out).toContain('Invalid --run: "9007199254740993"');

      const reclaimProto = runCli(home, env, 'card', 'reclaim', '__proto__');
      expect(reclaimProto.status).toBe(1);
      expect(reclaimProto.out).toContain('Usage: hippo card reclaim (sweeps every expired lease; use hippo card block <id> for one card)');

      const equalsForm = runCli(home, env, 'card', 'heartbeat', id, '--run=5');
      expect(equalsForm.status).toBe(1);
      expect(equalsForm.out).toContain('Use --run <value>, not --run=5.');

      for (const result of [ctor, proto, runCtor, runNeg, runHuge, reclaimProto, equalsForm]) {
        expect(/^\s+at\s/m.test(result.out)).toBe(false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
