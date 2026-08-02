/**
 * LC1 recall-trace helper unit tests
 * (docs/plans/2026-08-02-lc1-recall-trace-persistence.md).
 *
 * Covers writeRecallTrace / writeRecallTraceAtRoot / recordTraceOutcome in
 * isolation, against a scratch HIPPO_HOME (never a repo checkout).
 *
 * readLastTraceId / writeLastTraceId were DELETED (F1(e) structural fix,
 * final review round): last_trace_id now only ever advances atomically with
 * last_retrieval_ids via store.ts's saveIndex, so the standalone meta
 * accessors had no remaining production caller. See tests/recall-trace-
 * wiring.test.ts for last_trace_id coverage via loadIndex/saveIndex.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { writeRecallTrace, writeRecallTraceAtRoot, recordTraceOutcome } from '../src/recall-trace.js';

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

  it('F3 privacy fix: strips note (and any other free-form field) from rerank_json, keeping only stage/multiplier/scoreBefore/scoreAfter', () => {
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
              rerankSteps: [
                {
                  stage: 'goal-boost',
                  multiplier: 1.5,
                  scoreBefore: 0.6,
                  scoreAfter: 0.9,
                  note: 'matched goal tag: super-secret-project-codename',
                } as never,
              ],
            },
          ],
        });
        const row = db.prepare(`SELECT rerank_json FROM recall_trace_results WHERE trace_id = ?`).get(traceId) as { rerank_json: string };
        expect(row.rerank_json).not.toContain('note');
        expect(row.rerank_json).not.toContain('super-secret-project-codename');
        const steps = JSON.parse(row.rerank_json);
        expect(steps).toEqual([{ stage: 'goal-boost', multiplier: 1.5, scoreBefore: 0.6, scoreAfter: 0.9 }]);
        expect(Object.keys(steps[0]).sort()).toEqual(['multiplier', 'scoreAfter', 'scoreBefore', 'stage']);
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
  it('opens its own connection, writes the trace, and returns the new trace id', () => {
    // F1 structural fix: this function no longer touches last_trace_id at
    // all — that is now the CALLER's job (fold the returned id into
    // HippoIndex.last_trace_id, then a single saveIndex call persists it
    // atomically with last_retrieval_ids). See tests/recall-trace-
    // wiring.test.ts for the caller-side lockstep behavior.
    const { home, restore } = tmpHome();
    try {
      const traceId = writeRecallTraceAtRoot(home, {
        tenantId: 'default',
        pipeline: 'context',
        query: 'q',
        results: [{ memoryId: 'mem-a', score: 1 }],
      });
      expect(traceId).not.toBeNull();

      const db = openHippoDb(home);
      try {
        const trace = db.prepare(`SELECT * FROM recall_traces WHERE id = ?`).get(traceId) as Record<string, unknown>;
        expect(trace).toBeDefined();
        expect(trace.pipeline).toBe('context');
      } finally {
        closeHippoDb(db);
      }
    } finally {
      restore();
    }
  });
});

describe('recordTraceOutcome', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('happy path: inserts an outcome row referencing the trace (normal path unchanged)', () => {
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

  it('F4 validation: skips (no row, console.error) when the trace belongs to a DIFFERENT tenant', () => {
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
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        recordTraceOutcome(db, {
          traceId: traceId as number,
          tenantId: 'tenant_b', // mismatched — trace belongs to 'default'
          outcome: 'positive',
          memoryIds: ['mem-a'],
        });
        expect(errSpy).toHaveBeenCalled();
        const count = db.prepare(`SELECT COUNT(*) AS c FROM recall_trace_outcomes`).get() as { c: number };
        expect(count.c).toBe(0);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      restore();
    }
  });

  it('F4 validation: skips (no row) when the named trace does not exist', () => {
    const { home, restore } = tmpHome();
    try {
      const db = openHippoDb(home);
      try {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        recordTraceOutcome(db, {
          traceId: 999999,
          tenantId: 'default',
          outcome: 'positive',
          memoryIds: ['mem-a'],
        });
        expect(errSpy).toHaveBeenCalled();
        const count = db.prepare(`SELECT COUNT(*) AS c FROM recall_trace_outcomes`).get() as { c: number };
        expect(count.c).toBe(0);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      restore();
    }
  });

  it('F4 validation: records ONLY the intersection when some memoryIds are not members of the trace', () => {
    const { home, restore } = tmpHome();
    try {
      const db = openHippoDb(home);
      try {
        const traceId = writeRecallTrace(db, {
          tenantId: 'default',
          pipeline: 'cli',
          query: 'q',
          results: [
            { memoryId: 'mem-a', score: 0.9 },
            { memoryId: 'mem-b', score: 0.5 },
          ],
        });
        // mem-c was never in this trace's results (stale caller state).
        recordTraceOutcome(db, {
          traceId: traceId as number,
          tenantId: 'default',
          outcome: 'positive',
          memoryIds: ['mem-a', 'mem-c'],
        });
        const row = db.prepare(`SELECT * FROM recall_trace_outcomes WHERE trace_id = ?`).get(traceId) as Record<string, unknown>;
        expect(JSON.parse(row.memory_ids_json as string)).toEqual(['mem-a']);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      restore();
    }
  });

  it('F4 validation: skips entirely (no row) when NONE of memoryIds intersect the trace', () => {
    const { home, restore } = tmpHome();
    try {
      const db = openHippoDb(home);
      try {
        const traceId = writeRecallTrace(db, {
          tenantId: 'default',
          pipeline: 'cli',
          query: 'q',
          results: [{ memoryId: 'mem-a', score: 0.9 }],
        });
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        recordTraceOutcome(db, {
          traceId: traceId as number,
          tenantId: 'default',
          outcome: 'positive',
          memoryIds: ['mem-z'],
        });
        expect(errSpy).toHaveBeenCalled();
        const count = db.prepare(`SELECT COUNT(*) AS c FROM recall_trace_outcomes`).get() as { c: number };
        expect(count.c).toBe(0);
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
