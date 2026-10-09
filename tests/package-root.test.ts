import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { PACKAGE_ROOT } from '../src/core/package-root.js';

// PACKAGE_ROOT must name the folder that holds package.json, bin/ and dist-ui/.
describe('PACKAGE_ROOT', () => {
  it('holds the hippo-memory package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('hippo-memory');
  });

  it('holds bin/hippo.js', () => {
    expect(fs.existsSync(path.join(PACKAGE_ROOT, 'bin', 'hippo.js'))).toBe(true);
  });
});
