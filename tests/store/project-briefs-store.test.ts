import { describe, it, expect, beforeEach } from 'vitest';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import {
  loadProjectBriefs,
  briefFromReceipts,
  refreshedBrief,
  PROJECT_BRIEF,
} from '../../src/domain/objects/project-briefs.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadConfig } from '../../src/host/config-file.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';

import { closeObject, objectById } from '../../src/domain/objects/lifecycle.js';
import { CLI_ACTOR } from '../../src/base/scope/actor.js';
import { saveProjectBrief } from '../../src/entry/testing.js';
import { evalNow } from '../../src/infra/eval-switches.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, objectsAt } = sessionPerTest();

const MAX_BRIEF_SUMMARY_LEN = 8192;
const MAX_RECEIPT_HEADLINE_LEN = 200;

async function activeBrief(home: string, tenantId: string, repo: string) {
  return (await loadProjectBriefs(objectsAt(home), tenantId, { status: 'active', repo, limit: 1 }))[0] ?? null;
}
function countRows(home: string, table: string): number {
  const db = openHippoDb(home);
  try {
    // SAFETY: the query always selects a single COUNT(*) aggregate as c, so the
    // driver always returns one row shaped { c: number }.
    return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
  } finally {
    closeHippoDb(db);
  }
}
function receiptFor(repo: string, content: string, opts: { tenant: string; source?: string }): MemoryEntry {
  return createMemory(content, {
    tags: [`path:${repo.toLowerCase()}`, 'note'],
    layer: Layer.Semantic,
    confidence: 'verified',
    source: opts.source ?? 'manual',
    tenantId: opts.tenant,
  });
}

function addReceipt(home: string, tenant: string, repo: string, content: string, source = 'manual'): string {
  const mem = receiptFor(repo, content, { tenant, source });
  writeEntry(home, mem, { actor: 'test' });
  return mem.id;
}
function setCreated(home: string, memoryId: string, isoCreated: string): void {
  const db = openHippoDb(home);
  try {
    db.prepare(`UPDATE memories SET created = ? WHERE id = ?`).run(isoCreated, memoryId);
  } finally {
    closeHippoDb(db);
  }
}

describe('project_briefs store (repo-scoped / auto-refreshes first-class object)', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('project-briefs');
  });

  it('saveProjectBrief creates memory + row + project_brief_create audit; v1', async () => {
    const b = await saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      repo: 'hippo',
      summary: 'agent-memory lib',
    });
    expect(b.id).toBe(1);
    expect(b.memoryId).not.toBeNull();
    expect(b.repo).toBe('hippo');
    expect(b.summary).toBe('agent-memory lib');
    expect(b.version).toBe(1);
    expect(b.status).toBe('active');
    expect(b.changeSummary).toBeNull();
    const db = openHippoDb(home);
    try {
      // SAFETY: the query selects content/source/tags_json from memories, whose
      // schema types those columns TEXT/TEXT/TEXT (tags_json JSON-encoded).
      const memRow = db.prepare(`SELECT content, source, tags_json FROM memories WHERE id = ?`).get(b.memoryId!) as {
        content: string;
        source: string;
        tags_json: string;
      };
      expect(memRow.content).toContain('hippo');
      expect(memRow.content).toContain('agent-memory lib');
      expect(memRow.source).toBe('project_brief');
      // SAFETY: memories.tags_json is always a JSON-encoded string array, written by
      // writeEntry/saveProjectBrief in this codebase.
      expect(JSON.parse(memRow.tags_json) as string[]).toContain('project_brief');
      // SAFETY: the query selects only metadata_json (TEXT) from audit_log.
      const rows = db
        .prepare(`SELECT metadata_json FROM audit_log WHERE op='project_brief_create' AND target_id=?`)
        .all(String(b.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
      // SAFETY: project_brief_create audit metadata is always the flat object built
      // at that op's appendAuditEvent call site with these two fields.
      const meta = JSON.parse(rows[0].metadata_json) as { repo: string; refreshed: boolean };
      expect(meta.repo).toBe('hippo');
      expect(meta.refreshed).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });

  it('status + repo filters; loadActiveBriefForRepo', async () => {
    const a = await saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      repo: 'alpha',
      summary: 'x',
    });
    const b = await saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      repo: 'beta',
      summary: 'x',
    });
    const c = await saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      repo: 'gamma',
      summary: 'x',
    });
    await saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      repo: 'beta',
      summary: 'x2',
      supersedesBriefId: b.id,
    });
    await closeObject(objectsAt(home), PROJECT_BRIEF, {
      tenantId: 'default',
      id: c.id,
      actor: CLI_ACTOR,
      now: evalNow(),
    });
    expect((await activeBrief(home, 'default', 'alpha'))!.id).toBe(a.id);
    expect(await activeBrief(home, 'default', 'gamma')).toBeNull();
    expect((await loadProjectBriefs(objectsAt(home), 'default', { status: 'closed' })).map((x) => x.id)).toEqual([
      c.id,
    ]);
    expect((await loadProjectBriefs(objectsAt(home), 'default', { repo: 'beta' })).length).toBe(2);
    expect((await loadProjectBriefs(objectsAt(home), 'default', { repo: 'beta', status: 'active' })).length).toBe(1);
    expect((await loadProjectBriefs(objectsAt(home), 'default')).length).toBe(4);
  });

  it('validation: missing repo/summary; single-line repo; caps', async () => {
    await expect(
      saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { repo: '   ', summary: 'x' }),
    ).rejects.toThrow(/repo must not be blank/);
    await expect(
      saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', { repo: 'r', summary: '  ' }),
    ).rejects.toThrow(/summary must not be blank/);
    await expect(
      saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        repo: 'bad\nrepo',
        summary: 'x',
      }),
    ).rejects.toThrow(/single line/);
    await expect(
      saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        repo: 'big',
        summary: 'y'.repeat(MAX_BRIEF_SUMMARY_LEN + 1),
      }),
    ).rejects.toThrow(/summary must be at most/);
    await expect(
      saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        repo: 'r',
        summary: 'ok',
        changeSummary: 'z'.repeat(4097),
        supersedesBriefId: 1,
      }),
    ).rejects.toThrow(/changeSummary must be at most/);
  });

  it('assembleBriefFromReceipts: tenant-isolated path tag match, excludes own brief mirror, DESC order, truncation', async () => {
    const r1 = addReceipt(home, 'default', 'hippo', 'first receipt headline');
    const r2 = addReceipt(home, 'default', 'hippo', 'second receipt headline', 'slack');
    setCreated(home, r1, '2026-05-01T00:00:00.000Z');
    setCreated(home, r2, '2026-05-02T00:00:00.000Z');
    addReceipt(home, 'default', 'other', 'unrelated repo receipt');
    addReceipt(home, 'tenant-b', 'hippo', 'cross-tenant receipt');
    const brief = await saveProjectBrief(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      repo: 'hippo',
      summary: 'the brief body',
      extraTags: ['path:hippo'],
    });
    void brief;

    const { markdown, receiptCount } = await briefFromReceipts(objectsAt(home), 'default', 'hippo');
    expect(receiptCount).toBe(2);
    expect(markdown).toContain('# Project Brief: hippo');
    expect(markdown).toContain('_Auto-assembled from 2 receipt(s)._');
    expect(markdown).toContain('first receipt headline');
    expect(markdown).toContain('[slack] second receipt headline');
    expect(markdown).not.toContain('unrelated repo receipt');
    expect(markdown).not.toContain('cross-tenant receipt');
    expect(markdown).not.toContain('the brief body');
    expect(markdown.indexOf('second receipt headline')).toBeLessThan(markdown.indexOf('first receipt headline'));

    addReceipt(home, 'default', 'trunc', 'z'.repeat(MAX_RECEIPT_HEADLINE_LEN + 50));
    const t = await briefFromReceipts(objectsAt(home), 'default', 'trunc');
    expect(t.markdown).toContain('z'.repeat(MAX_RECEIPT_HEADLINE_LEN) + '...');
    expect(t.markdown).not.toContain('z'.repeat(MAX_RECEIPT_HEADLINE_LEN + 1));
  });

  it('assembleBriefFromReceipts: LIKE-escape on %/_; prefix-collision hip != hippo; markdown headline verbatim; zero-receipts', async () => {
    addReceipt(home, 'default', 'a_b', 'underscore-repo receipt');
    addReceipt(home, 'default', 'axb', 'should NOT match a_b wildcard');
    const esc = await briefFromReceipts(objectsAt(home), 'default', 'a_b');
    expect(esc.receiptCount).toBe(1);
    expect(esc.markdown).toContain('underscore-repo receipt');
    expect(esc.markdown).not.toContain('should NOT match');

    addReceipt(home, 'default', 'hippo', 'hippo receipt');
    const hip = await briefFromReceipts(objectsAt(home), 'default', 'hip');
    expect(hip.receiptCount).toBe(0);
    expect(hip.markdown).toContain('_No receipts found for hip._');

    addReceipt(home, 'default', 'md', '## not a real heading');
    const md = await briefFromReceipts(objectsAt(home), 'default', 'md');
    expect(md.markdown).toContain('- ');
    expect(md.markdown).toContain('## not a real heading');

    const empty = await briefFromReceipts(objectsAt(home), 'default', 'nothinghere');
    expect(empty.receiptCount).toBe(0);
    expect(empty.markdown).toContain('# Project Brief: nothinghere');
    expect(empty.markdown).toContain('_No receipts found for nothinghere._');
  });

  it('refreshBrief: creates v1 when none; supersedes active on 2nd; change_summary + refreshed metadata; dry-run does not write', async () => {
    addReceipt(home, 'default', 'hippo', 'receipt one');
    const b0 = countRows(home, 'project_briefs');
    const dry = await briefFromReceipts(objectsAt(home), 'default', 'hippo');
    expect(dry.receiptCount).toBe(1);
    expect(countRows(home, 'project_briefs')).toBe(b0);

    const v1 = await refreshedBrief(
      objectsAt(home),
      { now: evalNow(), baseHalfLifeDays: loadConfig(home).defaultHalfLifeDays, tenantId: 'default', actor: 'cli' },
      'hippo',
    );
    expect(v1.version).toBe(1);
    expect(v1.status).toBe('active');
    expect(v1.summary).toContain('receipt one');
    expect(v1.changeSummary).toBeNull();
    const dbTag = openHippoDb(home);
    try {
      // SAFETY: the query selects only tags_json (TEXT, JSON-encoded array) from
      // memories for a single row by primary key.
      const tagsJson = (
        dbTag.prepare(`SELECT tags_json FROM memories WHERE id = ?`).get(v1.memoryId!) as { tags_json: string }
      ).tags_json;
      // SAFETY: memories.tags_json is always a JSON-encoded string array, written by
      // writeEntry/refreshBrief in this codebase.
      expect(JSON.parse(tagsJson) as string[]).toContain('path:hippo');
    } finally {
      closeHippoDb(dbTag);
    }
    const reAssemble = await briefFromReceipts(objectsAt(home), 'default', 'hippo');
    expect(reAssemble.receiptCount).toBe(1);
    const db = openHippoDb(home);
    try {
      // SAFETY: the query selects only metadata_json (TEXT) from audit_log for a
      // single row; project_brief_create metadata is always this flat object.
      const meta = JSON.parse(
        (
          db
            .prepare(`SELECT metadata_json FROM audit_log WHERE op='project_brief_create' AND target_id=?`)
            .get(String(v1.id)) as { metadata_json: string }
        ).metadata_json,
      ) as { refreshed: boolean; receipt_count: number };
      expect(meta.refreshed).toBe(true);
      expect(meta.receipt_count).toBe(1);
    } finally {
      closeHippoDb(db);
    }

    addReceipt(home, 'default', 'hippo', 'receipt two');
    const v2 = await refreshedBrief(
      objectsAt(home),
      { now: evalNow(), baseHalfLifeDays: loadConfig(home).defaultHalfLifeDays, tenantId: 'default', actor: 'cli' },
      'hippo',
    );
    expect(v2.version).toBe(2);
    expect(v2.changeSummary).toBe('auto-refresh from 2 receipt(s)');
    expect((await objectById(objectsAt(home), PROJECT_BRIEF, 'default', v1.id))!.status).toBe('superseded');
    expect((await activeBrief(home, 'default', 'hippo'))!.id).toBe(v2.id);
    const db2 = openHippoDb(home);
    try {
      // SAFETY: the query selects only metadata_json (TEXT) from audit_log for a
      // single row; project_brief_supersede metadata is always this flat object.
      const meta = JSON.parse(
        (
          db2
            .prepare(`SELECT metadata_json FROM audit_log WHERE op='project_brief_supersede' AND target_id=?`)
            .get(String(v1.id)) as { metadata_json: string }
        ).metadata_json,
      ) as { refreshed: boolean; receipt_count: number };
      expect(meta.refreshed).toBe(true);
      expect(meta.receipt_count).toBe(2);
    } finally {
      closeHippoDb(db2);
    }
  });

  it('refresh stays within the summary cap with many long receipts', async () => {
    writeEntriesTogether(
      home,
      Array.from({ length: 50 }, (_, i) => receiptFor('big', `receipt ${i} ` + 'x'.repeat(300), { tenant: 'default' })),
    );

    const assembled = await briefFromReceipts(objectsAt(home), 'default', 'big');
    expect(assembled.receiptCount).toBe(50);
    expect(assembled.markdown.length).toBeLessThanOrEqual(MAX_BRIEF_SUMMARY_LEN);
    expect(assembled.markdown).toContain('omitted (summary cap)');
    const kept = assembled.markdown.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(assembled.markdown).toContain(`_Auto-assembled from ${kept} of 50 receipt(s)._`);
    expect(assembled.markdown).toContain(`_... ${50 - kept} more receipt(s) omitted (summary cap)._`);
    const b = await refreshedBrief(
      objectsAt(home),
      { now: evalNow(), baseHalfLifeDays: loadConfig(home).defaultHalfLifeDays, tenantId: 'default', actor: 'cli' },
      'big',
    );
    expect(b.version).toBe(1);
    expect(b.summary.length).toBeLessThanOrEqual(MAX_BRIEF_SUMMARY_LEN);
    expect((await objectById(objectsAt(home), PROJECT_BRIEF, 'default', b.id))!.summary.length).toBeLessThanOrEqual(
      MAX_BRIEF_SUMMARY_LEN,
    );
  });
});
