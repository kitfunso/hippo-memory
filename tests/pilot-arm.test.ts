// CD11 units: config parsing, the arm helpers, the consumer's arm query, ledger readers and doctor.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { loadConfig } from '../src/config.js';
import { openHippoDb, closeHippoDb, HOOK_DB_WAIT_MS, runWithRequestStores, SERVER_DB_WAIT_MS, type DatabaseSyncLike } from '../src/db.js';
import { withLedgerDb } from '../src/ledger-db.js';
import { ensurePilotArm, hashArm, readPilotArm } from '../src/pilot-arm.js';
import { recordTokenUse, summarizeTokenUse, tokensBySession } from '../src/token-ledger.js';
import { runDoctor } from '../src/doctor.js';
import type { JsonValue } from '../src/json.js';
import { countMatching, recordStatements } from './_helpers/count-statements.js';

let tmp: string;
let root: string;
let db: DatabaseSyncLike;
const SINCE = '2000-01-01T00:00:00.000Z';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-pilot-unit-'));
  root = path.join(tmp, '.hippo');
  fs.mkdirSync(root, { recursive: true });
  initStore(root);
  db = openHippoDb(root);
});

afterEach(() => {
  closeHippoDb(db);
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const writeConfig = (pilot: JsonValue): void => fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ pilot }));
// SAFETY: a single COUNT(*) aggregate aliased `n`.
const armCount = (): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM token_ledger WHERE event = 'arm'`).get() as { n: number }).n;

/** Runs `fn` with SQLite's own busy sleep off, as it overshoots on macOS, and the retry loop's clock moved 50 ms a try; returns the wait the loop saw. */
function waitOnSteppedClock(reader: DatabaseSyncLike, fn: () => void): number {
  reader.exec('PRAGMA busy_timeout = 0');
  let clock = 0;
  const exec = reader.exec.bind(reader);
  vi.spyOn(reader, 'exec').mockImplementation((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE') clock += 50;
    exec(sql);
  });
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  try {
    fn();
  } finally {
    now.mockRestore();
  }
  return clock;
}

describe('pilot config', () => {
  it('defaults to 0 and reads a valid rate', () => {
    expect(loadConfig(root).pilot.holdoutRateBp).toBe(0);
    writeConfig({ holdoutRateBp: 2000 });
    expect(loadConfig(root).pilot.holdoutRateBp).toBe(2000);
    writeConfig({ holdoutRateBp: 10000 });
    expect(loadConfig(root).pilot.holdoutRateBp).toBe(10000);
  });

  it.each([-1, 10001, 2.5, '2000', {}, null])('warns and turns the pilot off for %j', (bad) => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeConfig({ holdoutRateBp: bad });
    expect(loadConfig(root).pilot.holdoutRateBp).toBe(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('"pilot"'))).toBe(true);
  });

  it('warns for a pilot value that is not an object', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeConfig(2000);
    expect(loadConfig(root).pilot.holdoutRateBp).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('pilot arm helpers', () => {
  it('splits deterministically and at the extremes', () => {
    expect(hashArm('abc', 5000)).toBe(hashArm('abc', 5000));
    const ids = Array.from({ length: 400 }, (_, i) => `s${i}`);
    expect(ids.every((id) => hashArm(id, 10000) === 'holdout')).toBe(true);
    expect(ids.every((id) => hashArm(id, 0) === 'hippo')).toBe(true);
    const held = ids.filter((id) => hashArm(id, 5000) === 'holdout').length;
    expect(held).toBeGreaterThan(140);
    expect(held).toBeLessThan(260);
  });

  it('ensure twice books one row', () => {
    expect(ensurePilotArm(db, 'default', 's1', 10000)).toBe('holdout');
    expect(ensurePilotArm(db, 'default', 's1', 10000)).toBe('holdout');
    expect(armCount()).toBe(1);
  });

  it('the stored row wins after a rate change', () => {
    ensurePilotArm(db, 'default', 's1', 10000);
    expect(ensurePilotArm(db, 'default', 's1', 1)).toBe('holdout');
    expect(readPilotArm(db, 's1')).toBe('holdout');
  });

  it('finds a row across tenants and books no second one', () => {
    ensurePilotArm(db, 'tenant-a', 's1', 10000);
    expect(ensurePilotArm(db, 'tenant-b', 's1', 1)).toBe('holdout');
    expect(armCount()).toBe(1);
  });

  it('the read path writes nothing', () => {
    expect(readPilotArm(db, 'nobody')).toBeNull();
    expect(armCount()).toBe(0);
  });

  it('a failing database returns the hash arm and never throws', () => {
    vi.spyOn(db, 'exec').mockImplementation(() => { throw new Error('locked'); });
    expect(ensurePilotArm(db, 'default', 's1', 10000)).toBe('holdout');
    expect(ensurePilotArm(db, 'default', 's1', 0)).toBe('hippo');
  });

  it('a held write lock yields the hash arm, no row, and a wait that ends at the hook bound', () => {
    const holder = openHippoDb(root);
    try {
      holder.exec('BEGIN IMMEDIATE');
      const reader = openHippoDb(root, { busyWaitMs: HOOK_DB_WAIT_MS });
      try {
        const waited = waitOnSteppedClock(reader, () => expect(ensurePilotArm(reader, 'default', 'locked', 10000)).toBe('holdout'));
        expect(waited).toBe(HOOK_DB_WAIT_MS);
      } finally {
        closeHippoDb(reader);
      }
    } finally {
      holder.exec('ROLLBACK');
      closeHippoDb(holder);
    }
    expect(armCount()).toBe(0);
  });

  it('a held write lock under a server request waits the request bound, not the hook one', async () => {
    const holder = openHippoDb(root);
    try {
      holder.exec('BEGIN IMMEDIATE');
      await runWithRequestStores(() => {
        const reader = openHippoDb(root);
        try {
          const waited = waitOnSteppedClock(reader, () => expect(ensurePilotArm(reader, 'default', 'locked', 10000)).toBe('holdout'));
          expect(waited).toBeGreaterThanOrEqual(SERVER_DB_WAIT_MS);
          expect(waited).toBeLessThan(HOOK_DB_WAIT_MS);
        } finally {
          closeHippoDb(reader);
        }
      }, { busyWaitMs: SERVER_DB_WAIT_MS });
    } finally {
      holder.exec('ROLLBACK');
      closeHippoDb(holder);
    }
    expect(armCount()).toBe(0);
  });

  it('a tenant-scoped read ignores another tenant\'s row for the same session', () => {
    ensurePilotArm(db, 'tenant-a', 's1', 10000);
    expect(readPilotArm(db, 's1', 'tenant-b')).toBeNull();
    expect(ensurePilotArm(db, 'tenant-b', 's1', 0, { ownTenantOnly: true })).toBe('hippo');
    expect(readPilotArm(db, 's1', 'tenant-b')).toBe('hippo');
    expect(armCount()).toBe(2);
  });

  it('a stored arm is read without the write lock', () => {
    ensurePilotArm(db, 'default', 'kept', 10000);
    const holder = openHippoDb(root);
    try {
      holder.exec('BEGIN IMMEDIATE');
      const { result, statements } = recordStatements(() => ensurePilotArm(db, 'default', 'kept', 1));
      expect(result).toBe('holdout');
      expect(countMatching(statements, 'BEGIN')).toBe(0);
    } finally {
      holder.exec('ROLLBACK');
      closeHippoDb(holder);
    }
  });

  it('rolls back and returns the hash arm when the insert fails', () => {
    db.exec('DROP TABLE token_ledger');
    expect(ensurePilotArm(db, 'default', 's1', 10000)).toBe('holdout');
    expect(() => db.exec('BEGIN IMMEDIATE')).not.toThrow();
    db.exec('ROLLBACK');
  });

  it('says at debug level why an arm or a ledger row was not stored', () => {
    process.env.HIPPO_LOG = 'debug';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    db.exec('DROP TABLE token_ledger');
    try {
      ensurePilotArm(db, 'default', 's1', 10000);
      withLedgerDb(root, (ledger) => recordTokenUse(ledger, { tenantId: 'default', surface: 'hook', event: 'inject', items: 1, tokens: 40 }));
    } finally {
      delete process.env.HIPPO_LOG;
    }
    const text = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(text).toMatch(/debug: pilot arm not stored, using the hash arm: .*token_ledger/);
    expect(text).toMatch(/debug: token ledger row skipped: .*token_ledger/);
  });
});

// The enterprise reader (hippo-enterprise src/pilot/store.ts, merged in 3463cd5) selects these columns.
interface ArmSql { session_id: string; tenant_id: string; event: string; block_hash: string; items: number; tokens: number; surface: string }

describe('the consumer contract', () => {
  it('one arm, one rate, one tenant, exact row shape', () => {
    ensurePilotArm(db, 'default', 'c1', 2500);
    // SAFETY: the SELECT names exactly the columns of ArmSql.
    const rows = db.prepare(
      `SELECT session_id, tenant_id, event, block_hash, items, tokens, surface FROM token_ledger
       WHERE session_id IS NOT NULL AND event = 'arm' ORDER BY id`,
    ).all() as ArmSql[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      session_id: 'c1', tenant_id: 'default', event: 'arm', block_hash: hashArm('c1', 2500), items: 2500, tokens: 0, surface: 'pilot',
    });
    expect(Number.isInteger(rows[0].items)).toBe(true);
  });
});

describe('ledger readers skip arm rows', () => {
  it('summarizeTokenUse and tokensBySession ignore an arm-only session', () => {
    ensurePilotArm(db, 'default', 'arm-only', 10000);
    recordTokenUse(db, { tenantId: 'default', sessionId: 'real', surface: 'hook', event: 'inject', items: 1, tokens: 40 });
    const summary = summarizeTokenUse(db, 'default', SINCE);
    expect(summary.sessions).toBe(1);
    expect(summary.surfaces.map((s) => s.surface)).toEqual(['hook']);
    expect(tokensBySession(db, 'default', SINCE).map((s) => s.sessionId)).toEqual(['real']);
  });
});

describe('doctor', () => {
  const pilotCheck = () => {
    const prev = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = path.join(tmp, 'global');
    try {
      return runDoctor({ cwd: tmp, home: tmp, version: 'test' }).checks.find((c) => c.id === 'pilot');
    } finally {
      if (prev === undefined) delete process.env.HIPPO_HOME;
      else process.env.HIPPO_HOME = prev;
    }
  };

  it('reports the pilot only when the rate is above 0', () => {
    expect(pilotCheck()).toBeUndefined();
    writeConfig({ holdoutRateBp: 2000 });
    expect(pilotCheck()).toMatchObject({ status: 'info', detail: expect.stringContaining('about 20%') });
  });
});
