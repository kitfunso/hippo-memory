/**
 * E2 skill first-class object (executable/exportable) - store-layer tests.
 * Docs: docs/plans/2026-05-30-e2-skill-object.md
 *
 * Covers what only skills have; the shared lifecycle rules run per kind in typed-object-store.test.ts.
 * 1. saveSkill creates memory + skills row (+ skill_create audit), v1, trigger null when omitted
 * 2. saveSkill with trigger; memory content has name + when + instructions
 * 3. status filters
 * 4. validation: missing name/instructions; name single-line (newline rejected); caps
 * 5. EXPORT: active-only, name-ASC, trigger omitted when null, '##' in instructions verbatim, empty -> ''
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { saveSkill, closeSkill, loadSkills, skillsMarkdown } from '../../src/domain/objects/skills.js';
import { makeRoot } from '../_helpers/make-root.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { loadConfig } from '../../src/base/config/config.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

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
  beforeEach(() => {
    home = makeRoot('skills');
  });
  afterEach(() => removeAfterRequest(home));

  it('saveSkill creates memory + skills row + skill_create audit; v1; trigger null when omitted', async () => {
    const s = await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      skillName: 'Run tests',
      instructions: 'npm test before commit',
    });
    expect(s.id).toBe(1); // the first row in a fresh AUTOINCREMENT table
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
    } finally {
      closeHippoDb(db);
    }
  });

  it('saveSkill with trigger; memory content has when + instructions', async () => {
    const s = await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      skillName: 'Lint',
      instructions: 'run eslint',
      trigger: 'before push',
    });
    expect(s.trigger).toBe('before push');
    const db = openHippoDb(home);
    try {
      const memRow = getRow<{ content: string }>(db, `SELECT content FROM memories WHERE id = ?`, s.memoryId!);
      expect(memRow.content).toContain('When: before push');
    } finally {
      closeHippoDb(db);
    }
  });

  it('status filters; status active', async () => {
    const a = await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      skillName: 'a',
      instructions: 'x',
    });
    const b = await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      skillName: 'b',
      instructions: 'x',
    });
    const c = await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      skillName: 'c',
      instructions: 'x',
    });
    await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      skillName: 'b',
      instructions: 'x2',
      supersedesSkillId: b.id,
    });
    await closeSkill(objectsAt(home), 'default', c.id);
    const active = await loadSkills(objectsAt(home), 'default', { status: 'active' });
    expect(active.some((x) => x.id === a.id)).toBe(true);
    expect(active.some((x) => x.id === b.id)).toBe(false);
    expect((await loadSkills(objectsAt(home), 'default', { status: 'closed' })).map((x) => x.id)).toEqual([c.id]);
    expect((await loadSkills(objectsAt(home), 'default')).length).toBe(4);
  });

  it('validation: missing name/instructions; single-line name; caps', async () => {
    await expect(
      saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        skillName: '   ',
        instructions: 'x',
      }),
    ).rejects.toThrow(/skillName is required/);
    await expect(
      saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        skillName: 'n',
        instructions: '  ',
      }),
    ).rejects.toThrow(/instructions are required/);
    await expect(
      saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        skillName: 'bad\nname',
        instructions: 'x',
      }),
    ).rejects.toThrow(/single line/);
    await expect(
      saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        skillName: 'n',
        instructions: 'x',
        trigger: 'multi\n## line',
      }),
    ).rejects.toThrow(/trigger must be a single line/);
    await expect(
      saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
        skillName: 'big',
        instructions: 'y'.repeat(8192 + 1),
      }),
    ).rejects.toThrow(/instructions exceed/);
  });

  it('exportSkills: active-only, name-ASC, trigger omitted when null, markdown verbatim, empty -> ""', async () => {
    expect(await skillsMarkdown(objectsAt(home), 'default')).toBe('');
    await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      skillName: 'Bravo',
      instructions: 'do bravo',
    });
    await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      skillName: 'Alpha',
      instructions: 'do alpha',
      trigger: 'on start',
    });
    // a closed + a superseded skill must NOT appear in the export
    const closed = await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      skillName: 'Zulu',
      instructions: 'old',
    });
    await closeSkill(objectsAt(home), 'default', closed.id);
    const sup = await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      skillName: 'Yankee',
      instructions: 'v1',
    });
    await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      skillName: 'Yankee',
      instructions: 'v2',
      supersedesSkillId: sup.id,
    });
    // instructions containing its own markdown heading must render verbatim
    await saveSkill(objectsAt(home), loadConfig(home).defaultHalfLifeDays, 'default', {
      skillName: 'Charlie',
      instructions: 'step 1\n## sub-heading\nstep 2',
    });

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
});
