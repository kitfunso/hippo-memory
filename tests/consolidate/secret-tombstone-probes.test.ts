// Sleep's tombstone probes take texts and check every form, so a raw older row still meets a tombstone on its stored form.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { Layer } from '../../src/base/memory/entry.js';
import { listAuditEvents } from '../../src/store/sqlite/audit.js';
import { insertRejectedValue } from '../../src/store/sqlite/rejection.js';
import { rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { redactSecretsStrict } from '../../src/base/util/secret-detect.js';
import * as api from '../../src/api/index.js';
import { consolidate } from '../../src/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEveryTenantEntries, writeEntry, appendSessionEvent } from '../_helpers/root-forms.js';
import { restoreRawTextAt } from '../_helpers/legacy-rows.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';
import { FIXED_NOW, pinClock } from '../_helpers/fixed-clock.js';

pinClock();
const GHP = runtimeJoin('ghp_', 'k7'.repeat(18));

afterEach(() => {
  vi.restoreAllMocks();
});

function refusalCount(home: string): number {
  const db = openHippoDb(home);
  try {
    return listAuditEvents(db, { tenantId: 'default', op: 'reject_refusal' }).length;
  } finally {
    closeHippoDb(db);
  }
}

describe('sleep tombstone probes over raw older rows', () => {
  it('a merge of raw rows whose stored rollup is tombstoned skips its cluster: no member demoted', async () => {
    const home = makeRoot('secret-probe-merge');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ replay: { count: 0 } }), 'utf8');
    const shortText = `migrate the billing database with token ${GHP} before the release window`;
    const longText = `migrate the billing database with token ${GHP} before the release window with backups`;
    const e1 = {
      ...createMemory(shortText, { layer: Layer.Episodic }),
      created: new Date(Date.now() - 60_000).toISOString(),
    };
    const e2 = createMemory(longText, { layer: Layer.Episodic });
    writeEntry(home, e1);
    writeEntry(home, e2);
    restoreRawTextAt(home, [e1, e2]);
    const merged = `[Consolidated from 2 related memories, newest first]\n\n- ${longText}\n- ${shortText}`;
    const db = openHippoDb(home);
    try {
      insertRejectedValue(db, {
        tenantId: 'default',
        digest: rejectionDigest(redactSecretsStrict(merged)),
        reason: 'rollup rejected in its stored form',
        rejectedBy: 'test',
        rejectedAt: new Date().toISOString(),
        normalizedChars: 1,
      });
    } finally {
      closeHippoDb(db);
    }

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await consolidate(home, { dryRun: false });

    expect(result.semanticCreated).toBe(0);
    const after = loadEveryTenantEntries(home);
    for (const member of [e1, e2]) {
      const row = after.find((e) => e.id === member.id);
      expect(row?.layer).toBe(Layer.Episodic);
      expect(row?.halfLifeDays).toBe(member.halfLifeDays);
    }
    expect(refusalCount(home)).toBe(1);
  });

  it('a trace built from raw events whose stored form is tombstoned is neither counted nor logged as promoted', async () => {
    const home = makeRoot('secret-probe-trace');
    const sid = 'session-raw-trace';
    await appendSessionEvent(home, 'default', {
      sessionId: sid,
      eventType: 'action',
      content: `rotated deploy token ${GHP}`,
      source: 'agent',
    });
    await appendSessionEvent(home, 'default', {
      sessionId: sid,
      eventType: 'session_complete',
      content: 'success',
      source: 'agent',
      metadata: { summary: 'rotated the deploy key' },
    });
    const first = await consolidate(home, { now: FIXED_NOW });
    expect(first.promotedTraces).toBe(1);
    const trace = loadEveryTenantEntries(home).find((e) => e.layer === Layer.Trace)!;
    await api.reject(apiCtx(home, 'default', { subject: 'cli', role: 'admin' }), {
      memoryId: trace.id,
      reason: 'wrong trace',
    });
    const db = openHippoDb(home);
    try {
      db.prepare(`UPDATE session_events SET content = ? WHERE session_id = ? AND event_type = 'action'`).run(
        `rotated deploy token ${GHP}`,
        sid,
      );
    } finally {
      closeHippoDb(db);
    }

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const second = await consolidate(home, { now: FIXED_NOW });

    expect(second.promotedTraces).toBe(0);
    expect(second.events?.some((e) => e.kind === 'tracePromoted')).not.toBe(true);
    expect(loadEveryTenantEntries(home).filter((e) => e.layer === Layer.Trace)).toHaveLength(0);
  });
});
