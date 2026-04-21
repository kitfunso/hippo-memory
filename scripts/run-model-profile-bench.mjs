#!/usr/bin/env node
/**
 * Model profile benchmark runner.
 *
 * For each (model, profile, case):
 *   1. Create a fresh temp hippo store (HIPPO_HOME=<tmp>)
 *   2. Inject memories via `hippo remember`
 *   3. Build the prompt: `hippo context --auto` output + optional distractor + user query
 *   4. Call the model via `claude -p --model <id>` (no API key — uses subscription)
 *   5. Judge the response via scripts/model-profile-judge.mjs
 *   6. Record verdict
 *
 * Results written to JSON for Phase C comparison.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { judge } from './model-profile-judge.mjs';

// ---- flags ----

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const v = process.argv[i + 1];
  return Number.isFinite(Number(v)) && v !== '' && !v.includes(',') ? Number(v) : v;
}
function hasFlag(name) { return process.argv.includes(name); }

const CORPUS_PATH = String(flag('--corpus', 'evals/model-profile-bench.json'));
const MODELS = String(flag('--models', 'claude-opus-4-6,claude-opus-4-7')).split(',').map(s => s.trim()).filter(Boolean);
const PROFILE_NAMES = String(flag('--profiles', 'default')).split(',').map(s => s.trim()).filter(Boolean);
const CASES_LIMIT = flag('--cases', 0);
const OUT = String(flag('--out', 'evals/baseline-profile-bench.json'));
const VERBOSE = hasFlag('--verbose');

// ---- profile definitions (for Phase A this is just 'default'; Phase C adds 'tuned') ----

const PROFILE_TABLE = {
  default: { budget: 1500, framing: 'observe' },
  // 'tuned' is applied implicitly in Phase C by letting hippo auto-detect — see C1.
  // For Phase A we only run 'default'.
};

function resolveProfile(name) {
  const p = PROFILE_TABLE[name];
  if (!p) throw new Error(`Unknown profile: ${name}`);
  return p;
}

// ---- distractor generator ----
// Used for noise-rejection cases: ~10 KB of realistic-looking but irrelevant text.

const DISTRACTOR_BLOCK = `
## Release notes for unrelated library v3.14.2

This release focuses on internal refactors and does not change the public API.
Version bump driven by semver policy (breaking change in experimental namespace).
Migration guide not required for users of the stable surface.

### Changed
- Internal: reworked the token bucket rate limiter to use std::atomic counters.
- Internal: bumped minimum Rust toolchain to 1.74.0.
- Build: switched CI from GitHub Actions macOS-12 to macOS-14 runners.

### Fixed
- Edge case where the retry policy would not honor a Retry-After header when the
  header value was zero (previously treated as "no header").
- Memory leak in the mock HTTP transport when a request was aborted mid-stream.
- Flaky test in the certificate pinning suite caused by clock drift on CI hosts.

### Performance
- ~3% reduction in p99 latency for the token refresh path under sustained load.
- Memory use during steady-state operation reduced by ~18 MB per connection.

## Roadmap preview

The next minor will focus on observability: OpenTelemetry traces on every
request boundary, structured logs in JSON mode by default, and an experimental
metrics exporter for Prometheus. Feedback welcome via the discussions forum.

We are also exploring a redesign of the middleware pipeline to better support
async request-scoped state. No timeline yet — waiting for the language feature
freeze in the next stable release before committing.

## Community

Thanks to the 47 contributors who opened PRs this release. Special shoutout to
new maintainers joining the triage rotation: they've cut issue response time
from 4 days median to under 24 hours.

## Migration notes for advanced users

If you depended on the internal type \`__private::TokenBucketInner\` (exposed
accidentally in 3.13), you'll need to migrate to the public \`TokenBucket\` type.
The shape is identical; only the path changed.

If you were relying on the deprecated \`legacy_retry_strategy\` flag, it's now a
no-op. The new default strategy subsumes it in all tested workloads.

## Known issues

- On Windows with long paths (>260 chars), the certificate cache may fail to
  initialize. Workaround: set \`HTTP_CACHE_DIR\` to a short path.
- Under extreme concurrency (>10k simultaneous requests per process), we've
  observed occasional priority inversion in the scheduler. Investigation
  ongoing; mitigations documented in the wiki.

## Documentation updates

- The quickstart guide now covers mTLS setup end-to-end.
- API reference regenerated from source comments; several stale examples fixed.
- New cookbook entries on circuit breakers and bulkhead patterns.

## Acknowledgements

Funded in part by the Open Source Infrastructure Grant program. Testing
resources provided by the CloudCompute partner network. All trademarks are the
property of their respective owners.
`.repeat(12); // ~10 KB

// ---- helpers ----

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-bench-'));
}

function rmTmp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

const HIPPO_BIN = process.platform === 'win32' ? 'hippo.cmd' : 'hippo';
const CLAUDE_BIN = process.platform === 'win32' ? 'claude.cmd' : 'claude';

function hippoCall(args, env, input, cwd) {
  return execFileSync(HIPPO_BIN, args, {
    env: { ...process.env, ...env, HIPPO_DB_BUSY_TIMEOUT_MS: '5000' },
    input,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    shell: process.platform === 'win32',
    cwd, // isolated per-case dir — keeps local + global stores test-scoped
  });
}

function setupHippoStore(tmpDir, memories) {
  // Each case gets its own isolated tmpDir that serves as BOTH cwd and
  // HIPPO_HOME. This way local (.hippo under cwd) and global (HIPPO_HOME)
  // both resolve inside tmpDir, preventing leakage from the user's real
  // stores.
  try {
    hippoCall(['init', '--no-hooks', '--no-schedule', '--no-learn'], { HIPPO_HOME: tmpDir }, undefined, tmpDir);
  } catch (err) {
    // Non-fatal: init may warn if already exists.
  }
  for (const m of memories) {
    const args = ['remember', m.content];
    if (m.pinned) args.push('--pin');
    for (const tag of m.tags ?? []) args.push('--tag', tag);
    hippoCall(args, { HIPPO_HOME: tmpDir }, undefined, tmpDir);
  }
}

function getHippoContext(tmpDir, profile) {
  const out = hippoCall(
    ['context', '--auto', '--budget', String(profile.budget), '--framing', profile.framing],
    { HIPPO_HOME: tmpDir },
    undefined,
    tmpDir
  );
  return out.trim();
}

function buildPrompt(contextBlock, caseDef) {
  const isNoise = caseDef.type === 'noise-rejection';
  const distractor = isNoise ? `\n\n---\n\nIgnore the following for the question below, it is unrelated background material:\n\n${DISTRACTOR_BLOCK}\n\n---\n\n` : '\n\n';
  return `${contextBlock}${distractor}User: ${caseDef.query}\n\nAssistant:`;
}

function childEnv() {
  // Strip CLAUDECODE* vars so spawned `claude -p` doesn't refuse as a nested session.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDECODE') || k.startsWith('CLAUDE_CODE')) delete env[k];
  }
  return env;
}

function askModel(model, prompt) {
  try {
    const out = execFileSync(
      CLAUDE_BIN,
      [
        '-p',
        '--model', model,
        '--output-format', 'json',
        '--no-session-persistence',
        '--disallowed-tools', 'Bash,Edit,Write,Read,Glob,Grep,Task,WebFetch,WebSearch,NotebookEdit,TodoWrite,BashOutput,KillBash,ExitPlanMode,SlashCommand', // pure text eval — no agentic tool use
      ],
      { input: prompt, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120_000, shell: process.platform === 'win32', env: childEnv(), cwd: os.tmpdir() }
    );
    const data = JSON.parse(out);
    if (data.is_error) return { text: '', error: data.result ?? 'is_error' };
    return { text: data.result ?? '', cost: data.total_cost_usd, durationMs: data.duration_ms };
  } catch (err) {
    return { text: '', error: err.message };
  }
}

// ---- main ----

function aggregate(runs) {
  const byCell = new Map();
  for (const r of runs) {
    const key = `${r.model}|${r.profile}|${r.type}`;
    if (!byCell.has(key)) byCell.set(key, { pass: 0, fail: 0, unclear: 0, error: 0 });
    const cell = byCell.get(key);
    if (r.verdict === 'PASS') cell.pass++;
    else if (r.verdict === 'FAIL') cell.fail++;
    else if (r.verdict === 'UNCLEAR') cell.unclear++;
    else cell.error++;
  }
  return byCell;
}

function printTable(byCell) {
  console.log('\n=== Aggregate (pass-rate, N=count) ===\n');
  const cells = [...byCell.entries()].map(([k, v]) => {
    const [model, profile, type] = k.split('|');
    const n = v.pass + v.fail + v.unclear + v.error;
    const rate = n ? ((v.pass + 0.5 * v.unclear) / n * 100).toFixed(1) : '0.0';
    return { model, profile, type, rate, n, ...v };
  });
  console.log('model'.padEnd(24), 'profile'.padEnd(10), 'type'.padEnd(25), 'pass%', 'N', 'details');
  for (const c of cells.sort((a, b) => (a.model + a.profile + a.type).localeCompare(b.model + b.profile + b.type))) {
    console.log(
      c.model.padEnd(24),
      c.profile.padEnd(10),
      c.type.padEnd(25),
      c.rate.padStart(5),
      String(c.n).padStart(2),
      `P${c.pass}/F${c.fail}/U${c.unclear}/E${c.error}`
    );
  }
  console.log();
}

async function main() {
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
  let cases = corpus.cases;
  if (CASES_LIMIT && Number(CASES_LIMIT) > 0) {
    cases = cases.slice(0, Number(CASES_LIMIT));
  }

  const total = MODELS.length * PROFILE_NAMES.length * cases.length;
  console.error(`Running ${total} cells (${MODELS.length} models × ${PROFILE_NAMES.length} profiles × ${cases.length} cases)`);

  const runs = [];
  let idx = 0;

  for (const model of MODELS) {
    for (const profileName of PROFILE_NAMES) {
      const profile = resolveProfile(profileName);
      for (const c of cases) {
        idx++;
        const tmp = mkTmp();
        const started = Date.now();
        let verdict = 'ERROR';
        let response = '';
        let errorMsg = null;
        try {
          setupHippoStore(tmp, c.memories);
          const ctx = getHippoContext(tmp, profile);
          const prompt = buildPrompt(ctx, c);
          const { text, error } = askModel(model, prompt);
          if (error) {
            errorMsg = `model: ${error}`;
          } else {
            response = text;
            const j = judge(c, text);
            verdict = j.verdict;
            if (j.verdict === 'ERROR') errorMsg = `judge: ${j.raw}`;
          }
        } catch (err) {
          errorMsg = err.message;
        } finally {
          rmTmp(tmp);
        }
        const elapsed = Date.now() - started;
        runs.push({
          model, profile: profileName, case: c.id, type: c.type,
          verdict, elapsedMs: elapsed,
          error: errorMsg,
          responsePreview: response.slice(0, 200),
        });
        console.error(`[${idx}/${total}] ${model} ${profileName} ${c.id} → ${verdict} (${elapsed}ms)${errorMsg ? ' ERR: ' + errorMsg : ''}`);
        if (VERBOSE && response) console.error(`  response: ${response.slice(0, 300)}`);
      }
    }
  }

  const byCell = aggregate(runs);
  const summary = [];
  for (const [key, cell] of byCell) {
    const [model, profile, type] = key.split('|');
    const n = cell.pass + cell.fail + cell.unclear + cell.error;
    summary.push({
      model, profile, type,
      n, pass: cell.pass, fail: cell.fail, unclear: cell.unclear, error: cell.error,
      passRate: n ? (cell.pass + 0.5 * cell.unclear) / n : 0,
    });
  }

  const output = {
    corpus: CORPUS_PATH,
    timestamp: new Date().toISOString(),
    models: MODELS,
    profiles: PROFILE_NAMES,
    caseCount: cases.length,
    runs,
    summary,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
  console.error(`\nWrote ${runs.length} runs to ${OUT}`);
  printTable(byCell);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
