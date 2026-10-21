// Every required store group, and the store's own methods, names conformance test files that exist.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFORMANCE_FILES } from '../_helpers/conformance-registry.js';

const repoRoot = join(import.meta.dirname, '..', '..');

describe('the store conformance suite', () => {
  it('names an existing test file for each required group and for the base methods', () => {
    const listed: readonly (readonly [string, readonly string[]])[] = Object.entries(CONFORMANCE_FILES);
    const missing = listed.flatMap(([group, files]) =>
      files.length === 0
        ? [`${group}: no file`]
        : files.filter((f) => !existsSync(join(repoRoot, f))).map((f) => `${group}: ${f}`),
    );
    expect(missing).toEqual([]);
  });
});
