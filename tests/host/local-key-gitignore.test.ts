import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { issueLocalKey } from '../../src/surface/server/local-key.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-keyissue-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('issuing a key lists server.key in the folder .gitignore, once across restarts', () => {
  issueLocalKey(root);
  issueLocalKey(root);
  expect(existsSync(join(root, 'server.key'))).toBe(true);
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('server.key\n');
});
