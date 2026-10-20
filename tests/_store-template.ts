// vitest globalSetup: migrates one store per run for tests/_helpers/store-template.ts to copy, since each of the
// migrations is its own write transaction and a fresh migration per test store was most of the suite's disk writes.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { getHippoDbPath } from '../src/db/open.js';
import { initStore } from '../src/store/sqlite/handles.js';

export function setup(project: TestProject): void {
  // In the run's temp folder, which the store guard's teardown removes.
  const root = mkdtempSync(join(process.env.HIPPO_TEST_TMP_RUN ?? tmpdir(), 'store-template-'));
  initStore(root);
  project.provide('storeTemplate', getHippoDbPath(root));
}
