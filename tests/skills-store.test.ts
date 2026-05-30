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
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, deleteEntry, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import {
  saveSkill,
  closeSkill,
  loadSkillById,
  loadSkills,
  loadActiveSkills,
  exportSkills,
  VALID_SKILL_STATES,
  MAX_SKILL_INSTRUCTIONS_LEN,
} from '../src/skills.js';

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

describe('skills store (E2 executable/exportable first-class object)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot('skills'); });
  afterEach(() => safeRmSync(home));

  it('saveSkill creates memory + skills row + skill_create audit; v1; trigger null when omitted', () => {
    const s = saveSkill(home, 'default', { skillName: 'Run tests', instructions: 'npm test before commit' });
    expect(s.id).toBeGreaterThan(0);
    expect(s.memoryId).not.toBeNull();
    expect(s.skillName).toBe('Run tests');
    expect(s.instructions).toBe('npm test before commit');
    expect(s.trigger).toBeNull();
    expect(s.version).toBe(1);
    expect(s.status).toBe('active');
    const db = openHippoDb(home);
    try {
      const memRow = db.prepare(`SELECT content, source, tags_json FROM memories WHERE id = ?`)
        .get(s.memoryId!) as { content: string; source: string; tags_json: string };
      expect(memRow.content).toContain('Run tests');
      expect(memRow.content).toContain('npm test before commit');
      expect(memRow.source).toBe('skill');
      expect((JSON.parse(memRow.tags_json) as string[])).toContain('skill');
      const rows = db.prepare(`SELECT metadata_json FROM audit_log WHERE op='skill_create' AND target_id=?`)
        .all(String(s.id)) as Array<{ metadata_json: string }>;
      expect(rows.length).toBe(1);
      expect((JSON.parse(rows[0].metadata_json) as { has_trigger: boolean }).has_trigger).toBe(false);
    } finally { closeHippoDb(db); }
  });

  it('saveSkill with trigger; memory content has when + instructions', () => {
    const s = saveSkill(home, 'default', { skillName: 'Lint', instructions: 'run eslint', trigger: 'before push' });
    expect(s.trigger).toBe('before push');
    const db = openHippoDb(home);
    try {
      const memRow = db.prepare(`SELECT content FROM memories WHERE id = ?`).get(s.memoryId!) as { content: string };
      expect(memRow.content).toContain('When: before push');
    } finally { closeHippoDb(db); }
  });

  it('SAVEPOINT atomicity: writeEntry throw rolls back both', () => {
    const m0 = countRows(home, 'memories'); const s0 = countRows(home, 'skills');
    const mem = createMemory('throwing skill', {
      tags: ['skill'], layer: Layer.Semantic, confidence: 'verified', source: 'skill', tenantId: 'default',
    });
    expect(() => writeEntry(home, mem, { afterWrite: () => { throw new Error('forced'); } })).toThrow('forced');
    expect(countRows(home, 'memories')).toBe(m0);
    expect(countRows(home, 'skills')).toBe(s0);
  });

  it('supersede chain + version + change_summary + skill_supersede audit', () => {
    const v1 = saveSkill(home, 'default', { skillName: 'S', instructions: 'old' });
    const v2 = saveSkill(home, 'default', { skillName: 'S', instructions: 'new', changeSummary: 'reworded', supersedesSkillId: v1.id });
    const v3 = saveSkill(home, 'default', { skillName: 'S', instructions: 'newer', supersedesSkillId: v2.id });
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
    expect(v2.changeSummary).toBe('reworded');
    const reV1 = loadSkillById(home, 'default', v1.id)!;
    expect(reV1.status).toBe('superseded');
    expect(reV1.supersededBy).toBe(v2.id);
    expect(loadActiveSkills(home, 'default').map((x) => x.id)).toEqual([v3.id]);
    const db = openHippoDb(home);
    try {
      expect(db.prepare(`SELECT 1 FROM audit_log WHERE op='skill_supersede' AND target_id=?`).all(String(v1.id)).length).toBe(1);
    } finally { closeHippoDb(db); }
  });

  it('supersede CAS (re-supersede not-active; missing not-found); self-supersede preflight', () => {
    const v1 = saveSkill(home, 'default', { skillName: 'O', instructions: 'a' });
    saveSkill(home, 'default', { skillName: 'O', instructions: 'b', supersedesSkillId: v1.id });
    expect(() => saveSkill(home, 'default', { skillName: 'O', instructions: 'c', supersedesSkillId: v1.id })).toThrow(/not active/);
    expect(() => saveSkill(home, 'default', { skillName: 'X', instructions: 'c', supersedesSkillId: 99999 })).toThrow(/not found/);
    const s0 = countRows(home, 'skills');
    expect(() => saveSkill(home, 'default', { skillName: 'Self', instructions: 'a', supersedesSkillId: 1 })).toThrow(/not active|not found/);
    // (id 1 exists as superseded here, so 'not active'; the empty-store case is covered by other E2 store tests.)
    expect(countRows(home, 'skills')).toBe(s0);
  });

  it('close + close guard (not-found; cannot-close-superseded; cannot re-close)', () => {
    expect(() => closeSkill(home, 'default', 77777)).toThrow(/not found/);
    const v1 = saveSkill(home, 'default', { skillName: 'Sup', instructions: 'a' });
    saveSkill(home, 'default', { skillName: 'Sup', instructions: 'b', supersedesSkillId: v1.id });
    expect(() => closeSkill(home, 'default', v1.id)).toThrow(/not active/);
    const c = saveSkill(home, 'default', { skillName: 'Cl', instructions: 'a' });
    closeSkill(home, 'default', c.id);
    expect(() => closeSkill(home, 'default', c.id)).toThrow(/not active/);
  });

  it('cross-tenant INSERT trigger + supersede tenant-match trigger raise ABORT', () => {
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
    const a = saveSkill(home, 'tenant-a', { skillName: 'A', instructions: 'a' });
    const b = saveSkill(home, 'tenant-b', { skillName: 'B', instructions: 'b' });
    const db2 = openHippoDb(home);
    try {
      expect(() => db2.prepare(`UPDATE skills SET superseded_by=? WHERE id=?`).run(b.id, a.id))
        .toThrow(/superseded_by must reference a skill in the same tenant/);
    } finally { closeHippoDb(db2); }
  });

  it('ON DELETE SET NULL: forgetting the memory orphans the skill; old versions loadable', () => {
    const v1 = saveSkill(home, 'default', { skillName: 'D', instructions: 'a' });
    const v2 = saveSkill(home, 'default', { skillName: 'D', instructions: 'b', supersedesSkillId: v1.id });
    deleteEntry(home, v1.memoryId!, 'default');
    deleteEntry(home, v2.memoryId!, 'default');
    expect(loadSkillById(home, 'default', v1.id)!.memoryId).toBeNull();
    expect(loadSkillById(home, 'default', v1.id)!.status).toBe('superseded');
    expect(loadSkillById(home, 'default', v2.id)!.status).toBe('active');
  });

  it('status filters; loadActiveSkills; invalid status', () => {
    const a = saveSkill(home, 'default', { skillName: 'a', instructions: 'x' });
    const b = saveSkill(home, 'default', { skillName: 'b', instructions: 'x' });
    const c = saveSkill(home, 'default', { skillName: 'c', instructions: 'x' });
    saveSkill(home, 'default', { skillName: 'b', instructions: 'x2', supersedesSkillId: b.id });
    closeSkill(home, 'default', c.id);
    const active = loadActiveSkills(home, 'default');
    expect(active.some((x) => x.id === a.id)).toBe(true);
    expect(active.some((x) => x.id === b.id)).toBe(false);
    expect(loadSkills(home, 'default', { status: 'closed' }).map((x) => x.id)).toEqual([c.id]);
    expect(loadSkills(home, 'default').length).toBe(4);
    // @ts-expect-error runtime validation
    expect(() => loadSkills(home, 'default', { status: 'retired' })).toThrow(/status must be one of/);
    expect(VALID_SKILL_STATES.has('active')).toBe(true);
  });

  it('validation: missing name/instructions; single-line name; caps', () => {
    expect(() => saveSkill(home, 'default', { skillName: '   ', instructions: 'x' })).toThrow(/skillName is required/);
    expect(() => saveSkill(home, 'default', { skillName: 'n', instructions: '  ' })).toThrow(/instructions are required/);
    expect(() => saveSkill(home, 'default', { skillName: 'bad\nname', instructions: 'x' })).toThrow(/single line/);
    expect(() => saveSkill(home, 'default', { skillName: 'n', instructions: 'x', trigger: 'multi\n## line' })).toThrow(/trigger must be a single line/);
    expect(() => saveSkill(home, 'default', { skillName: 'big', instructions: 'y'.repeat(MAX_SKILL_INSTRUCTIONS_LEN + 1) })).toThrow(/instructions exceed/);
  });

  it('exportSkills: active-only, name-ASC, trigger omitted when null, markdown verbatim, empty -> ""', () => {
    expect(exportSkills(home, 'default')).toBe('');
    saveSkill(home, 'default', { skillName: 'Bravo', instructions: 'do bravo' });
    saveSkill(home, 'default', { skillName: 'Alpha', instructions: 'do alpha', trigger: 'on start' });
    // a closed + a superseded skill must NOT appear in the export
    const closed = saveSkill(home, 'default', { skillName: 'Zulu', instructions: 'old' });
    closeSkill(home, 'default', closed.id);
    const sup = saveSkill(home, 'default', { skillName: 'Yankee', instructions: 'v1' });
    saveSkill(home, 'default', { skillName: 'Yankee', instructions: 'v2', supersedesSkillId: sup.id });
    // instructions containing its own markdown heading must render verbatim
    saveSkill(home, 'default', { skillName: 'Charlie', instructions: 'step 1\n## sub-heading\nstep 2' });

    const md = exportSkills(home, 'default');
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
      const triggers = (db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_skills_%'`)
        .all() as Array<{ name: string }>).map((t) => t.name);
      expect(triggers).toContain('trg_skills_tenant_match_insert');
      expect(triggers).toContain('trg_skills_tenant_match_update');
      expect(triggers).toContain('trg_skills_supersede_tenant_match_update');
      const indexes = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_skills_%'`)
        .all() as Array<{ name: string }>).map((i) => i.name);
      expect(indexes).toContain('idx_skills_tenant_status');
      expect(indexes).toContain('idx_skills_memory');
    } finally { closeHippoDb(db); }
  });
});
