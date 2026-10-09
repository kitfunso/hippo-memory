// Z0 readers of what the runner recorded: screen verdicts over void sessions, leak scans through directory links, injected bullets with blank lines.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { contextBlockLines } from '../src/context-render.js';
import { injectedRows } from '../scripts/token-eval/surfaces.mjs';
import { storedAt, shownAtStart } from '../scripts/token-eval/leaks.mjs';
import { surfaceText } from '../scripts/token-eval/grading.mjs';
import { screenVerdicts } from '../scripts/token-eval/screen.mjs';

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
});

describe('screen verdicts', () => {
  const spec = {
    families: [{ id: 'f1', sequence: 's1', screen: { id: 'scr' }, lessons: [{ id: 'f1-l1' }] }],
    sequences: [{ id: 's1', tasks: [{ id: 't1', kind: 'teach', lessonId: 'f1-l1' }] }],
  };
  interface Marks { void?: string }
  const rec = (arm: string, seed: number, taskId: string, first: string, extra: Marks = {}) => ({ familyId: 'f1', arm, seed, taskId, invalid: null, void: null, lessons: [{ first }], ...extra });
  const records = (a0Extra: Marks) => [
    rec('A0', 1, 't1', 'fail', a0Extra), rec('A0', 1, 'scr', 'fail'), rec('A0', 2, 't1', 'pass'), rec('A0', 2, 'scr', 'pass'),
    rec('A4', 1, 'scr', 'pass'), rec('A4', 2, 'scr', 'pass'),
  ];

  it('keeps a family on clean sessions, and leaves it undecided when a session it counted is void', () => {
    expect(screenVerdicts(records({}), spec).kept).toEqual(['f1']);
    const v = screenVerdicts(records({ void: 'read' }), spec);
    expect(v.kept).toEqual([]);
    expect(v.undecided.map((r: { reason: string }) => r.reason)).toEqual(['t1 A0 seed1: void read']);
  });
});

describe('leak scan through a directory link', () => {
  it('searches the files under a linked rules dir instead of throwing EISDIR', (t) => {
    const root = tmp('z0-leak-root-');
    const target = tmp('z0-leak-target-');
    writeFileSync(join(target, 'r.md'), 'remember zq-linked before you start\n');
    mkdirSync(join(root, 'claude-config'));
    try {
      symlinkSync(target, join(root, 'claude-config', 'rules'), 'junction');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'EPERM') t.skip();
      throw err;
    }
    const surfaces = { userInstructions: [{ path: 'claude-config/rules', sha256: 'x', size: 0, link: true }] };
    const at = { root, surfaces, stores: [] };
    expect(storedAt({ id: 'l1', keyPhrase: 'zq-linked' }, at)).toBe(true);
    expect(storedAt({ id: 'l2', keyPhrase: 'zq-absent' }, at)).toBe(false);
  });

  /** claude-config/rules linked to a dir; `inner(target)` adds more under it and returns false when this box refuses the link. */
  const linkedRules = (kind: 'junction' | 'file', inner: (target: string) => void) => {
    const root = tmp('z0-leak-root-');
    const target = tmp('z0-leak-target-');
    mkdirSync(join(root, 'claude-config'));
    try {
      symlinkSync(target, join(root, 'claude-config', 'rules'), 'junction');
      inner(target);
    } catch (err) {
      // Windows without developer mode refuses file symlinks; junctions always work.
      if (kind === 'file' && err instanceof Error && 'code' in err && err.code === 'EPERM') return null;
      throw err;
    }
    return { root, surfaces: { userInstructions: [{ path: 'claude-config/rules', sha256: 'x', size: 0, link: true }] }, stores: [] };
  };

  it('follows a dir link nested inside the linked dir, and reads each file once when a link loops back up', () => {
    const nested = tmp('z0-leak-nested-');
    writeFileSync(join(nested, 'r.md'), 'remember zq-nested before you start\n');
    const at = linkedRules('junction', (target) => {
      symlinkSync(nested, join(target, 'inner'), 'junction');
      symlinkSync(target, join(nested, 'loop'), 'junction');
    })!;
    expect(storedAt({ id: 'l1', keyPhrase: 'zq-nested' }, at)).toBe(true);
    expect(shownAtStart({ id: 'l1', keyPhrase: 'zq-nested' }, at)).toBe(true);
    expect(surfaceText(at).match(/zq-nested/g)).toHaveLength(1);
  });

  it('follows a file link inside the linked dir', (t) => {
    const elsewhere = tmp('z0-leak-file-');
    writeFileSync(join(elsewhere, 'r.md'), 'remember zq-filelink before you start\n');
    const at = linkedRules('file', (target) => symlinkSync(join(elsewhere, 'r.md'), join(target, 'r.md'), 'file'));
    if (!at) return t.skip();
    expect(storedAt({ id: 'l1', keyPhrase: 'zq-filelink' }, at)).toBe(true);
    expect(shownAtStart({ id: 'l1', keyPhrase: 'zq-filelink' }, at)).toBe(true);
  });
});

describe('injected bullets', () => {
  it('counts a memory whose content holds a blank line, and leaves the next section out of it', () => {
    const imported = createMemory('first paragraph of the note\n\nsecond paragraph of the note', { source: 'agent-memory:claude-code:p/n.md#ab12', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    const bullet = contextBlockLines([{ entry: imported, isGlobal: false }], 0, 'observe').slice(1).join('\n');
    const text = ['## Project Memory (1 entries, 20 tokens)\n', bullet, '', '## Prompt-Relevant Memory (0 entries, 5 tokens)\n'].join('\n');
    const got = injectedRows([text], [{ ...imported, global: false }]);
    expect(got.counts).toMatchObject({ rows: 1, importedRows: 1, unmatched: 0, chars: bullet.length });
  });
});
