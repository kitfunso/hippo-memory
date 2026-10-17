// scripts/check-migration-line.mjs keeps a publish from shipping a MIGRATIONS list with a missing version.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeGap, findMigrationGaps, readMigrationVersions } from '../../scripts/check-migration-line.mjs';

describe('findMigrationGaps', () => {
  it('passes a consecutive list and an empty one', () => {
    expect(findMigrationGaps([54, 55, 56, 57])).toEqual([]);
    expect(findMigrationGaps([])).toEqual([]);
  });

  it('names the versions missing between 56 and 60', () => {
    const gaps = findMigrationGaps([55, 56, 60]);
    expect(gaps).toEqual([{ after: 56, next: 60 }]);
    expect(describeGap(gaps[0])).toBe('v56 is followed by v60, so v57 to v59 are missing.');
  });

  it('names a single missing version, a repeat and a list out of order', () => {
    expect(describeGap(findMigrationGaps([8, 10])[0])).toBe('v8 is followed by v10, so v9 is missing.');
    expect(describeGap(findMigrationGaps([4, 4])[0])).toBe('v4 follows v4, out of order or repeated.');
    expect(findMigrationGaps([5, 4])).toEqual([{ after: 5, next: 4 }]);
  });
});

describe('readMigrationVersions', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'migration-line-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the version each listed file declares, not the name it is imported under', () => {
    writeFileSync(join(dir, 'index.ts'), `import { v01 } from './v01.js';\nexport const MIGRATIONS: Migration[] = [\n  v01,\n  v02,\n  v60,\n];\n`);
    for (const [name, version] of [['v01', 1], ['v02', 2], ['v60', 59]] as const) {
      writeFileSync(join(dir, `${name}.ts`), `export const ${name}: Migration = {\n    version: ${version},\n    up: () => {},\n};\n`);
    }
    expect(readMigrationVersions(dir)).toEqual([1, 2, 59]);
  });

  it('fails loudly on an index with no MIGRATIONS array or a file with no version', () => {
    writeFileSync(join(dir, 'index.ts'), 'export const OTHER = [];\n');
    expect(() => readMigrationVersions(dir)).toThrow(/no MIGRATIONS array/);
    writeFileSync(join(dir, 'index.ts'), 'export const MIGRATIONS: Migration[] = [\n  v01,\n];\n');
    writeFileSync(join(dir, 'v01.ts'), 'export const v01 = {};\n');
    expect(() => readMigrationVersions(dir)).toThrow(/declares no version/);
  });
});
