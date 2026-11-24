#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStore } from '../dist/entry/testing.js';
import { sqliteStore } from '../dist/store/sqlite/store.js';
import { ingestEvent, ingestMessage } from '../dist/entry/eval-scripts.js';
import { adminActor } from '../dist/api/index.js';
import { loadConfig } from '../dist/host/config-file.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

const root = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'hippo-ci-prov-'));
const dataDir = join(root, '.hippo');
mkdirSync(dataDir, { recursive: true });
initStore(dataDir);

const ctx = {
  hippoRoot: dataDir,
  tenantId: 'default',
  actor: adminActor('ci:seed'),
  store: sqliteStore(dataDir),
  config: loadConfig(dataDir),
};

const ghEvent = {
  eventName: 'issues',
  payload: {
    action: 'opened',
    repository: { full_name: 'acme/ci', private: false, owner: { login: 'acme' }, name: 'ci' },
    issue: {
      number: 1,
      title: 'ci-seed',
      body: 'seed',
      user: { login: 'ciuser', id: 1 },
      author_association: 'OWNER',
    },
  },
};
await ingestEvent(ctx, {
  event: ghEvent,
  rawBody: JSON.stringify(ghEvent.payload),
  deliveryId: 'ci-seed-1',
});

await ingestMessage(ctx, {
  teamId: 'T_CI',
  channel: { id: 'C_CI', name: 'ci', isPrivate: false },
  message: {
    type: 'message',
    channel: 'C_CI',
    user: 'U_CI',
    text: 'ci seed',
    ts: '1700000000.000001',
  },
  eventId: 'ci-seed-slack-1',
});

const binPath = resolve(repoRoot, 'bin/hippo.js');
const result = spawnSync('node', [binPath, 'provenance', '--strict', '--json'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
  encoding: 'utf8',
});

const stdout = result.stdout ?? '';
process.stdout.write(stdout);

const artifactPath = process.env.PROVENANCE_JSON_OUT ?? join(repoRoot, 'provenance-coverage.json');
writeFileSync(artifactPath, stdout);

if (result.error) console.error('seed: spawn error:', result.error.message);
if (result.signal) console.error('seed: child signal:', result.signal);

process.exit(result.status ?? 1);
