/**
 * E2 skill first-class object (executable/exportable) - store-layer tests.
 * Docs: docs/plans/2026-05-30-e2-skill-object.md
 *
 * Covers:
 * 1. saveSkill creates memory + skills row (+ skill_create audit), v1, trigger null when omitted
 * 2. saveSkill with trigger; memory content has name + when + instructions
 * 3. SAVEPOINT atomicity
 * 4. supersede chain + version + change_summary + skill_supersede audit
 * 5. supersede CAS (re-supersede not-active; missing not-found); self-supersede preflight
 * 6. close + close guard (not-found; cannot-close-superseded)
 * 7. cross-tenant INSERT trigger + supersede tenant-match trigger
 * 8. ON DELETE SET NULL + old version loadable
 * 9. status filters; loadActiveSkills; invalid status
 * 10. validation: missing name/instructions; name single-line (newline rejected); caps
 * 11. EXPORT: active-only, name-ASC, trigger omitted when null, '##' in instructions verbatim, empty -> ''
 * 12. schema v34 table + 3 triggers + 2 indexes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { writeEntryThenFail } from './_helpers/failing-write.js';
import { deleteEntry } from '../src/store/delete-and-batch.js';
import { Layer } from '../src/core/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db/index.js';
import {
  saveSkill,
  closeSkill,
  loadSkillById,
  loadSkills,
  loadActiveSkills,
  skillsMarkdown,
  VALID_SKILL_STATES,
  MAX_SKILL_INSTRUCTIONS_LEN,
} from '../src/objects/skills.js';
import { makeRoot } from './_helpers/make-root.js';
import { objectsAt } from './_helpers/objects-at.js';

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function countRows(home: string, table: string): number {
  const db = openHippoDb(home);
  try { return getRow<{ c: number }>(db, `SELECT COUNT(*) as c FROM ${table}`).c; }
  finally { closeHippoDb(db); }
}

function getRow<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T {
  // SAFETY: every call site below passes a SELECT whose column list is
  // exactly the fields named in the requested type parameter, so the DB
  // driver's `unknown` return is a faithful match for T.
  return db.prepare(sql).get(...params) as T;
}
function getRows<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T[] {
  // SAFETY: every call site below passes a SELECT whose column list is
  // exactly the fields named in the requested type parameter, so the DB
  // driver's `unknown[]` return is a faithful match for T[].
  return db.prepare(sql).all(...params) as T[];
}
function parseJson<T>(text: string): T {
  // SAFETY: callers only parse JSON this test itself wrote (via saveSkill's
  // own JSON.stringify of tags_json/metadata_json), so the parsed shape
  // matches the requested type parameter.
  return JSON.parse(text) as T;
}

describe('skills store (executable/exportable first-class object)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('skills'); });
  afterEach(() => safeRmSync(home));

  it('saveSkill creates memory + skills row + skill_create audit; v1; trigger null when omitted', async () => {
    const s = await saveSkill(objectsAt(home), home, 'default', { skillName: 'Run tests', instructions: 'npm test before commit' });
    expect(s.id).toBeGreaterThan(0);
    expect(s.memoryId).not.toBeNull();
    expect(s.skillName).toBe('Run tests');
    expect(s.instructions).toBe('npm test before commit');
    expect(s.trigger).toBeNull();
    expect(s.version).toBe(1);
    expect(s.status).toBe('active');
    const db = openHippoDb(home);
    try {
      const memRow = getRow<{ content: string; source: string; tags_json: string }>(
        db,
        `SELECT content, source, tags_json FROM memories WHERE id = ?`,
        s.memoryId!,
      );
      expect(memRow.content).toContain('Run tests');
      expect(memRow.content).toContain('npm test before commit');
      expect(memRow.source).toBe('skill');
      expect(parseJson<string[]>(memRow.tags_json)).toContain('skill');
      const rows = getRows<{ metadata_json: string }>(
        db,
        `SELECT metadata_json FROM audit_log WHERE op='skill_create' AND target_id=?`,
        String(s.id),
      );
      expect(rows.length).toBe(1);
      expect(parseJson<{ has_trigger: boolean }>(rows[0]!.metadata_json).has_trigger).toBe(false);
    } finally { closeHippoDb(db); }
  });

  it('saveSkill with trigger; memory content has when + instructions', async () => {
    const s = await saveSkill(objectsAt(home), home, 'default', { skillName: 'Lint', instructions: 'run eslint', trigger: 'before push' });
    expect(s.trigger).toBe('before push');
    const db = openHippoDb(home);
    try {
      const memRow = getRow<{ content: string }>(db, `SELECT content FROM memories WHERE id = ?`, s.memoryId!);
      expect(memRow.content).toContain('When: before push');
    } finally { closeHippoDb(db); }
  });

  it('SAVEPOINT atomicity: writeEntry throw rolls back both', () => {
    const m0 = countRows(home, 'memories'); const s0 = countRows(home, 'skills');
    const mem = createMemory('throwing skill', {
      tags: ['skill'], layer: Layer.Semantic, confidence: 'verified', source: 'skill', tenantId: 'default',
    });
    expect(() => writeEntryThenFail(home, mem)).toThrow('forced');
    expect(countRows(home, 'memories')).toBe(m0);
    expect(countRows(home, 'skills')).toBe(s0);
  });

  it('supersede chain + version + change_summary + skill_supersede audit', async () => {
    const v1 = await saveSkill(objectsAt(home), home, 'default', { skillName: 'S', instructions: 'old' });
    const v2 = await saveSkill(objectsAt(home), home, 'default', { skillName: 'S', instructions: 'new', changeSummary: 'reworded', supersedesSkillId: v1.id });
    const v3 = await saveSkill(objectsAt(home), home, 'default', { skillName: 'S', instructions: 'newer', supersedesSkillId: v2.id });
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(v2.changeSummary).toBe('reworded');
    const reV1 = (await loadSkillById(objectsAt(home), 'default', v1.id))!;
    expect(reV1.status).toBe('superseded');
    expect(reV1.supersededBy).toBe(v2.id);
    expect((await loadActiveSkills(objectsAt(home), 'default')).map((x) => x.id)).toEqual([v3.id]);
    const db = openHippoDb(home);
    try {
      expect(db.prepare(`SELECT 1 FROM audit_log WHERE op='skill_supersede' AND target_id=?`).all(String(v1.id)).length).toBe(1);
    } finally { closeHippoDb(db); }
  });

  it('supersede CAS (re-supersede not-active; missing not-found); self-supersede preflight', async () => {
    const v1 = await saveSkill(objectsAt(home), home, 'default', { skillName: 'O', instructions: 'a' });
    await saveSkill(objectsAt(home), home, 'default', { skillName: 'O', instructions: 'b', supersedesSkillId: v1.id });
    await expect(saveSkill(objectsAt(home), home, 'default', { skillName: 'O', instructions: 'c', supersedesSkillId: v1.id })).rejects.toThrow(/not active/);
    await expect(saveSkill(objectsAt(home), home, 'default', { skillName: 'X', instructions: 'c', supersedesSkillId: 99999 })).rejects.toThrow(/not found/);
    const s0 = countRows(home, 'skills');
    await expect(saveSkill(objectsAt(home), home, 'default', { skillName: 'Self', instructions: 'a', supersedesSkillId: 1 })).rejects.toThrow(/not active|not found/);
    // (id 1 exists as superseded here, so 'not active'; the empty-store case is covered by other E2 store tests.)
    expect(countRows(home, 'skills')).toBe(s0);
  });

  it('close + close guard (not-found; cannot-close-superseded; cannot re-close)', async () => {
    await expect(closeSkill(objectsAt(home), 'default', 77777)).rejects.toThrow(/not found/);
    const v1 = await saveSkill(objectsAt(home), home, 'default', { skillName: 'Sup', instructions: 'a' });
    await saveSkill(objectsAt(home), home, 'default', { skillName: 'Sup', instructions: 'b', supersedesSkillId: v1.id });
    await expect(closeSkill(objectsAt(home), 'default', v1.id)).rejects.toThrow(/not active/);
    const c = await saveSkill(objectsAt(home), home, 'default', { skillName: 'Cl', instructions: 'a' });
    await closeSkill(objectsAt(home), 'default', c.id);
    await expect(closeSkill(objectsAt(home), 'default', c.id)).rejects.toThrow(/not active/);
  });

  it('cross-tenant INSERT trigger + supersede tenant-match trigger raise ABORT', async () => {
    const mem = createMemory('tenant-a', {
      tags: ['skill'], layer: Layer.Semantic, confidence: 'verified', source: 'skill', tenantId: 'tenant-a',
    });
    writeEntry(home, mem);
    const db = openHippoDb(home);
    try {
      expect(() => {
        db.prepare(`INSERT INTO skills(memory_id, tenant_id, skill_name, instructions, version, status, created_at)
          VALUES (?, 'tenant-b', 'x', 'y', 1, 'active', ?)`).run(mem.id, new Date().toISOString());
      }).toThrow(/tenant_id must match memories\.tenant_id/);
    } finally { closeHippoDb(db); }
    const a = await saveSkill(objectsAt(home), home, 'tenant-a', { skillName: 'A', instructions: 'a' });
    const b = await saveSkill(objectsAt(home), home, 'tenant-b', { skillName: 'B', instructions: 'b' });
    const db2 = openHippoDb(home);
    try {
      expect(() => db2.prepare(`UPDATE skills SET superseded_by=? WHERE id=?`).run(b.id, a.id))
        .toThrow(/superseded_by must reference a skill in the same tenant/);
    } finally { closeHippoDb(db2); }
  });

  it('ON DELETE SET NULL: forgetting the memory orphans the skill; old versions loadable', async () => {
    const v1 = await saveSkill(objectsAt(home), home, 'default', { skillName: 'D', instructions: 'a' });
    const v2 = await saveSkill(objectsAt(home), home, 'default', { skillName: 'D', instructions: 'b', supersedesSkillId: v1.id });
    deleteEntry(home, v1.memoryId!);
    deleteEntry(home, v2.memoryId!);
    expect((await loadSkillById(objectsAt(home), 'default', v1.id))!.memoryId).toBeNull();
    expect((await loadSkillById(objectsAt(home), 'default', v1.id))!.status).toBe('superseded');
    expect((await loadSkillById(objectsAt(home), 'default', v2.id))!.status).toBe('active');
  });

  it('status filters; loadActiveSkills; invalid status', async () => {
    const a = await saveSkill(objectsAt(home), home, 'default', { skillName: 'a', instructions: 'x' });
    const b = await saveSkill(objectsAt(home), home, 'default', { skillName: 'b', instructions: 'x' });
    const c = await saveSkill(objectsAt(home), home, 'default', { skillName: 'c', instructions: 'x' });
    await saveSkill(objectsAt(home), home, 'default', { skillName: 'b', instructions: 'x2', supersedesSkillId: b.id });
    await closeSkill(objectsAt(home), 'default', c.id);
    const active = await loadActiveSkills(objectsAt(home), 'default');
    expect(active.some((x) => x.id === a.id)).toBe(true);
    expect(active.some((x) => x.id === b.id)).toBe(false);
    expect((await loadSkills(objectsAt(home), 'default', { status: 'closed' })).map((x) => x.id)).toEqual([c.id]);
    expect((await loadSkills(objectsAt(home), 'default')).length).toBe(4);
    // @ts-expect-error runtime validation
    await expect(loadSkills(objectsAt(home), 'default', { status: 'retired' })).rejects.toThrow(/status must be one of/);
    expect(VALID_SKILL_STATES.has('active')).toBe(true);
  });

  it('validation: missing name/instructions; single-line name; caps', async () => {
    await expect(saveSkill(objectsAt(home), home, 'default', { skillName: '   ', instructions: 'x' })).rejects.toThrow(/skillName is required/);
    await expect(saveSkill(objectsAt(home), home, 'default', { skillName: 'n', instructions: '  ' })).rejects.toThrow(/instructions are required/);
    await expect(saveSkill(objectsAt(home), home, 'default', { skillName: 'bad\nname', instructions: 'x' })).rejects.toThrow(/single line/);
    await expect(saveSkill(objectsAt(home), home, 'default', { skillName: 'n', instructions: 'x', trigger: 'multi\n## line' })).rejects.toThrow(/trigger must be a single line/);
    await expect(saveSkill(objectsAt(home), home, 'default', { skillName: 'big', instructions: 'y'.repeat(MAX_SKILL_INSTRUCTIONS_LEN + 1) })).rejects.toThrow(/instructions exceed/);
  });

  it('exportSkills: active-only, name-ASC, trigger omitted when null, markdown verbatim, empty -> ""', async () => {
    expect(await skillsMarkdown(objectsAt(home), 'default')).toBe('');
    await saveSkill(objectsAt(home), home, 'default', { skillName: 'Bravo', instructions: 'do bravo' });
    await saveSkill(objectsAt(home), home, 'default', { skillName: 'Alpha', instructions: 'do alpha', trigger: 'on start' });
    // a closed + a superseded skill must NOT appear in the export
    const closed = await saveSkill(objectsAt(home), home, 'default', { skillName: 'Zulu', instructions: 'old' });
    await closeSkill(objectsAt(home), 'default', closed.id);
    const sup = await saveSkill(objectsAt(home), home, 'default', { skillName: 'Yankee', instructions: 'v1' });
    await saveSkill(objectsAt(home), home, 'default', { skillName: 'Yankee', instructions: 'v2', supersedesSkillId: sup.id });
    // instructions containing its own markdown heading must render verbatim
    await saveSkill(objectsAt(home), home, 'default', { skillName: 'Charlie', instructions: 'step 1\n## sub-heading\nstep 2' });

    const md = await skillsMarkdown(objectsAt(home), 'default');
    // name-ASC order (by relative position of each skill's own H2 header). NOTE:
    // we cannot just count all '## ' lines because instructions render VERBATIM,
    // so Charlie's body contains its own '## sub-heading' (the documented v1
    // stance: skill_name is single-line, instructions are operator content).
    expect(md.indexOf('## Alpha')).toBeGreaterThanOrEqual(0);
    expect(md.indexOf('## Alpha')).toBeLessThan(md.indexOf('## Bravo'));
    expect(md.indexOf('## Bravo')).toBeLessThan(md.indexOf('## Charlie'));
    expect(md.indexOf('## Charlie')).toBeLessThan(md.indexOf('## Yankee'));
    expect(md).not.toContain('Zulu');
    // Alpha has a When line; Bravo does not
    expect(md).toContain('## Alpha\n\n**When:** on start\n\ndo alpha');
    expect(md).toContain('## Bravo\n\ndo bravo');
    expect(md).not.toContain('## Bravo\n\n**When:**');
    // Charlie's instructions (incl their own '##') render verbatim
    expect(md).toContain('step 1\n## sub-heading\nstep 2');
    // Yankee shows the active v2
    expect(md).toContain('## Yankee\n\nv2');
    expect(md).not.toContain('v1');
  });

  it('schema v34 produces skills table + 3 triggers + 2 indexes', () => {
    const db = openHippoDb(home);
    try {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='skills'`).get()).toBeDefined();
      const triggers = getRows<{ name: string }>(
        db,
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_skills_%'`,
      ).map((t) => t.name);
      expect(triggers).toContain('trg_skills_tenant_match_insert');
      expect(triggers).toContain('trg_skills_tenant_match_update');
      expect(triggers).toContain('trg_skills_supersede_tenant_match_update');
      const indexes = getRows<{ name: string }>(
        db,
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_skills_%'`,
      ).map((i) => i.name);
      expect(indexes).toContain('idx_skills_tenant_status');
      expect(indexes).toContain('idx_skills_memory');
    } finally { closeHippoDb(db); }
  });
});
