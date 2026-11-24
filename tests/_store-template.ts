import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { getHippoDbPath } from '../src/db/open.js';
import { initStore } from '../src/store/sqlite/runtime/handles.js';

export function setup(project: TestProject): void {
  const root = mkdtempSync(join(process.env.HIPPO_TEST_TMP_RUN ?? tmpdir(), 'store-template-'));
  initStore(root);
  project.provide('storeTemplate', getHippoDbPath(root));
}
