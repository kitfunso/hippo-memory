/**
 * LC1 recall-trace helper unit tests
 * (docs/plans/2026-08-02-lc1-recall-trace-persistence.md).
 *
 * Covers writeRecallTrace / writeRecallTraceAtRoot / readLastTraceId /
 * writeLastTraceId / recordTraceOutcome in isolation, against a scratch
 * HIPPO_HOME (never a repo checkout).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  writeRecallTrace,
  writeRecallTraceAtRoot,
  readLastTraceId,
  writeLastTraceId,
  recordTraceOutcome,
} from '../src/recall-trace.js';

function tmpHome(): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'hippo-recall-trace-helper-'));
  return {
    home,
    restore: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe('writeRecallTrace', () => {
  it('happy path: inserts the trace row + result rows in order, never persists raw query text', () => {
    const { home, restore } = tmpHome();
    try {
      const db = openHippoDb(home);
      try {
        const traceId = writeRecallTrace(db, {
          tenantId: 'default',
          sessionId: 'sess-1',
          pipeline: 'api',
          query: 'super secret raw query text',
          explainMode: false,
          results: [
            { memoryId: 'mem-a', score: 0.9 },
            { memoryId: 'mem-b', score: 0.5 },
          ],
        });
        expect(traceId).not.toBeNull();

        const trace = db.prepare(`SELECT * FROM recall_traces WHERE id = ?`).get(traceId) as Record<string, unknown>;
        expect(trace.tenant_id).toBe('default');
        expect(trace.session_id).toBe('sess-1');
        expect(trace.pipeline).toBe('api');
        expect(trace.result_count).toBe(2);
        expect(trace.explain_mode).toBe(0);
        expect(String(trace.query_hash)).toMatch(/^[0-9a-f]{16}$/);
        expect(trace.query_length).toBe('super secret raw query text'.length);
        // Raw query text must never land in any persisted column.
        expect(JSON.stringify(trace)).not.toContain('super secret raw query text');

        const results = db.prepare(
          `SELECT * FROM recall_trace_results WHERE trace_id = ? ORDER BY result_rank ASC`,
        ).all(traceId) as Array<Record<string, unknown>>;
        expect(results).toHaveLength(2);
        expect(results[0].memory_id).toBe('mem-a');
        expect(results[0].result_rank).toBe(1);
        expect(results[0].score).toBe(0.9);
        expect(results[0].rerank_json).toBeNull();
        expect(results[1].memory_id).toBe('mem-b');
        expect(results[1].result_rank).toBe(2);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      restore();
    }
  });

  it('persists rerank_json only when explain results carry rerankSteps', () => {
    const { home, restore } = tmpHome();
    try {
      const db = openHippoDb(home);
      try {
        const traceId = writeRecallTrace(db, {
          tenantId: 'default',
          pipeline: 'cli',
          query: 'q',
          explainMode: true,
          results: [
            {
              memoryId: 'mem-a',
              score: 0.9,
              rerankSteps: [{ stage: 'goal-boost', scoreBefore: 0.8, scoreAfter: 0.9 }],
            },
          ],
        });
        const row = db.prepare(`SELECT rerank_json FROM recall_trace_results WHERE trace_id = ?`).get(traceId) as { rerank_json: string };
        const steps = JSON.parse(row.rerank_json);
        expect(steps).toEqual([{ stage: 'goal-boost', scoreBefore: 0.8, scoreAfter: 0.9 }]);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      restore();
    }
  });

  it('fail-soft: a trace write against a closed db does not throw, returns null, logs to stderr', () => {
    const { home, restore } = tmpHome();
    try {
      const db = openHippoDb(home);
      closeHippoDb(db);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let traceId: number | null = -1;
      expect(() => {
        traceId = writeRecallTrace(db, {
          tenantId: 'default',
          pipeline: 'api',
          query: 'q',
          results: [{ memoryId: 'mem-a', score: 1 }],
        });
      }).not.toThrow();
      expect(traceId).toBeNull();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    } finally {
      restore();
    }
  });

  it('composite-PK uniqueness (trace_id, result_rank) is upheld by the writer even under duplicate ids in input', () => {
    const { home, restore } = tmpHome();
    try {
      const db = openHippoDb(home);
      try {
        // Two distinct memory ids at the same array position never happens
        // in practice, but the writer relies on array index for rank, so
        // ranks are always unique per trace by construction.
        const traceId = writeRecallTrace(db, {
          tenantId: 'default',
          pipeline: 'api',
          query: 'q',
          results: [
            { memoryId: 'mem-a', score: 0.9 },
            { memoryId: 'mem-a', score: 0.5 }, // same memory id twice, different ranks
          ],
        });
        const rows = db.prepare(`SELECT result_rank FROM recall_trace_results WHERE trace_id = ? ORDER BY result_rank`).all(traceId) as Array<{ result_rank: number }>;
        expect(rows.map((r) => r.result_rank)).toEqual([1, 2]);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      restore();
    }
  });
});

describe('writeRecallTraceAtRoot', () => {
  it('opens its own connection, writes the trace, and stamps last_trace_id', () => {
    const { home, restore } = tmpHome();
    try {
      const traceId = writeRecallTraceAtRoot(home, {
        tenantId: 'default',
        pipeline: 'context',
        query: 'q',
        results: [{ memoryId: 'mem-a', score: 1 }],
      });
      expect(traceId).not.toBeNull();
      expect(readLastTraceId(home)).toBe(traceId);
    } finally {
      restore();
    }
  });
});

describe('readLastTraceId / writeLastTraceId', () => {
  it('returns null when unset', () => {
    const { home, restore } = tmpHome();
    try {
      expect(readLastTraceId(home)).toBeNull();
    } finally {
      restore();
    }
  });

  it('round-trips a written trace id', () => {
    const { home, restore } = tmpHome();
    try {
      writeLastTraceId(home, 42);
      expect(readLastTraceId(home)).toBe(42);
    } finally {
      restore();
    }
  });
});

describe('recordTraceOutcome', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: inserts an outcome row referencing the trace', () => {
    const { home, restore } = tmpHome();
    try {
      const db = openHippoDb(home);
      try {
        const traceId = writeRecallTrace(db, {
          tenantId: 'default',
          pipeline: 'cli',
          query: 'q',
          results: [{ memoryId: 'mem-a', score: 1 }],
        });
        recordTraceOutcome(db, {
          traceId: traceId as number,
          tenantId: 'default',
          outcome: 'positive',
          memoryIds: ['mem-a'],
        });
        const row = db.prepare(`SELECT * FROM recall_trace_outcomes WHERE trace_id = ?`).get(traceId) as Record<string, unknown>;
        expect(row.outcome).toBe('positive');
        expect(JSON.parse(row.memory_ids_json as string)).toEqual(['mem-a']);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      restore();
    }
  });

  it('fail-soft: an outcome write against a closed db does not throw', () => {
    const { home, restore } = tmpHome();
    try {
      const db = openHippoDb(home);
      closeHippoDb(db);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => {
        recordTraceOutcome(db, { traceId: 1, tenantId: 'default', outcome: 'positive', memoryIds: ['mem-a'] });
      }).not.toThrow();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    } finally {
      restore();
    }
  });
});
