/**
 * E2 project_brief first-class object (repo-scoped / auto-refreshes) - store tests.
 * Docs: docs/plans/2026-05-30-e2-project-brief-object.md
 *
 * Covers:
 * 1. saveProjectBrief creates memory + project_briefs row (+ project_brief_create audit), v1
 * 2. SAVEPOINT atomicity
 * 3. supersede chain + version + change_summary + project_brief_supersede audit
 * 4. supersede CAS (re-supersede not-active; missing not-found); self-supersede preflight
 * 5. close + close guard (not-found; cannot-close-superseded; cannot re-close)
 * 6. cross-tenant INSERT trigger + supersede tenant-match trigger
 * 7. ON DELETE SET NULL + old version loadable
 * 8. status + repo filters; loadActiveBriefForRepo; invalid status
 * 9. validation: missing repo/summary; repo single-line (newline rejected); caps
 * 10. assembleBriefFromReceipts: tenant-isolated path:<repo> match, excludes own
 *     brief mirror (source='project_brief'), deterministic created DESC, headline
 *     truncation, LIKE-escape on %/_, prefix-collision (hip != hippo), markdown
 *     headline verbatim, zero-receipts digest
 * 11. refreshBrief: v1-create when none, supersede on 2nd, change_summary +
 *     refreshed metadata, dry-run assemble does NOT write
 * 12. schema v35 table + 3 triggers + 3 indexes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, deleteEntry, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  saveProjectBrief,
  closeProjectBrief,
  loadProjectBriefById,
  loadProjectBriefs,
  loadActiveBriefForRepo,
  assembleBriefFromReceipts,
  refreshBrief,
  VALID_BRIEF_STATES,
  MAX_BRIEF_SUMMARY_LEN,
  MAX_RECEIPT_HEADLINE_LEN,
} from '../src/project-briefs.js';

function makeRoot(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function countRows(home: string, table: string): number {
  const db = openHippoDb(home);
  try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c; }
  finally { closeHippoDb(db); }
}
/** Write a non-brief memory tagged path:<repo> so it counts as a receipt. */
function addReceipt(home: string, tenant: string, repo: string, content: string, source = 'manual'): string {
  const mem = createMemory(content, {
    tags: [`path:${repo.toLowerCase()}`, 'note'],
    layer: Layer.Semantic,
    confidence: 'verified',
    source,
    tenantId: tenant,
  });
  writeEntry(home, mem, { actor: 'test' });
  return mem.id;
}
/** Force a memory's created timestamp for deterministic ordering tests. */
function setCreated(home: string, memoryId: string, isoCreated: string): void {
  const db = openHippoDb(home);
  try { db.prepare(`UPDATE memories SET created = ? WHERE id = ?`).run(isoCreated, memoryId); }
  finally { closeHippoDb(db); }
}

describe('project_briefs store (E2 repo-scoped / auto-refreshes first-class object)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('project-briefs'); });
  afterEach(() => safeRmSync(home));

  it('saveProjectBrief creates memory + row + project_brief_create audit; v1', () => {
    const b = saveProjectBrief(home, 'default', { repo: 'hippo', summary: 'agent-memory lib' });
    expect(b.id).toBeGreaterThan(0);
    expect(b.memoryId).not.toBeNull();
    expect(b.repo).toBe('hippo');
    expect(b.summary).toBe('agent-memory lib');
    expect(b.version).toBe(1);
    expect(b.status).toBe('active');
    expect(b.changeSummary).toBeNull();
    const db = openHippoDb(home);
    try {
      const memRow = db.prepare(`SELECT content, source, tags_json FROM memories WHERE id = ?`)
        .get(b.memoryId!) as { content: string; source: string; tags_json: string };
      expect(memRow.content).toContain('hippo');
      expect(memRow.content).toContain('agent-memory lib');
      expect(memRow.source).toBe('project_brief');
      expect((JSON.parse(memRow.tags_json) as string[])).toContain('project_brief');
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op='project_brief_create' AND target_id=?`)
        .all(String(b.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
      const meta = JSON.parse(rows[0].metadata_json) as { repo: string; refreshed: boolean };
      expect(meta.repo).toBe('hippo');
      expect(meta.refreshed).toBe(false);
    } finally { closeHippoDb(db); }
  });

  it('SAVEPOINT atomicity: writeEntry throw rolls back both', () => {
    const m0 = countRows(home, 'memories'); const b0 = countRows(home, 'project_briefs');
    const mem = createMemory('throwing brief', {
      tags: ['project_brief'], layer: Layer.Semantic, confidence: 'verified', source: 'project_brief', tenantId: 'default',
    });
    expect(() => writeEntry(home, mem, { afterWrite: () => { throw new Error('forced'); } })).toThrow('forced');
    expect(countRows(home, 'memories')).toBe(m0);
    expect(countRows(home, 'project_briefs')).toBe(b0);
  });

  it('supersede chain + version + change_summary + project_brief_supersede audit', () => {
    const v1 = saveProjectBrief(home, 'default', { repo: 'r', summary: 'old' });
    const v2 = saveProjectBrief(home, 'default', { repo: 'r', summary: 'new', changeSummary: 'reworded', supersedesBriefId: v1.id });
    const v3 = saveProjectBrief(home, 'default', { repo: 'r', summary: 'newer', supersedesBriefId: v2.id });
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(v2.changeSummary).toBe('reworded');
    const reV1 = loadProjectBriefById(home, 'default', v1.id)!;
    expect(reV1.status).toBe('superseded');
    expect(reV1.supersededBy).toBe(v2.id);
    expect(loadActiveBriefForRepo(home, 'default', 'r')!.id).toBe(v3.id);
    const db = openHippoDb(home);
    try {
      expect(db.prepare(`SELECT 1 FROM audit_log WHERE op='project_brief_supersede' AND target_id=?`).all(String(v1.id)).length).toBe(1);
    } finally { closeHippoDb(db); }
  });

  it('supersede CAS (re-supersede not-active; missing not-found); self-supersede preflight', () => {
    const v1 = saveProjectBrief(home, 'default', { repo: 'o', summary: 'a' });
    saveProjectBrief(home, 'default', { repo: 'o', summary: 'b', supersedesBriefId: v1.id });
    expect(() => saveProjectBrief(home, 'default', { repo: 'o', summary: 'c', supersedesBriefId: v1.id })).toThrow(/not active/);
    expect(() => saveProjectBrief(home, 'default', { repo: 'x', summary: 'c', supersedesBriefId: 99999 })).toThrow(/not found/);
    const b0 = countRows(home, 'project_briefs');
    expect(() => saveProjectBrief(home, 'default', { repo: 'self', summary: 'a', supersedesBriefId: 1 })).toThrow(/not active|not found/);
    expect(countRows(home, 'project_briefs')).toBe(b0);
  });

  it('close + close guard (not-found; cannot-close-superseded; cannot re-close)', () => {
    expect(() => closeProjectBrief(home, 'default', 77777)).toThrow(/not found/);
    const v1 = saveProjectBrief(home, 'default', { repo: 'sup', summary: 'a' });
    saveProjectBrief(home, 'default', { repo: 'sup', summary: 'b', supersedesBriefId: v1.id });
    expect(() => closeProjectBrief(home, 'default', v1.id)).toThrow(/not active/);
    const c = saveProjectBrief(home, 'default', { repo: 'cl', summary: 'a' });
    closeProjectBrief(home, 'default', c.id);
    expect(() => closeProjectBrief(home, 'default', c.id)).toThrow(/not active/);
  });

  it('cross-tenant INSERT trigger + supersede tenant-match trigger raise ABORT', () => {
    const mem = createMemory('tenant-a', {
      tags: ['project_brief'], layer: Layer.Semantic, confidence: 'verified', source: 'project_brief', tenantId: 'tenant-a',
    });
    writeEntry(home, mem);
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`INSERT INTO project_briefs(memory_id, tenant_id, repo, summary, version, status, created_at)
          VALUES (?, 'tenant-b', 'x', 'y', 1, 'active', ?)`).run(mem.id, new Date().toISOString());
      }).toThrow(/tenant_id must match memories\.tenant_id/);
    } finally { closeHippoDb(db); }
    const a = saveProjectBrief(home, 'tenant-a', { repo: 'A', summary: 'a' });
    const b = saveProjectBrief(home, 'tenant-b', { repo: 'B', summary: 'b' });
    const db2 = openHippoDb(home);
    try {
      expect(() => db2.prepare(`UPDATE project_briefs SET superseded_by=? WHERE id=?`).run(b.id, a.id))
        .toThrow(/superseded_by must reference a project_brief in the same tenant/);
    } finally { closeHippoDb(db2); }
  });

  it('ON DELETE SET NULL: forgetting the memory orphans the brief; old versions loadable', () => {
    const v1 = saveProjectBrief(home, 'default', { repo: 'd', summary: 'a' });
    const v2 = saveProjectBrief(home, 'default', { repo: 'd', summary: 'b', supersedesBriefId: v1.id });
    deleteEntry(home, v1.memoryId!, 'default');
    deleteEntry(home, v2.memoryId!, 'default');
    expect(loadProjectBriefById(home, 'default', v1.id)!.memoryId).toBeNull();
    expect(loadProjectBriefById(home, 'default', v1.id)!.status).toBe('superseded');
    expect(loadProjectBriefById(home, 'default', v2.id)!.status).toBe('active');
  });

  it('status + repo filters; loadActiveBriefForRepo; invalid status', () => {
    const a = saveProjectBrief(home, 'default', { repo: 'alpha', summary: 'x' });
    const b = saveProjectBrief(home, 'default', { repo: 'beta', summary: 'x' });
    const c = saveProjectBrief(home, 'default', { repo: 'gamma', summary: 'x' });
    saveProjectBrief(home, 'default', { repo: 'beta', summary: 'x2', supersedesBriefId: b.id });
    closeProjectBrief(home, 'default', c.id);
    expect(loadActiveBriefForRepo(home, 'default', 'alpha')!.id).toBe(a.id);
    expect(loadActiveBriefForRepo(home, 'default', 'gamma')).toBeNull(); // closed
    expect(loadProjectBriefs(home, 'default', { status: 'closed' }).map((x) => x.id)).toEqual([c.id]);
    expect(loadProjectBriefs(home, 'default', { repo: 'beta' }).length).toBe(2); // v1 superseded + v2 active
    expect(loadProjectBriefs(home, 'default', { repo: 'beta', status: 'active' }).length).toBe(1);
    expect(loadProjectBriefs(home, 'default').length).toBe(4);
    // @ts-expect-error runtime validation
    expect(() => loadProjectBriefs(home, 'default', { status: 'retired' })).toThrow(/status must be one of/);
    expect(VALID_BRIEF_STATES.has('active')).toBe(true);
  });

  it('validation: missing repo/summary; single-line repo; caps', () => {
    expect(() => saveProjectBrief(home, 'default', { repo: '   ', summary: 'x' })).toThrow(/repo is required/);
    expect(() => saveProjectBrief(home, 'default', { repo: 'r', summary: '  ' })).toThrow(/summary is required/);
    expect(() => saveProjectBrief(home, 'default', { repo: 'bad\nrepo', summary: 'x' })).toThrow(/single line/);
    expect(() => saveProjectBrief(home, 'default', { repo: 'big', summary: 'y'.repeat(MAX_BRIEF_SUMMARY_LEN + 1) })).toThrow(/summary exceeds/);
    expect(() => saveProjectBrief(home, 'default', { repo: 'r', summary: 'ok', changeSummary: 'z'.repeat(4097), supersedesBriefId: 1 })).toThrow(/changeSummary exceeds/);
  });

  it('assembleBriefFromReceipts: tenant-isolated path tag match, excludes own brief mirror, DESC order, truncation', () => {
    // tenant 'default' receipts for repo 'hippo'
    const r1 = addReceipt(home, 'default', 'hippo', 'first receipt headline');
    const r2 = addReceipt(home, 'default', 'hippo', 'second receipt headline', 'slack');
    setCreated(home, r1, '2026-05-01T00:00:00.000Z');
    setCreated(home, r2, '2026-05-02T00:00:00.000Z');
    // a receipt for a DIFFERENT repo must not appear
    addReceipt(home, 'default', 'other', 'unrelated repo receipt');
    // a receipt for the SAME repo tag but a DIFFERENT tenant must not appear
    addReceipt(home, 'tenant-b', 'hippo', 'cross-tenant receipt');
    // the brief's OWN mirror (source='project_brief') must be excluded even though
    // it carries the repo path tag
    const brief = saveProjectBrief(home, 'default', { repo: 'hippo', summary: 'the brief body', extraTags: ['path:hippo'] });
    void brief;

    const { markdown, receiptCount } = assembleBriefFromReceipts(home, 'default', 'hippo');
    expect(receiptCount).toBe(2);
    expect(markdown).toContain('# Project Brief: hippo');
    expect(markdown).toContain('_Auto-assembled from 2 receipt(s)._');
    expect(markdown).toContain('first receipt headline');
    expect(markdown).toContain('[slack] second receipt headline');
    expect(markdown).not.toContain('unrelated repo receipt');
    expect(markdown).not.toContain('cross-tenant receipt');
    expect(markdown).not.toContain('the brief body');
    // created DESC: r2 (May 2) before r1 (May 1)
    expect(markdown.indexOf('second receipt headline')).toBeLessThan(markdown.indexOf('first receipt headline'));

    // headline truncation
    addReceipt(home, 'default', 'trunc', 'z'.repeat(MAX_RECEIPT_HEADLINE_LEN + 50));
    const t = assembleBriefFromReceipts(home, 'default', 'trunc');
    expect(t.markdown).toContain('z'.repeat(MAX_RECEIPT_HEADLINE_LEN) + '...');
    expect(t.markdown).not.toContain('z'.repeat(MAX_RECEIPT_HEADLINE_LEN + 1));
  });

  it('assembleBriefFromReceipts: LIKE-escape on %/_; prefix-collision hip != hippo; markdown headline verbatim; zero-receipts', () => {
    // LIKE wildcards in repo must be treated literally (escaped), not as wildcards
    addReceipt(home, 'default', 'a_b', 'underscore-repo receipt');
    addReceipt(home, 'default', 'axb', 'should NOT match a_b wildcard');
    const esc = assembleBriefFromReceipts(home, 'default', 'a_b');
    expect(esc.receiptCount).toBe(1);
    expect(esc.markdown).toContain('underscore-repo receipt');
    expect(esc.markdown).not.toContain('should NOT match');

    // prefix-collision: the surrounding quotes in the LIKE pattern are load-bearing.
    addReceipt(home, 'default', 'hippo', 'hippo receipt');
    const hip = assembleBriefFromReceipts(home, 'default', 'hip');
    expect(hip.receiptCount).toBe(0);
    expect(hip.markdown).toContain('_No receipts found for hip._');

    // markdown control chars in receipt content render as a literal list-item body
    addReceipt(home, 'default', 'md', '## not a real heading');
    const md = assembleBriefFromReceipts(home, 'default', 'md');
    expect(md.markdown).toContain('- ');
    expect(md.markdown).toContain('## not a real heading');

    // zero receipts -> valid non-empty digest
    const empty = assembleBriefFromReceipts(home, 'default', 'nothinghere');
    expect(empty.receiptCount).toBe(0);
    expect(empty.markdown).toContain('# Project Brief: nothinghere');
    expect(empty.markdown).toContain('_No receipts found for nothinghere._');
  });

  it('refreshBrief: creates v1 when none; supersedes active on 2nd; change_summary + refreshed metadata; dry-run does not write', () => {
    addReceipt(home, 'default', 'hippo', 'receipt one');
    // dry-run (assemble) must NOT write a brief row
    const b0 = countRows(home, 'project_briefs');
    const dry = assembleBriefFromReceipts(home, 'default', 'hippo');
    expect(dry.receiptCount).toBe(1);
    expect(countRows(home, 'project_briefs')).toBe(b0);

    // first refresh creates v1
    const v1 = refreshBrief(home, 'default', 'hippo');
    expect(v1.version).toBe(1);
    expect(v1.status).toBe('active');
    expect(v1.summary).toContain('receipt one');
    expect(v1.changeSummary).toBeNull(); // create path
    // the refreshed brief's mirror must carry the path:<repo> tag so path-aware
    // recall treats it as repo-local (codex-review 2026-05-30, P2)
    const dbTag = openHippoDb(home);
    try {
      const tagsJson = (dbTag.prepare(`SELECT tags_json FROM memories WHERE id = ?`)
        .get(v1.memoryId!) as { tags_json: string }).tags_json;
      expect(JSON.parse(tagsJson) as string[]).toContain('path:hippo');
    } finally { closeHippoDb(dbTag); }
    // a subsequent refresh must STILL exclude the brief's own mirror (source guard),
    // i.e. the path-tagged brief mirror does not inflate the receipt count
    const reAssemble = assembleBriefFromReceipts(home, 'default', 'hippo');
    expect(reAssemble.receiptCount).toBe(1); // only the real receipt, not the brief
    const db = openHippoDb(home);
    try {
      const meta = JSON.parse((db.prepare(`SELECT metadata_json FROM audit_log WHERE op='project_brief_create' AND target_id=?`)
        .get(String(v1.id)) as { metadata_json: string }).metadata_json) as { refreshed: boolean; receipt_count: number };
      expect(meta.refreshed).toBe(true);
      expect(meta.receipt_count).toBe(1);
    } finally { closeHippoDb(db); }

    // a new receipt + a second refresh supersedes v1
    addReceipt(home, 'default', 'hippo', 'receipt two');
    const v2 = refreshBrief(home, 'default', 'hippo');
    expect(v2.version).toBe(2);
    expect(v2.changeSummary).toBe('auto-refresh from 2 receipt(s)');
    expect(loadProjectBriefById(home, 'default', v1.id)!.status).toBe('superseded');
    expect(loadActiveBriefForRepo(home, 'default', 'hippo')!.id).toBe(v2.id);
    const db2 = openHippoDb(home);
    try {
      const meta = JSON.parse((db2.prepare(`SELECT metadata_json FROM audit_log WHERE op='project_brief_supersede' AND target_id=?`)
        .get(String(v1.id)) as { metadata_json: string }).metadata_json) as { refreshed: boolean; receipt_count: number };
      expect(meta.refreshed).toBe(true);
      expect(meta.receipt_count).toBe(2);
    } finally { closeHippoDb(db2); }
  });

  it('refresh stays within the summary cap with many long receipts (codex P2 regression)', () => {
    // 50 receipts (the MAX_BRIEF_RECEIPTS scan cap) with long headlines would build
    // an ~11KB digest if rendered naively, exceeding MAX_BRIEF_SUMMARY_LEN (8192) and
    // making saveProjectBrief reject it. Budget-aware assembly must keep it bounded.
    for (let i = 0; i < 50; i++) {
      addReceipt(home, 'default', 'big', `receipt ${i} ` + 'x'.repeat(300));
    }
    const assembled = assembleBriefFromReceipts(home, 'default', 'big');
    expect(assembled.receiptCount).toBe(50);
    expect(assembled.markdown.length).toBeLessThanOrEqual(MAX_BRIEF_SUMMARY_LEN);
    expect(assembled.markdown).toContain('omitted (summary cap)');
    // refresh must SUCCEED (not throw) and store a valid brief under the cap
    const b = refreshBrief(home, 'default', 'big');
    expect(b.version).toBe(1);
    expect(b.summary.length).toBeLessThanOrEqual(MAX_BRIEF_SUMMARY_LEN);
    expect(loadProjectBriefById(home, 'default', b.id)!.summary.length).toBeLessThanOrEqual(MAX_BRIEF_SUMMARY_LEN);
  });

  it('schema v35 produces project_briefs table + 3 triggers + 3 indexes', () => {
    const db = openHippoDb(home);
    try {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='project_briefs'`).get()).toBeDefined();
      const triggers = (db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_project_briefs_%'`)
        .all() as Array<{ name: string }>).map((t) => t.name);
      expect(triggers).toContain('trg_project_briefs_tenant_match_insert');
      expect(triggers).toContain('trg_project_briefs_tenant_match_update');
      expect(triggers).toContain('trg_project_briefs_supersede_tenant_match_update');
      const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_project_briefs_%'`)
        .all() as Array<{ name: string }>).map((i) => i.name);
      expect(indexes).toContain('idx_project_briefs_tenant_status');
      expect(indexes).toContain('idx_project_briefs_memory');
      expect(indexes).toContain('idx_project_briefs_repo');
    } finally { closeHippoDb(db); }
  });
});
