# Provenance CI Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire `hippo provenance --strict` into a from-scratch GitHub Actions workflow + add a Slack provenance parity unit test. Take the v0.40.0 provenance gate from "shipped CLI" to "enforced in CI on every PR."

**Architecture:** Three deliverables. (1) A vitest parity test for the Slack connector mirroring `tests/github-provenance-parity.test.ts`. (2) A from-scratch `.github/workflows/ci.yml` (this repo currently has zero CI). (3) A CI seed script that ingests 1 GitHub fixture + 1 Slack fixture through the real ingest paths into a temp store, then runs `hippo provenance --strict`. Why both unit and CI seed: unit-level parity catches contract drift inside the test suite (devs see it locally before CI); CI seed proves end-to-end that a real ingest preserves the envelope into a real store. If anyone disables `owner` / `artifact_ref` in either connector's transform, both layers fire.

**Tech Stack:** TypeScript, vitest, GitHub Actions, Node 22.5+ (engines pin), npm ci.

**Pre-conditions established by survey:**
- No `.github/` directory exists in the repo.
- `coverage = 1.0` when `rawTotal === 0` (`src/provenance-coverage.ts:26`), so an empty-store gate is a rubber stamp. Seed corpus is mandatory for the gate to bite.
- GitHub already has parity coverage at `tests/github-provenance-parity.test.ts`.
- Slack does **not** have an equivalent test, AND `src/connectors/slack/transform.ts:38` writes `owner: undefined` when `message.user` is absent (e.g. `bot_message` subtype with text). Task 1 fixes this by deriving `owner: bot:<bot_id>` rather than skipping (see codex round 1 P1).
- **CLI does NOT honor `HIPPO_HOME` for the local store.** `store.ts:193` returns `path.join(cwd, '.hippo')` unconditionally; `cli.ts:5571` calls `getHippoRoot(process.cwd())`. Only the global/shared path in `shared.ts:26` reads `HIPPO_HOME`. Task 2 spawns the CLI with `cwd: root`, not via env var (codex round 1 P0).
- Routine `trig_01VMzbHbYaE5Trtb2rmDnTBx` (scheduled 2026-05-16) has been disabled.

**Out of scope:** Lint workflow (repo has no eslint config), release workflow, multi-OS matrix, build-output caching across jobs, npm publish (CI infra change does not alter package contents).

---

### Task 1: Slack provenance parity test

**Files:**
- Create: `tests/slack-provenance-parity.test.ts`
- Reference: `tests/github-provenance-parity.test.ts`
- Reference: `src/connectors/slack/ingest.ts:44`, `src/connectors/slack/transform.ts:23`

**Step 1: Write the parity test**

Mirror the GitHub structure. Three scenarios:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, loadAllEntries } from '../src/store.js';
import { ingestMessage } from '../src/connectors/slack/ingest.js';
import { buildProvenanceCoverage } from '../src/provenance-coverage.js';
import type { ChannelMeta } from '../src/connectors/slack/scope.js';
import type { SlackMessageEvent } from '../src/connectors/slack/types.js';
import type { Context } from '../src/api.js';

const PUBLIC_CHANNEL: ChannelMeta = { id: 'C01PUB', name: 'general', isPrivate: false };
const TEAM_ID = 'T01TEAM';

function ctxFor(root: string): Context {
  return { hippoRoot: root, tenantId: 'default', actor: 'connector:slack' };
}

function makeMessage(i: number, opts: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: 'message',
    channel: PUBLIC_CHANNEL.id,
    user: `U${String(i).padStart(5, '0')}`,
    text: `prov-msg-${i}`,
    ts: `1700000000.${String(i).padStart(6, '0')}`,
    ...opts,
  };
}

describe('Slack connector — provenance coverage parity', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-prov-'));
    mkdirSync(join(root, '.hippo'), { recursive: true });
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('every ingested user message carries owner + artifact_ref (coverage = 1.0)', () => {
    const ctx = ctxFor(root);
    for (let i = 0; i < 25; i++) {
      const msg = makeMessage(i);
      ingestMessage(ctx, {
        teamId: TEAM_ID,
        channel: PUBLIC_CHANNEL,
        message: msg,
        eventId: `Ev${i}`,
      });
    }
    const coverage = buildProvenanceCoverage(loadAllEntries(root));
    expect(coverage.gaps).toHaveLength(0);
    expect(coverage.coverage).toBe(1);

    const slackEntries = loadAllEntries(root).filter(
      (e) => e.kind === 'raw' && e.tags.includes('source:slack'),
    );
    expect(slackEntries.length).toBeGreaterThanOrEqual(25);
    for (const e of slackEntries) {
      expect(e.owner).not.toBeNull();
      expect(e.owner).toMatch(/^user:U/);
      expect(e.artifact_ref).not.toBeNull();
      expect(e.artifact_ref?.startsWith('slack://')).toBe(true);
    }
  });

  it('userless bot message gets bot:<bot_id> owner, never coverage gap', () => {
    // Slack edge case: subtype='bot_message' carries text + bot_id but no user.
    // Production must keep ingesting these (codex round 1 P1: skipping them
    // would silently drop existing bot ingestion). The v0.40.0 strict gate
    // requires a non-null owner, so transform.ts derives `bot:<bot_id>`.
    const ctx = ctxFor(root);
    const userless: SlackMessageEvent = {
      type: 'message',
      subtype: 'bot_message',
      channel: PUBLIC_CHANNEL.id,
      text: 'a bot said this',
      ts: '1700000099.000099',
      bot_id: 'B01ABCD',
    };
    ingestMessage(ctx, {
      teamId: TEAM_ID,
      channel: PUBLIC_CHANNEL,
      message: userless,
      eventId: 'EvBot',
    });
    const coverage = buildProvenanceCoverage(loadAllEntries(root));
    expect(coverage.gaps).toHaveLength(0);
    const botRow = loadAllEntries(root).find((e) => e.tags.includes('source:slack') && e.owner?.startsWith('bot:'));
    expect(botRow?.owner).toBe('bot:B01ABCD');
  });

  it('threaded reply preserves thread_ts tag and gate stays clean', () => {
    const ctx = ctxFor(root);
    const reply = makeMessage(99, { thread_ts: '1700000000.000001' });
    ingestMessage(ctx, {
      teamId: TEAM_ID,
      channel: PUBLIC_CHANNEL,
      message: reply,
      eventId: 'EvReply',
    });
    const entries = loadAllEntries(root).filter((e) => e.tags.includes('source:slack'));
    const replyRow = entries.find((e) => e.tags.includes('thread:1700000000.000001'));
    expect(replyRow?.owner).toMatch(/^user:U/);
    expect(buildProvenanceCoverage(loadAllEntries(root)).gaps).toHaveLength(0);
  });

  it('message_changed edits do not create coverage gaps', () => {
    // The connector ingests edits as new raw rows under the same artifact_ref
    // shape; coverage must hold whether or not the edit creates a new row.
    const ctx = ctxFor(root);
    const original = makeMessage(50);
    ingestMessage(ctx, { teamId: TEAM_ID, channel: PUBLIC_CHANNEL, message: original, eventId: 'EvOrig' });
    const edited: SlackMessageEvent = {
      ...original,
      subtype: 'message_changed',
      text: `${original.text} (edited)`,
    };
    ingestMessage(ctx, { teamId: TEAM_ID, channel: PUBLIC_CHANNEL, message: edited, eventId: 'EvEdit' });
    expect(buildProvenanceCoverage(loadAllEntries(root)).gaps).toHaveLength(0);
  });
});
```

**Step 2: Run it. The bot_message case will fail until transform.ts is updated.**

```
npx vitest run tests/slack-provenance-parity.test.ts
```

Codex round 1 P1 verdict: do NOT skip userless messages — `slack/ingest.ts:54-65` already treats null-transform as "skipped but seen", so flipping userless+text to skip would silently stop ingesting any bot message in production. Use the bot owner path instead.

**Step 2a: Add `bot_id` to the Slack message type.**

Edit `src/connectors/slack/types.ts:13` to extend `SlackMessageEvent`:

```ts
export interface SlackMessageEvent {
  type: 'message';
  subtype?: 'message_deleted' | 'message_changed' | 'channel_join' | string;
  channel: string;
  channel_type?: 'channel' | 'group' | 'im' | 'mpim';
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;            // <-- new: bot_message subtype carries this instead of user
  /** Present on subtype='message_deleted'. */
  deleted_ts?: string;
}
```

**Step 2b: Derive bot owner in transform.ts.**

Edit `src/connectors/slack/transform.ts:38`. Replace:

```ts
owner: input.message.user ? `user:${input.message.user}` : undefined,
```

with:

```ts
owner: input.message.user
  ? `user:${input.message.user}`
  : input.message.bot_id
    ? `bot:${input.message.bot_id}`
    : 'bot:unknown',
```

Add a tag for bot messages by including `bot:${input.message.bot_id}` in the tags array when present (mirrors the existing user-tag pattern on line 30).

**Step 3: Re-run, verify green.**

```
npx vitest run tests/slack-provenance-parity.test.ts
```

Expected: PASS.

**Step 4: Run the full suite to confirm no regressions.**

```
npx vitest run
```

Expected: 1232 + 4 = 1236 tests pass, 0 fail (4 new cases: user, bot_message, thread reply, message_changed).

**Step 5: Commit.**

```bash
git add tests/slack-provenance-parity.test.ts src/connectors/slack/transform.ts src/connectors/slack/types.ts
git commit -m "test: add Slack provenance parity, derive bot owner from bot_id"
```

---

### Task 2: CI seed script

**Files:**
- Create: `scripts/ci-seed-provenance.mjs`

**Step 1: Write the seed script**

```js
#!/usr/bin/env node
/**
 * CI-only seed for the provenance gate. Initializes a fresh hippo store under
 * the temp root passed as $1 (or $TMPDIR/hippo-ci-prov-$$ if absent), ingests
 * one GitHub issue webhook + one Slack message through the real ingest paths,
 * then runs `hippo provenance --strict --json` and forwards its exit code.
 *
 * Why fixtures inline: avoids a tests/fixtures dependency for what is
 * intentionally a tiny smoke seed. The unit-level parity tests cover the wide
 * matrix.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initStore } from '../dist/store.js';
import { ingestEvent } from '../dist/connectors/github/ingest.js';
import { ingestMessage } from '../dist/connectors/slack/ingest.js';

const root = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'hippo-ci-prov-'));
mkdirSync(join(root, '.hippo'), { recursive: true });
initStore(root);

const ctx = { hippoRoot: root, tenantId: 'default', actor: 'ci:seed' };

// GitHub fixture
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

// Slack fixture
ingestMessage(ctx, {
  teamId: 'T_CI',
  channel: { id: 'C_CI', name: 'ci', isPrivate: false },
  message: { type: 'message', channel: 'C_CI', user: 'U_CI', text: 'ci seed', ts: '1700000000.000001' },
  eventId: 'ci-seed-slack-1',
});

// codex P0: spawn with cwd: root, NOT env: HIPPO_HOME. The CLI's getHippoRoot
// (src/store.ts:193) is `path.join(cwd, '.hippo')` and ignores HIPPO_HOME for
// the local store. Setting cwd routes the CLI to read the same store the
// fixtures wrote to.
const repoRoot = resolve(import.meta.dirname, '..');
const binPath = resolve(repoRoot, 'bin/hippo.js');
const result = spawnSync('node', [binPath, 'provenance', '--strict', '--json'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
  encoding: 'utf8',
});

// codex P1: persist the JSON for actions/upload-artifact. Print to stdout too
// so it lands in the workflow log on the same line.
const stdout = result.stdout ?? '';
process.stdout.write(stdout);
const artifactPath = process.env.PROVENANCE_JSON_OUT ?? join(repoRoot, 'provenance-coverage.json');
writeFileSync(artifactPath, stdout);

if (result.error) console.error('seed: spawn error:', result.error.message);
if (result.signal) console.error('seed: child signal:', result.signal);

process.exit(result.status ?? 1);
```

**Step 2: Verify cwd routing**

Confirm the CLI uses `process.cwd()` to resolve the store. The relevant function is `getHippoRoot` at `src/store.ts:193`, called from `src/cli.ts:5571`. Both have been read during plan revision — the `cwd: root` approach is correct.

```
grep -n "getHippoRoot" src/store.ts src/cli.ts | head -10
```

Sanity check: `src/store.ts:193` returns `path.join(cwd, '.hippo')` unconditionally. No flag-based override exists today. If a future change adds `--hippo-root`, prefer that form; until then, `cwd: root` is the only correct routing.

**Step 3: Smoke run locally**

```
npm run build
node scripts/ci-seed-provenance.mjs
echo "exit=$?"
```

Expected: prints JSON like `{"rawTotal": 2, "rawWithEnvelope": 2, "coverage": 1, "gaps": []}` and `exit=0`.

**Step 4: Verify failure mode**

Temporarily edit `src/connectors/github/transform.ts:43` to set `owner: undefined`. Rebuild, re-run the script, confirm exit code is 1 and gaps array is non-empty. **Revert the edit.**

**Step 5: Commit.**

```bash
git add scripts/ci-seed-provenance.mjs
git commit -m "test: add CI seed script for provenance gate"
```

---

### Task 3: GitHub Actions workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: Write the workflow**

```yaml
# .github/workflows/ci.yml
#
# Repository-first CI. Runs on every PR + push to master.
#
# The "provenance gate" step at the bottom is the v0.40.0 / 2026-05-05
# Company Brain scorecard gate: every kind='raw' row must carry owner +
# artifact_ref. The CI seed script exercises both connectors (Slack +
# GitHub) end-to-end, then runs `hippo provenance --strict`. Drop a
# connector's owner stamp and this step fails the PR.
#
# See docs/plans/2026-04-28-company-brain-measurement.md (gate origin)
# and docs/plans/2026-05-05-provenance-ci-gate.md (this workflow).
name: CI

on:
  pull_request:
  push:
    branches: [master]

# codex P1: read-only by default, no write scopes the workflow does not need.
permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    # codex P1: 15min was tight on first-run npm ci with @xenova/transformers
    # optionalDependency (large native install). 25 gives headroom on a cold cache.
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22.5.0'
          cache: npm
      - run: npm ci
      - run: npm run build
      - name: Vitest
        run: npx vitest run
      - name: Provenance gate
        run: node scripts/ci-seed-provenance.mjs
      - name: Upload provenance JSON
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: provenance-coverage
          path: provenance-coverage.json
          if-no-files-found: warn
          retention-days: 14
```

**Step 2: Validate yaml syntax locally**

```
node -e "const yaml = require('yaml'); yaml.parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8'))"
```

If `yaml` package is not installed, skip — actions/setup-node parses the workflow on the runner and we'll see syntax errors there.

**Step 3: Commit.**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add first GitHub Actions workflow with provenance gate"
```

---

### Task 4: Documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` (only if it has a "Development" / "Contributing" section)

**Step 1: CHANGELOG entry**

First, read the top of `CHANGELOG.md` once to match its exact section format (heading style, date format, category names). Do not guess — copy the existing convention.

```
head -40 CHANGELOG.md
```

Then add under the existing v1.3.2 section, OR create an "Unreleased" section at the top following whatever convention you observed:

```markdown
## Unreleased

### Added
- **CI workflow with provenance gate.** First `.github/workflows/ci.yml` runs build + vitest + an end-to-end provenance seed gate. The gate ingests one GitHub webhook and one Slack message through the real connectors and runs `hippo provenance --strict`, failing the PR if any raw row is missing `owner` or `artifact_ref`.
- **Slack provenance parity test.** Mirrors the GitHub parity test; ensures every ingested user message satisfies the v0.40.0 envelope contract. Userless `bot_message` subtypes are now skipped at ingest rather than written with `owner=null`.
```

**Step 2: README hook (optional)**

Search for existing CI / contributing language:

```
grep -n "CI\|contribut\|Develop" README.md | head -10
```

If a Development section exists, add one line: `Tests run on every PR via .github/workflows/ci.yml — including a provenance coverage gate.` If no such section, skip.

**Step 3: Commit.**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: changelog entry for CI provenance gate"
```

---

### Task 5: Push and verify CI

**Step 1: Push.**

```bash
git push origin master
```

(No version bump, no npm publish — CI infra does not alter the package.)

**Step 2: Watch the first CI run.**

```bash
gh run watch
```

Expected: green across all steps. If any step fails:
- Build error: read TS output, fix.
- Vitest failure: investigate, fix.
- Provenance gate failure: read the printed JSON gaps, fix the offending transform.

---

## Verification checklist

- [ ] `npx vitest run tests/slack-provenance-parity.test.ts` PASS
- [ ] `npx vitest run` PASS (1234 tests)
- [ ] `node scripts/ci-seed-provenance.mjs` PASS (exit 0, coverage=1.0, rawTotal=2)
- [ ] `.github/workflows/ci.yml` parses
- [ ] First CI run on master is green
- [ ] Routine `trig_01VMzbHbYaE5Trtb2rmDnTBx` is `enabled: false` (already done before plan execution)

## Risk register

- **CLI cwd routing.** The CLI ignores `HIPPO_HOME` for the local store; only `cwd` controls where it reads. The seed script spawns the CLI with `cwd: root`. If a future refactor adds `--hippo-root` or makes `getHippoRoot` env-var-aware, prefer the explicit flag form.
- **Slack bot_id contract expansion.** Adding `bot_id?: string` to `SlackMessageEvent` widens the type surface. Anyone constructing this type by hand in a test/import path needs to allow the new optional field. Mitigation: it's optional, so existing code keeps compiling.
- **CI runner npm cache miss on first run.** First run will be slow (no cache hit). `timeout-minutes: 25` gives headroom; subsequent PRs cache.
- **vitest timeout on CI.** Existing test suite takes ~30s locally. Watch the first run; if green, leave alone.
- **Artifact size.** `provenance-coverage.json` is tiny (~100 bytes). 14-day retention is fine.
