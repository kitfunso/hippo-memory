// Decisions, incidents and the other first-class objects decay on the store's
// configured default half-life, never faster than an ordinary memory. Real stores, no mocks.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { readEntry } from '../src/store/entry-reads.js';
import type { HippoConfig } from '../src/core/config.js';
import { deriveHalfLife, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { saveDecision } from '../src/objects/decisions.js';
import { openIncident } from '../src/objects/incidents.js';
import { saveProcess } from '../src/objects/processes.js';
import { savePolicy } from '../src/objects/policies.js';
import { saveSkill } from '../src/objects/skills.js';
import { saveProjectBrief } from '../src/objects/project-briefs.js';
import { saveCustomerNote } from '../src/objects/customer-notes.js';
import { savePrediction } from './_helpers/save-prediction.js';
import { objectsAt } from './_helpers/objects-at.js';
import { loadConfig } from '../src/core/config.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
function store(config: Partial<HippoConfig> | undefined): string {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-typed-hl-')), '.hippo');
  dirs.push(path.dirname(root));
  initStore(root);
  if (config) fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  return root;
}

const writers: [string, (root: string) => Promise<{ memoryId: string | null }>][] = [
  ['decision', async (root) => await saveDecision(objectsAt(root), loadConfig(root).defaultHalfLifeDays, 'default', { decisionText: 'we release on Tuesdays after the staging soak' })],
  ['incident', async (root) => await openIncident(objectsAt(root), loadConfig(root).defaultHalfLifeDays, 'default', { incidentText: 'the billing cron charged twice on the 1st' }, 'cli')],
  ['process', async (root) => await saveProcess(objectsAt(root), loadConfig(root).defaultHalfLifeDays, 'default', { processName: 'Release', steps: ['tag', 'publish'] })],
  ['policy', async (root) => await savePolicy(objectsAt(root), loadConfig(root).defaultHalfLifeDays, 'default', { policyName: 'RetryPolicy', policyText: 'retry up to 3x' })],
  ['skill', async (root) => await saveSkill(objectsAt(root), loadConfig(root).defaultHalfLifeDays, 'default', { skillName: 'Run tests', instructions: 'npm test before commit' })],
  ['project brief', async (root) => await saveProjectBrief(objectsAt(root), loadConfig(root).defaultHalfLifeDays, 'default', { repo: 'acme/billing', summary: 'billing service for Acme' })],
  ['customer note', async (root) => await saveCustomerNote(objectsAt(root), loadConfig(root).defaultHalfLifeDays, 'default', { customer: 'Acme', note: 'renewal is due in March' })],
  ['prediction', async (root) => savePrediction(root, 'default', { classTag: 'migration-effort', claimText: 'the migration takes two days' })],
];

const defaults: [string, Partial<HippoConfig> | undefined, number][] = [
  ['the built-in default', undefined, DEFAULT_HALF_LIFE_DAYS],
  ['a configured default', { defaultHalfLifeDays: 730 }, 730],
];

describe.each(defaults)('first-class objects on %s', (_label, config, base) => {
  it.each(writers)('a %s decays no faster than an ordinary memory', async (_kind, save) => {
    const root = store(config);
    const entry = readEntry(root, (await save(root)).memoryId!, 'default')!;
    expect(entry.half_life_days).toBe(deriveHalfLife(base, entry));
    expect(entry.half_life_days).toBeGreaterThanOrEqual(base);
  });
});
