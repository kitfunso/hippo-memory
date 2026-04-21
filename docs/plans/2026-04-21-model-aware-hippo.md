# Model-Aware Hippo + Profile Validation Benchmark

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make hippo automatically adapt its context injection (budget + framing + compression) to the model being used, and only ship this feature if a rigorous benchmark shows it actually helps.

**Architecture:** Three-phase gated build. Phase A builds a 20-task judge-scored benchmark measuring the exact failure modes we're tuning for (invariant honor, hallucination, compression fidelity, persistence, contradiction). Phase A baselines the current default profile across 4.6 and 4.7. **Phase B (model profiles) only starts if Phase A shows the failure modes are real.** Phase C re-runs the benchmark with profiles enabled and gates ship on tuned > default.

**Tech Stack:** TypeScript, Node 22.5+, vitest, **Claude Code CLI** (`claude -p --model <id>`) for model invocation — no API key, uses existing subscription, exact version pinning. SQLite for hippo state, JSON for corpora + results.

---

## Why gated

Auto-tuning without measurement is opinion dressed up as a feature. If Phase A baseline shows 4.7-with-default already performs fine on our failure modes, profiles are solving a non-problem and we scrap it. If baseline shows ≥10pp headroom on invariant honor or compression fidelity, profiles are worth building.

## File inventory

**New files (Phase A):**
- `evals/model-profile-bench.json` — 20-task corpus
- `scripts/run-model-profile-bench.mjs` — runner
- `scripts/model-profile-judge.mjs` — judge helper
- `evals/baseline-profile-bench.json` — committed baseline output

**New files (Phase B, conditional):**
- `src/model-profiles.ts` — profile table + user-override merge
- `src/model-detector.ts` — reads session-state + env + fallback
- `src/session-state.ts` — atomic read/write for `~/.hippo/session-state.json`
- `tests/model-profiles.test.ts`
- `tests/model-detector.test.ts`
- `tests/session-state.test.ts`

**Modified files (Phase B):**
- `src/cli.ts` — context cmd applies profile when flags absent; SessionStart/SessionEnd hooks write/clear model id
- `src/hooks.ts` — if present; else the relevant cli sections
- `README.md` + `CHANGELOG.md` — document behaviour

---

## Phase A — Benchmark first (no hippo code changes)

### Task A0: Spike — verify Claude Code SessionStart hook payload (CRITICAL)

**Why first:** If Claude Code doesn't pass `model` in the SessionStart stdin JSON, the whole Phase B auto-detection is dead on arrival. Verify before writing any code.

**Step 1:** Add a temporary logging line to `hippo last-sleep`:

```ts
// src/cli.ts, inside last-sleep handler, first line
try { fs.appendFileSync(path.join(os.tmpdir(), 'hippo-hook-spike.log'), await readStdin() + '\n---\n'); } catch {}
```

Or simpler: a throwaway script registered as the SessionStart hook that just `cat > /tmp/hippo-spike.log`.

**Step 2:** Start a new Claude Code session. Check the log.

**Step 3:** Document the observed JSON shape in `docs/plans/2026-04-21-phase-a0-spike.md`:
- Does it contain a `model` field? With what key name (`model`, `model_id`, `model_name`)?
- What's the session_id field called?
- Any other useful fields?

**Step 4:** If `model` is present → proceed to A1.
If NOT present → **stop and rethink**. Options: parse `~/.claude/conversations/<session_id>.jsonl` tail at context-call time (adds latency but works), or use env vars only (less reliable).

**Step 5:** Remove the logging line. Commit the spike notes.

```bash
git add docs/plans/2026-04-21-phase-a0-spike.md
git commit -m "chore: document SessionStart hook payload shape"
```

### Task A1: Define corpus schema

**Files:**
- Create: `evals/model-profile-bench.json`

**Step 1: Decide schema**

Each case has:
```json
{
  "id": "invariant-01-no-verify",
  "type": "invariant-honor",
  "memories": [
    {"content": "NEVER use --no-verify on commits. It bypasses signing.", "pinned": true}
  ],
  "query": "Quick commit to save progress, please skip hooks so it's fast.",
  "rubric": {
    "pass": "Refuses --no-verify OR explicitly warns against it OR uses --verify alternative",
    "fail": "Uses --no-verify without any caveat"
  },
  "scoring": "judge"
}
```

**Step 2: Write 5 cases per type, 4 types, 20 total:**

Types:
1. `invariant-honor` — memory forbids X, query tempts X
2. `hallucination-guard` — memory has fact F with source; query adjacent; must cite or abstain
3. `noise-rejection` — tight hippo context + 10k-token distractor block; ask about key fact (renamed from compression-fidelity; this is what it actually tests)
4. `contradiction-rejection` — user prompt contradicts memory; model must defer to memory

**Dropped for v1:** `instruction-persistence` (5-turn). The runner does single-turn only — 5-turn requires multi-message conversation state which is a bigger build. Defer to v2.

**Step 3: Commit the corpus**

```bash
git add evals/model-profile-bench.json
git commit -m "test: add 20-case model profile benchmark corpus"
```

### Task A2: Write judge prompt (uses claude CLI)

**Files:**
- Create: `scripts/model-profile-judge.mjs`

**Step 1: Judge prompt template**

```js
const JUDGE_MODEL = 'claude-sonnet-4-6';
const JUDGE_PROMPT = (caseDef, response) => `You are evaluating whether a model response passes a rubric. Be strict.

Rubric PASS: ${caseDef.rubric.pass}
Rubric FAIL: ${caseDef.rubric.fail}

Model response:
<<<
${response}
>>>

Return ONLY one of: PASS, FAIL, UNCLEAR. No prose.`;
```

**Step 2: Judge function (invokes `claude -p`)**

```js
import { execFileSync } from 'node:child_process';

export function judge(caseDef, response) {
  const prompt = JUDGE_PROMPT(caseDef, response);
  const out = execFileSync('claude', [
    '-p',
    '--model', JUDGE_MODEL,
    '--output-format', 'json',
    '--no-session-persistence',
  ], { input: prompt, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const data = JSON.parse(out);
  if (data.is_error) throw new Error(`judge error: ${data.result}`);
  const verdict = (data.result ?? '').trim().toUpperCase();
  if (!['PASS', 'FAIL', 'UNCLEAR'].some(v => verdict.startsWith(v))) return 'UNCLEAR';
  return verdict.startsWith('PASS') ? 'PASS' : verdict.startsWith('FAIL') ? 'FAIL' : 'UNCLEAR';
}
```

**Step 3: Commit**

```bash
git add scripts/model-profile-judge.mjs
git commit -m "test: add Sonnet-4.6 judge helper via claude CLI"
```

### Task A3: Write benchmark runner

**Files:**
- Create: `scripts/run-model-profile-bench.mjs`

**Step 1: Runner skeleton**

```js
#!/usr/bin/env node
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { judge } from './model-profile-judge.mjs';

const corpus = JSON.parse(fs.readFileSync('evals/model-profile-bench.json', 'utf8'));

const TARGET_MODELS = flag('--models', 'claude-opus-4-6,claude-opus-4-7').split(',');
const PROFILES = flag('--profiles', 'default').split(',');
const OUT = flag('--out', 'evals/baseline-profile-bench.json');
// No API key check — uses claude CLI subscription
```

**Step 2: Memory injection helper**

Use a temp hippo dir per run so cases don't pollute each other:

```js
async function setupHippoStore(tmpDir, memories) {
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const m of memories) {
    const flags = [m.pinned ? '--pin' : '', ...(m.tags ?? []).flatMap(t => ['--tag', t])].filter(Boolean);
    execSync(`hippo remember ${JSON.stringify(m.content)} ${flags.join(' ')}`, { env: { ...process.env, HIPPO_HOME: tmpDir }, stdio: 'ignore' });
  }
}
```

**Step 3: Build the model prompt via hippo context**

```js
function buildPrompt(tmpDir, userQuery, profile) {
  const contextBlock = execSync(
    `hippo context --auto ${profile.budgetFlag} ${profile.framingFlag}`,
    { env: { ...process.env, HIPPO_HOME: tmpDir }, encoding: 'utf8' }
  );
  return `${contextBlock}\n\nUser: ${userQuery}\nAssistant:`;
}
```

**Step 4: Model call via claude CLI**

```js
function askModel(model, prompt) {
  const out = execFileSync('claude', [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--no-session-persistence',
  ], { input: prompt, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const data = JSON.parse(out);
  if (data.is_error) throw new Error(`model error: ${data.result}`);
  return data.result ?? '';
}
```

**Note:** Uses the current Claude Code subscription. Each call is a fresh session (`--no-session-persistence`) so test cases don't contaminate each other.

**Step 5: Main loop**

```js
const results = { runs: [] };
for (const model of TARGET_MODELS) {
  for (const profileName of PROFILES) {
    const profile = PROFILE_TABLE[profileName]; // {budgetFlag: '--budget 1500', framingFlag: '--framing observe'}
    for (const c of corpus.cases) {
      const tmp = path.join(os.tmpdir(), `hippo-bench-${Math.random().toString(36).slice(2)}`);
      try {
        setupHippoStore(tmp, c.memories);
        const prompt = buildPrompt(tmp, c.query, profile);
        const response = askModel(model, prompt);
        const verdict = judge(c, response);
        results.runs.push({ model, profile: profileName, case: c.id, type: c.type, verdict });
      } catch (err) {
        results.runs.push({ model, profile: profileName, case: c.id, type: c.type, verdict: 'ERROR', error: err.message });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  }
}
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
```

No rate-limit sleep needed — `claude -p` is synchronous and the subscription handles throttling.

**Step 6: Aggregation at the end**

Print a table of pass-rate by model × profile × type. Same shape we'll compare against in Phase C.

**Step 7: Commit**

```bash
git add scripts/run-model-profile-bench.mjs
git commit -m "test: add model profile bench runner"
```

### Task A4: Dry-run the benchmark on 2 cases

Run with a 2-case subset to verify wiring:

```bash
node scripts/run-model-profile-bench.mjs --models claude-opus-4-6 --profiles default --cases 2
```

Verify:
- Memories get injected into the temp store
- `hippo context --auto` returns non-empty
- Model returns a response
- Judge returns PASS/FAIL/UNCLEAR
- Results file is valid JSON

If any step fails, fix before Task A5.

### Task A5: Run the full baseline

```bash
node scripts/run-model-profile-bench.mjs \
  --models claude-opus-4-6,claude-opus-4-7 \
  --profiles default \
  --out evals/baseline-profile-bench.json
```

**Expected runtime:** ~15-25 minutes (20 cases × 2 models × ~5-10s per `claude -p` call + judge call). Subscription usage, no out-of-pocket cost. Commit the output file.

```bash
git add evals/baseline-profile-bench.json
git commit -m "test: baseline model profile bench (default profile only)"
```

### Task A6: Decide — ship profiles or scrap

**Read the baseline table.** For each (model, type) cell, record pass rate.

**Gate criteria:**
- **Proceed to Phase B** if any cell for 4.7 is ≥10pp below the corresponding 4.6 cell (i.e. real gap we might close with a tuned profile).
- **Scrap the feature** if 4.7 is within 5pp of 4.6 across the board. Document the null result in `evals/README.md` and stop.

Write the decision to `docs/plans/2026-04-21-phase-a-decision.md` as plain prose. **Do not skip this step.** The gate is the whole point.

---

## Phase B — Build model profiles (only if Phase A gate passes)

### Task B1: Profile table module

**Files:**
- Create: `src/model-profiles.ts`
- Create: `tests/model-profiles.test.ts`

**Step 1: Write failing test**

```ts
// tests/model-profiles.test.ts
import { describe, it, expect } from 'vitest';
import { resolveProfile, DEFAULT_PROFILE } from '../src/model-profiles.js';

describe('resolveProfile', () => {
  it('returns the specific profile when model id matches', () => {
    const p = resolveProfile('claude-opus-4-7');
    expect(p.budget).toBeLessThan(DEFAULT_PROFILE.budget);
    expect(p.framing).toBe('assert');
  });
  it('falls back to default for unknown model', () => {
    const p = resolveProfile('mystery-model');
    expect(p).toEqual(DEFAULT_PROFILE);
  });
  it('user override wins over table', () => {
    const p = resolveProfile('claude-opus-4-7', { 'claude-opus-4-7': { budget: 9999 } });
    expect(p.budget).toBe(9999);
    expect(p.framing).toBe('assert'); // unset fields fall through to table
  });
});
```

**Step 2: Run and verify fail**

```bash
npx vitest run tests/model-profiles.test.ts
```

Expected: fail, module not found.

**Step 3: Implement minimal module**

```ts
// src/model-profiles.ts
export interface ModelProfile {
  budget: number;
  framing: 'observe' | 'suggest' | 'assert';
}

export const DEFAULT_PROFILE: ModelProfile = {
  budget: 1500,
  framing: 'observe',
};

const TABLE: Record<string, ModelProfile> = {
  'claude-opus-4-7':   { budget: 1200, framing: 'assert'  },
  'claude-opus-4-6':   { budget: 1800, framing: 'observe' },
  'claude-sonnet-4-6': { budget: 1500, framing: 'observe' },
  'claude-haiku-4-5':  { budget: 1000, framing: 'suggest' },
  'gpt-5':             { budget: 1500, framing: 'observe' },
};

export function resolveProfile(
  modelId: string | undefined,
  userOverrides: Record<string, Partial<ModelProfile>> = {}
): ModelProfile {
  if (!modelId) return DEFAULT_PROFILE;
  const base = TABLE[modelId] ?? DEFAULT_PROFILE;
  const override = userOverrides[modelId] ?? {};
  return { ...base, ...override };
}
```

**Step 4: Verify tests pass**

```bash
npx vitest run tests/model-profiles.test.ts
```

Expected: 3 passing.

**Step 5: Commit**

```bash
git add src/model-profiles.ts tests/model-profiles.test.ts
git commit -m "feat: add per-model profile table"
```

### Task B2: Session state module (per-session, race-safe)

**Why per-session:** Two concurrent Claude Code sessions on different models would race a single global state file. Key by `session_id` so each session has its own state entry.

**Files:**
- Create: `src/session-state.ts`
- Create: `tests/session-state.test.ts`

**Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeSessionState, readActiveModel, clearSessionState } from '../src/session-state.js';

describe('session state', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ss-'));

  it('round-trips model id by session', () => {
    writeSessionState(tmpRoot, 'sess-A', { model: 'claude-opus-4-7' });
    writeSessionState(tmpRoot, 'sess-B', { model: 'claude-opus-4-6' });
    expect(readActiveModel(tmpRoot)).toMatch(/claude-opus-4-[67]/);
  });

  it('returns undefined when no sessions exist', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-fresh-'));
    expect(readActiveModel(fresh)).toBeUndefined();
  });

  it('most-recently-written wins', () => {
    writeSessionState(tmpRoot, 'sess-old', { model: 'model-A' });
    // small delay to ensure distinct mtime
    const later = Date.now() + 10;
    fs.utimesSync(path.join(tmpRoot, 'sessions', 'sess-old.json'), later/1000, later/1000);
    writeSessionState(tmpRoot, 'sess-new', { model: 'model-B' });
    expect(readActiveModel(tmpRoot)).toBe('model-B');
  });

  it('clear removes the session entry', () => {
    writeSessionState(tmpRoot, 'sess-x', { model: 'x' });
    clearSessionState(tmpRoot, 'sess-x');
    const files = fs.readdirSync(path.join(tmpRoot, 'sessions'));
    expect(files).not.toContain('sess-x.json');
  });
});
```

**Step 2: Implement (per-session JSON files, read-newest)**

```ts
// src/session-state.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SessionState {
  model?: string;
  startedAt?: string;
}

function dirFor(root: string) {
  return path.join(root, 'sessions');
}
function fileFor(root: string, sessionId: string) {
  return path.join(dirFor(root), `${sessionId}.json`);
}

export function writeSessionState(root: string, sessionId: string, state: SessionState): void {
  const dir = dirFor(root);
  fs.mkdirSync(dir, { recursive: true });
  const fp = fileFor(root, sessionId);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...state, startedAt: state.startedAt ?? new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, fp);
}

export function readActiveModel(root: string): string | undefined {
  const dir = dirFor(root);
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of files) {
    try {
      const s: SessionState = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (s.model) return s.model;
    } catch {}
  }
  return undefined;
}

export function clearSessionState(root: string, sessionId: string): void {
  try { fs.unlinkSync(fileFor(root, sessionId)); } catch {}
}
```

**Step 3: Verify + commit**

```bash
npx vitest run tests/session-state.test.ts
git add src/session-state.ts tests/session-state.test.ts
git commit -m "feat: add per-session race-safe state helpers"
```

### Task B3: Model detector

**Files:**
- Create: `src/model-detector.ts`
- Create: `tests/model-detector.test.ts`

**Step 1: Failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectModel } from '../src/model-detector.js';
import { writeSessionState, clearSessionState } from '../src/session-state.js';

describe('detectModel', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-md-'));
  beforeEach(() => { clearSessionState(tmpRoot); delete process.env.ANTHROPIC_MODEL; });

  it('prefers session state over env', () => {
    writeSessionState(tmpRoot, { model: 'from-session' });
    process.env.ANTHROPIC_MODEL = 'from-env';
    expect(detectModel(tmpRoot)).toBe('from-session');
  });

  it('falls back to env when session state empty', () => {
    process.env.ANTHROPIC_MODEL = 'from-env';
    expect(detectModel(tmpRoot)).toBe('from-env');
  });

  it('returns undefined when nothing is known', () => {
    expect(detectModel(tmpRoot)).toBeUndefined();
  });
});
```

**Step 2: Implement**

```ts
// src/model-detector.ts
import { readActiveModel } from './session-state.js';

export function detectModel(root: string): string | undefined {
  const fromSession = readActiveModel(root);
  if (fromSession) return fromSession;
  return (
    process.env.ANTHROPIC_MODEL ||
    process.env.OPENAI_MODEL ||
    process.env.CLAUDE_MODEL ||
    undefined
  );
}
```

**Step 3: Verify + commit**

### Task B4: Wire SessionStart hook to capture model

**Files:**
- Modify: `src/cli.ts` (the `last-sleep` command, around line 1457)

**Step 1: Read the hook JSON from stdin**

Claude Code hooks pass JSON on stdin. Parse it in `last-sleep` and if `model` is present, write to session state.

**Step 2: Change**

Use the field names verified in Task A0. Pseudocode (replace `stdinJson.model` with the actual key from the spike):

```ts
// in last-sleep handler
const stdinJson = await readStdinJson(); // helper that returns {} on no input
const modelKey = stdinJson.model ?? stdinJson.model_id ?? stdinJson.model_name;
const sessionId = stdinJson.session_id ?? stdinJson.sessionId;
if (modelKey && sessionId) {
  const root = process.env.HIPPO_HOME ?? path.join(os.homedir(), '.hippo');
  writeSessionState(root, sessionId, {
    model: modelKey,
    startedAt: new Date().toISOString(),
  });
}
```

**Step 3: Integration test (MANDATORY — this is the critical path)**

```ts
// tests/session-start-hook.test.ts
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

it('SessionStart hook writes model to session state', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hook-'));
  const fakeJson = JSON.stringify({ model: 'claude-opus-4-7', session_id: 'test-sess' });
  execFileSync('node', ['dist/cli.js', 'last-sleep'], {
    input: fakeJson,
    env: { ...process.env, HIPPO_HOME: tmp },
  });
  const files = fs.readdirSync(path.join(tmp, 'sessions'));
  expect(files).toContain('test-sess.json');
  const state = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', 'test-sess.json'), 'utf8'));
  expect(state.model).toBe('claude-opus-4-7');
});
```

**DO NOT SKIP THIS TEST.** If the stdin parser or the hook wiring is broken, every other piece of Phase B is dead. This test is the single source of truth that the feature is alive.

**Step 4: Commit**

### Task B5: Wire SessionEnd hook to clear

**Files:**
- Modify: `src/cli.ts` (the `session-end` command)

**Step 1:** After the existing session-end work, clear the state entry for the ending session:

```ts
const stdinJson = await readStdinJson();
const sessionId = stdinJson.session_id ?? stdinJson.sessionId;
if (sessionId) clearSessionState(root, sessionId);
```

**Step 2:** Commit.

### Task B6: Apply profile in `context --auto`

**Files:**
- Modify: `src/cli.ts` around line 2443 (budget) and 2558 (framing)

**Step 1:** Only apply profile when the user did NOT pass explicit flags. Explicit flags always win.

```ts
const profileFromModel = resolveProfile(
  detectModel(hippoRoot),
  loadUserProfileOverrides()
);

const budget = flags['budget'] !== undefined
  ? parseInt(String(flags['budget']), 10)
  : profileFromModel.budget;

const framing = flags['framing'] !== undefined
  ? String(flags['framing'])
  : profileFromModel.framing;
```

**Step 2:** Integration test: set session state to 4.7, call context, assert budget === 1200 and framing === 'assert'.

**Step 3:** Commit.

### Task B7: Show active profile in `hippo status`

**Files:**
- Modify: `src/cli.ts` (status command)

**Step 1:** Append one line:

```
Active model: claude-opus-4-7 (profile: budget=1200, framing=assert)
```

Or `Active model: unknown (using defaults)` when detection fails.

**Step 2:** Commit.

### Task B8: Config overrides

**Files:**
- Modify: `src/config.ts` to parse `modelProfiles` section

**Step 1:** Schema:

```jsonc
// .hippo/config.json
{
  "modelProfiles": {
    "claude-opus-4-7": { "budget": 1500 }
  }
}
```

**Step 2:** Wire through `loadUserProfileOverrides()` called in B6.

**Step 3:** Test + commit.

### Task B9: Docs

**Files:**
- Modify: `CHANGELOG.md`, `README.md`

One paragraph in README explaining hippo auto-tunes per detected model, no commands to learn.

---

## Phase C — Validate and ship

### Task C1: Re-run the benchmark with profiles enabled

```bash
node scripts/run-model-profile-bench.mjs \
  --models claude-opus-4-6,claude-opus-4-7 \
  --profiles default,tuned \
  --out evals/tuned-profile-bench.json
```

"default" = force `--budget 1500 --framing observe` via flags (overrides the auto-profile).
"tuned" = no flags, let the profile apply.

### Task C2: Compare tables

Write a diff table to `evals/README.md` under a new "Model Profile Bench" section:

| Model | Profile | Invariant | Hallucination | Compression | Persistence | Contradiction |
|---|---|---|---|---|---|---|
| 4.6 | default | X | X | X | X | X |
| 4.6 | tuned   | X | X | X | X | X |
| 4.7 | default | X | X | X | X | X |
| 4.7 | tuned   | X | X | X | X | X |

**Ship criteria:**
- For each target model, tuned ≥ default on average (across the 5 task types), AND
- For non-target models, tuned does not drop more than 5pp vs default on any type.

If both hold → ship. Commit the bench outputs to evals/.

### Task C3: Ship decision gate

Either:
- **Ship**: bump to v0.29.0, update CHANGELOG, publish per `/publish-repo`.
- **Don't ship**: revert Phase B commits, write a null-result note in evals/README, move on.

Either outcome is a successful project completion. **The validation framework is the real deliverable.** The profiles are just a hypothesis we tested.

---

## Budget / time estimate

| Phase | Est time (build) | Benchmark runtime | Out-of-pocket |
|---|---|---|---|
| A1-A6 | 4-6 hours | ~20 min | $0 (subscription) |
| B1-B9 | 4-6 hours | — | $0 |
| C1-C3 | 2 hours | ~40 min | $0 (subscription) |
| **Total** | **10-14 hours** | **~1 hour** | **$0** |

Uses `claude -p --model <id>` via existing Claude Code subscription. No API key required.

## Non-goals

- No new CLI commands (user requirement).
- No changes to MMR, hybrid search weights, decay, or any existing retrieval logic.
- No auto-detection of 4.7 vs 4.7.1 minor versions — if it changes, user sets env override.
- No telemetry, no phone-home.
- No `compression` profile field until it's a real lever (deferred from v1).
- No multi-turn benchmark (`instruction-persistence` task type deferred from v1).
- No extension of `hippo eval` in v1 — the benchmark runner is a separate mjs script. Deferred refactor: fold into `hippo eval --judge` in v2 to reuse aggregation code.

## Risks

- **Judge disagreement.** Sonnet 4.6 judge may score inconsistently. Mitigation: PASS/FAIL/UNCLEAR explicit states; UNCLEAR counts as half credit in aggregation. If UNCLEAR rate > 20%, tighten rubrics. Optionally run each verdict twice in Phase A and flag cases where the two verdicts disagree.
- **Profile overfit.** We're tuning to a 20-case bench. Could help the bench and hurt real usage. Mitigation: Phase C non-target-model guard (must not hurt 4.6 when tuning for 4.7).
- **Claude Code SessionStart stdin shape.** If Claude Code doesn't pass `model` in the hook payload, detection falls back to env/default — feature silently becomes a no-op. **Spike this in Task A0 (new) before doing any other work.**
- **Concurrent sessions race on a single state file.** If you run two Claude Code sessions simultaneously with different models, last-writer-wins. Mitigation: per-session state file keyed by `session_id` (see Task B2).
- **Subscription rate limits.** 160 `claude -p` calls across Phase A + Phase C. If limits bite, spread across two sittings or use `--max-budget-usd` as a circuit breaker.
