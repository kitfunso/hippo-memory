#!/usr/bin/env node
/**
 * CI-only seed for the provenance gate. Initializes a fresh hippo store under
 * the temp root passed as $1 (or a fresh mkdtemp if absent), ingests one
 * GitHub issue webhook + one Slack message through the real ingest paths,
 * then runs `hippo provenance --strict --json` against that root and forwards
 * the exit code.
 *
 * Why fixtures inline: avoids a tests/fixtures dependency for what is
 * intentionally a tiny smoke seed. The unit-level parity tests
 * (tests/github-provenance-parity.test.ts, tests/slack-provenance-parity.test.ts)
 * cover the wide matrix.
 *
 * cwd routing: src/store.ts:193's getHippoRoot is `path.join(cwd, '.hippo')`
 * unconditionally. The CLI does NOT honor HIPPO_HOME for the local store,
 * only the global/shared path. So we spawn the CLI with `cwd: root`, not via
 * env var (codex round 1 P0 on docs/plans/2026-05-05-provenance-ci-gate.md).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStore } from '../dist/store.js';
import { ingestEvent } from '../dist/connectors/github/ingest.js';
import { ingestMessage } from '../dist/connectors/slack/ingest.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

// `root` is the cwd we'll launch the CLI from; the actual store data lives
// inside `root/.hippo` because the CLI's getHippoRoot is `path.join(cwd, '.hippo')`.
// (src/store.ts:193). Both writers and the CLI read MUST agree.
const root = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'hippo-ci-prov-'));
const dataDir = join(root, '.hippo');
mkdirSync(dataDir, { recursive: true });
initStore(dataDir);

const ctx = { hippoRoot: dataDir, tenantId: 'default', actor: 'ci:seed' };

const ghEvent = {
  eventName: 'issues',
  payload: {
    action: 'opened',
    repository: { full_name: 'acme/ci', private: false, owner: { login: 'acme' }, name: 'ci' },
    issue: { number: 1, title: 'ci-seed', body: 'seed', user: { login: 'ciuser', id: 1 } },
  },
};
ingestEvent(ctx, {
  event: ghEvent,
  rawBody: JSON.stringify(ghEvent.payload),
  deliveryId: 'ci-seed-1',
});

ingestMessage(ctx, {
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

// Persist for actions/upload-artifact (codex round 1 P1).
const artifactPath = process.env.PROVENANCE_JSON_OUT ?? join(repoRoot, 'provenance-coverage.json');
writeFileSync(artifactPath, stdout);

if (result.error) console.error('seed: spawn error:', result.error.message);
if (result.signal) console.error('seed: child signal:', result.signal);

process.exit(result.status ?? 1);
