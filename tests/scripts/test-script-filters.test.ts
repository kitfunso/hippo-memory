// A "test:*" npm script whose path filter matches no file runs zero tests and still exits green.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return testFiles(full);
    return /\.test\.(ts|mjs)$/.test(e.name) ? [relative(ROOT, full).replaceAll(sep, '/')] : [];
  });
}

/** The bare words after `vitest run` that are paths, not flags or flag values. */
function filters(command: string): string[] {
  const all = command.split(/\s+/);
  const words = all.slice(all.indexOf('run') + 1);
  return words.filter((w, i) => !w.startsWith('-') && !words[i - 1]?.startsWith('--'));
}

describe('package.json test:* scripts', () => {
  // SAFETY: package.json is this repo's own file and always has a scripts table of strings.
  const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> })
    .scripts;
  const all = testFiles(join(ROOT, 'tests'));
  const withFilters = Object.entries(scripts).filter(
    ([name, cmd]) => name.startsWith('test:') && /vitest run/.test(cmd) && filters(cmd).length > 0,
  );

  it('finds the scripts it should check', () => {
    expect(withFilters.map(([name]) => name)).toContain('test:delivery-ledger');
  });

  it.each(withFilters)('%s: every path filter matches a test file', (_name, cmd) => {
    for (const filter of filters(cmd)) {
      expect(all.filter((f) => f.includes(filter)).length, `${filter} matches no test file`).toBeGreaterThan(0);
    }
  });
});
