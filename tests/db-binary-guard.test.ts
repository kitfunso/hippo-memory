import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openHippoDb } from '../src/db.js';

// A 1.23.0 binary still carries v39, which raises the minimum to 1.24.0 mid-run: the stand-in for a newer process migrating first.
vi.mock('../src/version.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/version.js')>()),
  PACKAGE_VERSION: '1.23.0',
}));

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-binguard-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('min_compatible_binary guard under the migration lock', () => {
  it('stops migrating once the store demands a newer binary', () => {
    expect(() => openHippoDb(root)).toThrow(/requires hippo-memory >= 1\.24\.0/);
  });
});
