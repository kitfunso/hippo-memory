// Decisions, incidents and the other first-class objects decay on the store's
// configured default half-life, never faster than an ordinary memory. Real stores, no mocks.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { readEntry } from '../src/store/entry-reads.js';
import type { HippoConfig } from '../src/config.js';
import { deriveHalfLife, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { saveDecision } from '../src/decisions.js';
import { saveIncident } from '../src/incidents.js';
import { saveProcess } from '../src/processes.js';
import { savePolicy } from '../src/policies.js';
import { saveSkill } from '../src/skills.js';
import { saveProjectBrief } from '../src/project-briefs.js';
import { saveCustomerNote } from '../src/customer-notes.js';
import { savePrediction } from '../src/predictions.js';

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

const writers: [string, (root: string) => { memoryId: string | null }][] = [
  ['decision', (root) => saveDecision(root, 'default', { decisionText: 'we release on Tuesdays after the staging soak' })],
  ['incident', (root) => saveIncident(root, 'default', { incidentText: 'the billing cron charged twice on the 1st' })],
  ['process', (root) => saveProcess(root, 'default', { processName: 'Release', steps: ['tag', 'publish'] })],
  ['policy', (root) => savePolicy(root, 'default', { policyName: 'RetryPolicy', policyText: 'retry up to 3x' })],
  ['skill', (root) => saveSkill(root, 'default', { skillName: 'Run tests', instructions: 'npm test before commit' })],
  ['project brief', (root) => saveProjectBrief(root, 'default', { repo: 'acme/billing', summary: 'billing service for Acme' })],
  ['customer note', (root) => saveCustomerNote(root, 'default', { customer: 'Acme', note: 'renewal is due in March' })],
  ['prediction', (root) => savePrediction(root, 'default', { classTag: 'migration-effort', claimText: 'the migration takes two days' })],
];

const defaults: [string, Partial<HippoConfig> | undefined, number][] = [
  ['the built-in default', undefined, DEFAULT_HALF_LIFE_DAYS],
  ['a configured default', { defaultHalfLifeDays: 730 }, 730],
];

describe.each(defaults)('first-class objects on %s', (_label, config, base) => {
  it.each(writers)('a %s decays no faster than an ordinary memory', (_kind, save) => {
    const root = store(config);
    const entry = readEntry(root, save(root).memoryId!, 'default')!;
    expect(entry.half_life_days).toBe(deriveHalfLife(base, entry));
    expect(entry.half_life_days).toBeGreaterThanOrEqual(base);
  });
});
