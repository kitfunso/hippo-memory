// A once-only log key may name a table, column, errno, site or config value, never a row: the key set is capped, and a
// key per row would push every later failure class down to debug.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
// Each `${...}` a key may hold: a value the code or the config fixes.
const FIXED_PARTS = new Set(['table', 'column', 'problem', 'code', 'file', 'model', 'reason', 'thrown', 'args[0]']);
const KEYED_CALL = /\b(?:once|warnThenDebug|warnThenSample)\(\s*`([^`]*)`/g;

function keyTemplates(): { file: string; parts: string[] }[] {
  const found: { file: string; parts: string[] }[] = [];
  for (const entry of readdirSync(SRC, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const file = join(entry.parentPath, entry.name);
    for (const [, template] of readFileSync(file, 'utf8').matchAll(KEYED_CALL)) {
      found.push({ file, parts: [...(template ?? '').matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1] ?? '') });
    }
  }
  return found;
}

describe('once-only log keys', () => {
  it('hold only values the code fixes, never a row id', () => {
    const templates = keyTemplates();
    // A scan that finds nothing would pass for the wrong reason.
    expect(templates.filter((t) => t.parts.length > 0).length).toBeGreaterThanOrEqual(4);
    const loose = templates.flatMap((t) =>
      t.parts.filter((p) => !FIXED_PARTS.has(p)).map((p) => `${t.file}: \${${p}}`),
    );
    expect(loose).toEqual([]);
  });
});
