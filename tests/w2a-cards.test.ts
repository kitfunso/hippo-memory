// W2a work-queue cards (trajectories/01M2D5VSYJFK4YXQ0RG2NGCPYJ/plan.md), tests 1,2,4-12.
// Test 3 (self-heal parity) lives in tests/db-continuity-tables-self-heal.test.ts's CONTINUITY_TABLES.
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import {
  initStore,
  createCard,
  loadCard,
  loadCardDeps,
  loadCardRuns,
  claimCard,
  blockCard,
  reviewCard,
  completeCard,
  addCardComment,
  loadCardComments,
  transitionCard,
  saveSessionHandoff,
  loadLatestHandoffForCard,
} from '../src/store.js';
import { openHippoDb, closeHippoDb, getSchemaVersion, getCurrentSchemaVersion, type DatabaseSyncLike } from '../src/db.js';
import { CARD_TRANSITIONS, type CardStatus } from '../src/card.js';

const ALL_STATUSES: CardStatus[] = ['backlog', 'ready', 'running', 'blocked', 'review', 'done', 'shelved'];

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

function columns(db: DatabaseSyncLike, table: string): ColumnInfo[] {
  // SAFETY: PRAGMA table_info always yields rows shaped like ColumnInfo.
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function indexNames(db: DatabaseSyncLike, table: string): string[] {
  // SAFETY: PRAGMA index_list always yields rows with a `name` column.
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

function countRows(db: DatabaseSyncLike, table: string): number {
  // SAFETY: COUNT(*) always returns a single row with a `c` column.
  return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-w2a-cards-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('test 1: fresh store, single open', () => {
  it('has all four card tables, the five new indexes, and schema_version 43', () => {
    const db = openHippoDb(root);
    try {
      expect(columns(db, 'cards').map((c) => c.name)).toEqual(
        expect.arrayContaining(['id', 'title', 'status', 'assignee_runtime', 'lease_until', 'heartbeat_at', 'tenant_id']),
      );
      expect(columns(db, 'card_deps').map((c) => c.name)).toEqual(expect.arrayContaining(['parent', 'child', 'tenant_id']));
      expect(columns(db, 'card_runs').map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'card', 'runtime', 'outcome']));
      expect(columns(db, 'card_comments').map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'card_id', 'author', 'body']));
      expect(indexNames(db, 'cards')).toContain('idx_cards_tenant_status');
      expect(indexNames(db, 'card_deps')).toEqual(expect.arrayContaining(['idx_card_deps_tenant_child', 'idx_card_deps_tenant_parent']));
      expect(indexNames(db, 'card_runs')).toContain('idx_card_runs_tenant_card');
      expect(indexNames(db, 'card_comments')).toContain('idx_card_comments_tenant_card');
      expect(indexNames(db, 'session_handoffs')).toContain('idx_session_handoffs_tenant_card');
      expect(getSchemaVersion(db)).toBe(48);
      expect(getCurrentSchemaVersion()).toBe(48);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('test 2: a v42 store migrates to v43 with the four tables present, empty', () => {
  it('gains cards/card_deps/card_runs/card_comments on next open', () => {
    initStore(root);
    const db1 = openHippoDb(root);
    try {
      db1.exec('DROP TABLE cards; DROP TABLE card_deps; DROP TABLE card_runs; DROP TABLE card_comments;');
      db1.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run('42');
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      expect(getSchemaVersion(db2)).toBe(48);
      expect(countRows(db2, 'cards')).toBe(0);
      expect(countRows(db2, 'card_deps')).toBe(0);
      expect(countRows(db2, 'card_runs')).toBe(0);
      expect(countRows(db2, 'card_comments')).toBe(0);
    } finally {
      closeHippoDb(db2);
    }
  });
});

describe('test 4: createCard initial status', () => {
  it('no deps -> ready', () => {
    const card = createCard(root, 'default', { title: 'No deps' });
    expect(card.status).toBe('ready');
  });

  it('one backlog-status dep -> backlog', () => {
    const parent = createCard(root, 'default', { title: 'Parent' });
    expect(parent.status).toBe('ready');
    // Force the parent to a non-done status so the child's pre-check sees a not-done parent.
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET status = 'backlog' WHERE id = ?`).run(parent.id);
    } finally {
      closeHippoDb(db);
    }
    const child = createCard(root, 'default', { title: 'Child', dependsOn: [parent.id] });
    expect(child.status).toBe('backlog');
  });

  it('dep on an already-done parent -> ready', () => {
    const parent = createCard(root, 'default', { title: 'Done parent' });
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET status = 'done' WHERE id = ?`).run(parent.id);
    } finally {
      closeHippoDb(db);
    }
    const child = createCard(root, 'default', { title: 'Child of done', dependsOn: [parent.id] });
    expect(child.status).toBe('ready');
  });

  it('a repeated dependsOn id is recorded once', () => {
    const parent = createCard(root, 'default', { title: 'Parent' });
    const child = createCard(root, 'default', { title: 'Child', dependsOn: [parent.id, parent.id] });
    expect(child.status).toBe('backlog');
    expect(loadCardDeps(root, 'default', child.id).parents).toEqual([parent.id]);
  });
});

describe('test 5: status-transition matrix', () => {
  it('every (from, to) pair not in CARD_TRANSITIONS[from] throws; every pair in it does not', () => {
    const db = openHippoDb(root);
    try {
      for (const from of ALL_STATUSES) {
        for (const to of ALL_STATUSES) {
          const card = createCard(root, 'default', { title: `${from}-${to}` });
          db.prepare(`UPDATE cards SET status = ? WHERE id = ?`).run(from, card.id);
          const legal = CARD_TRANSITIONS[from].includes(to);
          if (legal) {
            expect(() => transitionCard(db, 'default', card.id, [from], to)).not.toThrow();
          } else {
            expect(() => transitionCard(db, 'default', card.id, [from], to)).toThrow(
              `illegal card transition: ${from} -> ${to}`,
            );
          }
        }
      }
    } finally {
      closeHippoDb(db);
    }
  });

  it('blocked -> running is accepted via claimCard', () => {
    const card = createCard(root, 'default', { title: 'Blocked card' });
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET status = 'blocked' WHERE id = ?`).run(card.id);
    } finally {
      closeHippoDb(db);
    }
    const claimed = claimCard(root, 'default', card.id, 'codex');
    expect(claimed?.status).toBe('running');
  });

  it('a wrapper called with an illegal from list throws even when the row status matches that list', () => {
    const card = createCard(root, 'default', { title: 'Done card' });
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE cards SET status = 'done' WHERE id = ?`).run(card.id);
      // The row's real status ('done') IS in the from list below; the throw must still fire
      // because CARD_TRANSITIONS.done is empty, proving the check is static, not row-driven.
      expect(() => transitionCard(db, 'default', card.id, ['done'], 'running')).toThrow(
        'illegal card transition: done -> running',
      );
    } finally {
      closeHippoDb(db);
    }
  });
});

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
    setTimeout(() => {
      db.exec('COMMIT');
      db.close();
      parentPort.postMessage('released');
    }, workerData.holdMs);
  `;
  const worker = new Worker(workerCode, { eval: true, workerData: { dbPath, cardId, holdMs } });
  const locked = new Promise<void>((resolve) => {
    worker.once('message', (msg) => { if (msg === 'locked') resolve(); });
  });
  const released = new Promise<void>((resolve) => {
    worker.on('message', (msg) => { if (msg === 'released') { worker.terminate(); resolve(); } });
  });
  return { locked, released };
}

describe('test 6: concurrent claim', () => {
  it('a claim held open in another connection blocks claimCard, which then sees 0 rows once released', async () => {
    const card = createCard(root, 'default', { title: 'Contested' });
    const dbPath = join(root, 'hippo.db');
    const { locked, released } = holdLockThenRelease(dbPath, card.id, 600);
    await locked;

    const started = Date.now();
    const result = claimCard(root, 'default', card.id, 'second');
    const elapsedMs = Date.now() - started;

    expect(result).toBeNull();
    expect(elapsedMs).toBeGreaterThan(300);
    await released;
  });

  it('two sequential claims on the same ready card: the second returns null', () => {
    const card = createCard(root, 'default', { title: 'Sequential' });
    const first = claimCard(root, 'default', card.id, 'first');
    const second = claimCard(root, 'default', card.id, 'second');
    expect(first?.status).toBe('running');
    expect(second).toBeNull();
  });
});

describe('test 7: completeCard promotes only children whose parents are all done', () => {
  it('promotes B, leaves C in backlog, closes the open run', () => {
    const a = createCard(root, 'default', { title: 'A' });
    const d = createCard(root, 'default', { title: 'D' });
    const b = createCard(root, 'default', { title: 'B', dependsOn: [a.id] });
    const c = createCard(root, 'default', { title: 'C', dependsOn: [a.id, d.id] });
    expect(b.status).toBe('backlog');
    expect(c.status).toBe('backlog');

    claimCard(root, 'default', a.id, 'codex');
    reviewCard(root, 'default', a.id);
    claimCard(root, 'default', d.id, 'codex'); // D stays running, never completes.

    const result = completeCard(root, 'default', a.id, 'success');
    expect(result).not.toBeNull();
    expect(result!.promotedChildren).toEqual([b.id]);
    expect(loadCard(root, 'default', b.id)?.status).toBe('ready');
    expect(loadCard(root, 'default', c.id)?.status).toBe('backlog');

    const runs = loadCardRuns(root, 'default', a.id);
    expect(runs[0]?.ended).not.toBeNull();
    expect(runs[0]?.outcome).toBe('success');
  });
});

describe('test 7b: claim -> block -> reclaim -> review -> complete closes exactly the live run', () => {
  it('the blocked run keeps outcome blocked; the reclaimed run gets the final outcome', () => {
    const card = createCard(root, 'default', { title: 'Reclaimed' });
    claimCard(root, 'default', card.id, 'r1');
    blockCard(root, 'default', card.id, 'waiting on input');
    claimCard(root, 'default', card.id, 'r2');
    reviewCard(root, 'default', card.id);
    const result = completeCard(root, 'default', card.id, 'success');
    expect(result).not.toBeNull();

    const runs = loadCardRuns(root, 'default', card.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.runtime).toBe('r2');
    expect(runs[0]?.ended).not.toBeNull();
    expect(runs[0]?.outcome).toBe('success');
    expect(runs[1]?.runtime).toBe('r1');
    expect(runs[1]?.ended).not.toBeNull();
    expect(runs[1]?.outcome).toBe('blocked');

    const finalCard = loadCard(root, 'default', card.id);
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
    setTimeout(() => {
      db.prepare("UPDATE cards SET status = 'done', updated_at = ? WHERE id = ? AND tenant_id = ?")
        .run(new Date().toISOString(), workerData.parentId, 'default');
      db.exec('COMMIT');
      db.close();
      parentPort.postMessage('released');
    }, workerData.holdMs);
  `;
  const worker = new Worker(workerCode, { eval: true, workerData: { dbPath, parentId, holdMs } });
  const locked = new Promise<void>((resolve) => {
    worker.once('message', (msg) => { if (msg === 'locked') resolve(); });
  });
  const released = new Promise<void>((resolve) => {
    worker.on('message', (msg) => { if (msg === 'released') { worker.terminate(); resolve(); } });
  });
  return { locked, released };
}

describe('test 7c: a parent completing while createCard waits for the write lock still yields a ready child', () => {
  it('createCard blocks on BEGIN IMMEDIATE, then reads the parent as done once the lock is released', async () => {
    const parent = createCard(root, 'default', { title: 'Parent' });
    claimCard(root, 'default', parent.id, 'codex');
    reviewCard(root, 'default', parent.id); // in review, not done yet: the pre-fix read would see this.

    const dbPath = join(root, 'hippo.db');
    const { locked, released } = holdLockThenCompleteParent(dbPath, parent.id, 300);
    await locked;

    const child = createCard(root, 'default', { title: 'Child', dependsOn: [parent.id] });

    expect(child.status).toBe('ready');
    expect(loadCard(root, 'default', child.id)?.status).toBe('ready');
    await released;
  });
});

describe('test 8: completeCard from a non-review status returns null and touches nothing', () => {
  it('leaves card_deps and card_runs untouched', () => {
    const parent = createCard(root, 'default', { title: 'Still backlog' });
    const child = createCard(root, 'default', { title: 'Child', dependsOn: [parent.id] });

    const before = loadCardDeps(root, 'default', child.id);
    const result = completeCard(root, 'default', parent.id, 'success');
    expect(result).toBeNull();

    const after = loadCardDeps(root, 'default', child.id);
    expect(after).toEqual(before);
    expect(loadCardRuns(root, 'default', parent.id)).toEqual([]);
    expect(loadCard(root, 'default', parent.id)?.status).toBe('ready');
  });
});

describe('Fix A: completeCard shelves a non-success outcome and releases no children', () => {
  it('failure leaves the card shelved, the child in backlog, and closes the run with outcome failure', () => {
    const a = createCard(root, 'default', { title: 'A' });
    const b = createCard(root, 'default', { title: 'B', dependsOn: [a.id] });
    claimCard(root, 'default', a.id, 'codex');
    reviewCard(root, 'default', a.id);

    const result = completeCard(root, 'default', a.id, 'failure');
    expect(result).not.toBeNull();
    expect(result!.card.status).toBe('shelved');
    expect(result!.promotedChildren).toEqual([]);
    expect(loadCard(root, 'default', b.id)?.status).toBe('backlog');

    const runs = loadCardRuns(root, 'default', a.id);
    expect(runs[0]?.ended).not.toBeNull();
    expect(runs[0]?.outcome).toBe('failure');
  });

  it('partial leaves the card shelved, the child in backlog, and closes the run with outcome partial', () => {
    const a = createCard(root, 'default', { title: 'A' });
    const b = createCard(root, 'default', { title: 'B', dependsOn: [a.id] });
    claimCard(root, 'default', a.id, 'codex');
    reviewCard(root, 'default', a.id);

    const result = completeCard(root, 'default', a.id, 'partial');
    expect(result).not.toBeNull();
    expect(result!.card.status).toBe('shelved');
    expect(result!.promotedChildren).toEqual([]);
    expect(loadCard(root, 'default', b.id)?.status).toBe('backlog');

    const runs = loadCardRuns(root, 'default', a.id);
    expect(runs[0]?.ended).not.toBeNull();
    expect(runs[0]?.outcome).toBe('partial');
  });

  it('a shelved parent never releases a child even after every other parent completes', () => {
    const a = createCard(root, 'default', { title: 'A' });
    const c = createCard(root, 'default', { title: 'C' });
    const b = createCard(root, 'default', { title: 'B', dependsOn: [a.id, c.id] });

    claimCard(root, 'default', a.id, 'codex');
    reviewCard(root, 'default', a.id);
    completeCard(root, 'default', a.id, 'failure');
    expect(loadCard(root, 'default', b.id)?.status).toBe('backlog');

    claimCard(root, 'default', c.id, 'codex');
    reviewCard(root, 'default', c.id);
    const result = completeCard(root, 'default', c.id, 'success');
    expect(result!.promotedChildren).toEqual([]);
    expect(loadCard(root, 'default', b.id)?.status).toBe('backlog');
  });

  it('createCard with dependsOn a shelved parent creates the child in backlog', () => {
    const a = createCard(root, 'default', { title: 'A' });
    claimCard(root, 'default', a.id, 'codex');
    reviewCard(root, 'default', a.id);
    completeCard(root, 'default', a.id, 'failure');
    expect(loadCard(root, 'default', a.id)?.status).toBe('shelved');

    const b = createCard(root, 'default', { title: 'B', dependsOn: [a.id] });
    expect(b.status).toBe('backlog');
  });
});

describe('test 9: loadLatestHandoffForCard', () => {
  it('round-trips a handoff saved with a matching cardId and ignores others', () => {
    const card = createCard(root, 'default', { title: 'Handoff target' });
    saveSessionHandoff(root, 'default', {
      version: 1, sessionId: 'sess-1', summary: 'wrong card', nextAction: undefined, artifacts: [], cardId: 'other-card',
    });
    saveSessionHandoff(root, 'default', {
      version: 1, sessionId: 'sess-2', summary: 'no card', nextAction: undefined, artifacts: [],
    });
    saveSessionHandoff(root, 'default', {
      version: 1, sessionId: 'sess-3', summary: 'right card', nextAction: undefined, artifacts: [], cardId: card.id,
    });

    const handoff = loadLatestHandoffForCard(root, 'default', card.id);
    expect(handoff?.summary).toBe('right card');
    expect(handoff?.constraints).toEqual([]);
  });
});

describe('CLI round trip: card create -> handoff create --card-id -> card show --json', () => {
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
    const home = mkdtempSync(join(tmpdir(), 'hippo-w2a-cli-'));
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

  it('test 10: hippo card show --json contains the handoff created against that card id', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'card', 'create', '--title', 't');
      expect(create.status, create.out).toBe(0);
      const id = create.out.match(/Created card (\S+)/)?.[1];
      expect(id).toBeTruthy();

      const handoff = runCli(home, env, 'handoff', 'create', '--summary', 's', '--card-id', id!);
      expect(handoff.status, handoff.out).toBe(0);

      const show = runCli(home, env, 'card', 'show', id!, '--json');
      expect(show.status, show.out).toBe(0);
      const parsed = JSON.parse(show.out);
      expect(parsed.handoff.summary).toBe('s');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('test 12: an unknown --depends-on id exits 1 with the missing-parent message on stderr', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'card', 'create', '--title', 'x', '--depends-on', 'nope');
      expect(create.status).toBe(1);
      expect(create.out).toContain('unknown parent card id: nope');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a value-less --title exits 1 and creates no card', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'card', 'create', '--title');
      expect(create.status).toBe(1);
      const list = runCli(home, env, 'card', 'list');
      expect(list.status, list.out).toBe(0);
      expect(list.out).toContain('No cards found.');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a value-less --depends-on exits 1', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'card', 'create', '--title', 't', '--depends-on');
      expect(create.status).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a value-less --reason on card block exits 1 and leaves the card running', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'card', 'create', '--title', 't');
      const id = create.out.match(/Created card (\S+)/)?.[1];
      expect(id).toBeTruthy();
      const claim = runCli(home, env, 'card', 'claim', id!, '--runtime', 'r');
      expect(claim.status, claim.out).toBe(0);

      const block = runCli(home, env, 'card', 'block', id!, '--reason');
      expect(block.status).toBe(1);

      const show = runCli(home, env, 'card', 'show', id!, '--json');
      expect(show.status, show.out).toBe(0);
      expect(JSON.parse(show.out).card.status).toBe('running');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a value-less --runtime on card claim exits 1', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'card', 'create', '--title', 't');
      const id = create.out.match(/Created card (\S+)/)?.[1];
      expect(id).toBeTruthy();

      const claim = runCli(home, env, 'card', 'claim', id!, '--runtime');
      expect(claim.status).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('Fix A CLI: card complete --outcome failure prints status shelved and no Promoted line', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'card', 'create', '--title', 't');
      const id = create.out.match(/Created card (\S+)/)?.[1];
      expect(id).toBeTruthy();
      runCli(home, env, 'card', 'claim', id!, '--runtime', 'r1');
      runCli(home, env, 'card', 'review', id!);

      const complete = runCli(home, env, 'card', 'complete', id!, '--outcome', 'failure');
      expect(complete.status, complete.out).toBe(0);
      expect(complete.out).toContain('(status: shelved)');
      expect(complete.out).not.toContain('Promoted to ready');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('card comment on an unknown id exits 1 with the friendly message, not a raw FK error', () => {
    const { home, env } = setupCliHome();
    try {
      const comment = runCli(home, env, 'card', 'comment', 'nope', '--body', 'x');
      expect(comment.status).toBe(1);
      expect(comment.out).toContain('No card found with id nope.');
      expect(comment.out).not.toContain('FOREIGN KEY');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('Fix B CLI: card claim on an unknown id exits 1 with the unknown-id message', () => {
    const { home, env } = setupCliHome();
    try {
      const claim = runCli(home, env, 'card', 'claim', 'card_000000000000', '--runtime', 'r1');
      expect(claim.status).toBe(1);
      expect(claim.out).toContain('unknown card id: card_000000000000');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('Fix C CLI: card create --budget 0 exits 1 and creates no card', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'card', 'create', '--title', 't', '--budget', '0');
      expect(create.status).toBe(1);
      expect(create.out).toContain('Invalid budget: 0 (expected a positive integer)');
      const list = runCli(home, env, 'card', 'list');
      expect(list.status, list.out).toBe(0);
      expect(list.out).toContain('No cards found.');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('Fix D CLI: an unrecognized flag, a wrong name, or a glued --flag=value with a bad value, exits 1 and creates no card', () => {
    const { home, env } = setupCliHome();
    try {
      // --depends-on=nope is a real flag now, so it fails on the parent lookup instead of on parsing.
      const equalsForm = runCli(home, env, 'card', 'create', '--title', 't', '--depends-on=nope');
      expect(equalsForm.status).toBe(1);
      expect(equalsForm.out).toContain('unknown parent card id: nope');

      const typo = runCli(home, env, 'card', 'create', '--title', 't', '--depend-on', 'x');
      expect(typo.status).toBe(1);
      expect(typo.out).toContain('Unknown flag --depend-on for hippo card create');

      const protoKey = runCli(home, env, 'card', 'constructor', '--x');
      expect(protoKey.status).toBe(1);
      expect(protoKey.out).toContain('Usage: hippo card <create|show|list|claim|heartbeat|block|review|complete|reclaim|comment>');

      const list = runCli(home, env, 'card', 'list');
      expect(list.status, list.out).toBe(0);
      expect(list.out).toContain('No cards found.');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('Fix D CLI: every subcommand still accepts each flag it legitimately reads', () => {
    const { home, env } = setupCliHome();
    try {
      const parent = runCli(home, env, 'card', 'create', '--title', 'parent');
      expect(parent.status, parent.out).toBe(0);
      const parentId = parent.out.match(/Created card (\S+)/)?.[1]!;
      expect(parentId).toBeTruthy();

      const create = runCli(home, env, 'card', 'create', '--title', 'child', '--repo', 'r', '--contract', 'c', '--budget', '5', '--depends-on', parentId);
      expect(create.status, create.out).toBe(0);
      const childId = create.out.match(/Created card (\S+)/)?.[1]!;
      expect(childId).toBeTruthy();

      const list = runCli(home, env, 'card', 'list', '--status', 'backlog', '--json');
      expect(list.status, list.out).toBe(0);
      const listed = JSON.parse(list.out);
      expect(listed.cards.some((c: { id: string }) => c.id === childId)).toBe(true);

      const claim = runCli(home, env, 'card', 'claim', parentId, '--runtime', 'r1', '--session', 's1');
      expect(claim.status, claim.out).toBe(0);

      const comment = runCli(home, env, 'card', 'comment', parentId, '--body', 'note', '--author', 'me');
      expect(comment.status, comment.out).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('test 11: audit rule 2 sites return exactly one grep hit each', () => {
  // In-process regex count, not a `grep` shell-out: a bare Windows runner may lack the binary.
  function hitCount(filePath: string, needle: string): number {
    const text = readFileSync(filePath, 'utf8');
    return text.split('\n').filter((line) => line.includes(needle)).length;
  }

  it('depends-on appears once in the repeatable-flag allow-list', () => {
    expect(hitCount(join(__dirname, '..', 'src', 'cli.ts'), "key === 'depends-on'")).toBe(1);
  });

  it("case 'card' appears once in the dispatch switch", () => {
    expect(hitCount(join(__dirname, '..', 'src', 'cli.ts'), "case 'card':")).toBe(1);
  });

  it('createCard is re-exported exactly once from src/index.ts', () => {
    expect(hitCount(join(__dirname, '..', 'src', 'index.ts'), 'createCard')).toBe(1);
  });
});

describe('test 12: unknown dependsOn pre-check', () => {
  it('throws and leaves zero rows in cards and card_deps', () => {
    expect(() => createCard(root, 'default', { title: 'x', dependsOn: ['nope'] })).toThrow('unknown parent card id: nope');
    const db = openHippoDb(root);
    try {
      expect(countRows(db, 'cards')).toBe(0);
      expect(countRows(db, 'card_deps')).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('test 13: addCardComment checks the card belongs to the caller\'s tenant', () => {
  it('throws unknown card id for a foreign-tenant card and for a missing id; happy path still works', () => {
    const card = createCard(root, 'default', { title: 'Commented' });

    expect(() => addCardComment(root, 'tenant2', card.id, 'x', 'y')).toThrow(`unknown card id: ${card.id}`);
    expect(() => addCardComment(root, 'default', 'nope', 'x', 'y')).toThrow('unknown card id: nope');

    expect(loadCardComments(root, 'default', card.id)).toEqual([]);
    expect(loadCardComments(root, 'tenant2', card.id)).toEqual([]);

    const comment = addCardComment(root, 'default', card.id, 'x', 'y');
    expect(comment.body).toBe('y');
    expect(loadCardComments(root, 'default', card.id)).toHaveLength(1);
  });
});

describe('Fix B: claim/block/review/complete throw on an unknown card id, keep null for the wrong state', () => {
  it('claimCard throws for a nonexistent id and for a card read under another tenant', () => {
    const card = createCard(root, 'default', { title: 'x' });
    expect(() => claimCard(root, 'default', 'nope', 'r1')).toThrow('unknown card id: nope');
    expect(() => claimCard(root, 'tenant2', card.id, 'r1')).toThrow(`unknown card id: ${card.id}`);
  });

  it('blockCard throws for a nonexistent id and for a card read under another tenant', () => {
    const card = createCard(root, 'default', { title: 'x' });
    claimCard(root, 'default', card.id, 'r1');
    expect(() => blockCard(root, 'default', 'nope', 'why')).toThrow('unknown card id: nope');
    expect(() => blockCard(root, 'tenant2', card.id, 'why')).toThrow(`unknown card id: ${card.id}`);
  });

  it('reviewCard throws for a nonexistent id and for a card read under another tenant', () => {
    const card = createCard(root, 'default', { title: 'x' });
    claimCard(root, 'default', card.id, 'r1');
    expect(() => reviewCard(root, 'default', 'nope')).toThrow('unknown card id: nope');
    expect(() => reviewCard(root, 'tenant2', card.id)).toThrow(`unknown card id: ${card.id}`);
  });

  it('completeCard throws for a nonexistent id and for a card read under another tenant', () => {
    const card = createCard(root, 'default', { title: 'x' });
    claimCard(root, 'default', card.id, 'r1');
    reviewCard(root, 'default', card.id);
    expect(() => completeCard(root, 'default', 'nope', 'success')).toThrow('unknown card id: nope');
    expect(() => completeCard(root, 'tenant2', card.id, 'success')).toThrow(`unknown card id: ${card.id}`);
  });

  it('a card that exists but is in the wrong state still returns null, not throws', () => {
    const parent = createCard(root, 'default', { title: 'parent' });
    const backlogChild = createCard(root, 'default', { title: 'child', dependsOn: [parent.id] });
    expect(claimCard(root, 'default', backlogChild.id, 'r1')).toBeNull();

    const readyCard = createCard(root, 'default', { title: 'ready-one' });
    expect(blockCard(root, 'default', readyCard.id, 'why')).toBeNull();
    expect(reviewCard(root, 'default', readyCard.id)).toBeNull();
  });
});

describe('Fix C: createCard/claimCard/blockCard/addCardComment validate their inputs', () => {
  it('createCard throws for an empty or whitespace-only title and commits nothing', () => {
    const db = openHippoDb(root);
    try {
      expect(() => createCard(root, 'default', { title: '' })).toThrow('title must not be empty');
      expect(() => createCard(root, 'default', { title: '   ' })).toThrow('title must not be empty');
      expect(countRows(db, 'cards')).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('createCard throws for a budget that is not a positive integer and commits nothing', () => {
    const db = openHippoDb(root);
    try {
      expect(() => createCard(root, 'default', { title: 'x', budget: 0 })).toThrow('Invalid budget: 0 (expected a positive integer)');
      expect(() => createCard(root, 'default', { title: 'x', budget: -3 })).toThrow('Invalid budget: -3 (expected a positive integer)');
      expect(() => createCard(root, 'default', { title: 'x', budget: 2.5 })).toThrow('Invalid budget: 2.5 (expected a positive integer)');
      expect(countRows(db, 'cards')).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('claimCard throws for an empty runtime and leaves the card unclaimed', () => {
    const card = createCard(root, 'default', { title: 'x' });
    expect(() => claimCard(root, 'default', card.id, '')).toThrow('runtime must not be empty');
    expect(loadCard(root, 'default', card.id)?.status).toBe('ready');
    expect(loadCardRuns(root, 'default', card.id)).toEqual([]);
  });

  it('blockCard throws for an empty reason and leaves the card running with no comment', () => {
    const card = createCard(root, 'default', { title: 'x' });
    claimCard(root, 'default', card.id, 'r1');
    expect(() => blockCard(root, 'default', card.id, '')).toThrow('reason must not be empty');
    expect(loadCard(root, 'default', card.id)?.status).toBe('running');
    expect(loadCardComments(root, 'default', card.id)).toEqual([]);
  });

  it('addCardComment throws for an empty body and adds no comment', () => {
    const card = createCard(root, 'default', { title: 'x' });
    expect(() => addCardComment(root, 'default', card.id, 'author', '')).toThrow('body must not be empty');
    expect(loadCardComments(root, 'default', card.id)).toEqual([]);
  });
});
