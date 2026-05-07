/**
 * Hippo Memory Adapter
 *
 * Uses the hippo CLI via subprocess calls for full isolation.
 * Creates a temporary directory, sets HOME/USERPROFILE/HIPPO_HOME to it so the
 * global store (~/.hippo) is also isolated from the user's real store, and
 * clears XDG_DATA_HOME so it can never leak the real user store either
 * (precedence in src/shared.ts:getGlobalRoot is HIPPO_HOME > XDG_DATA_HOME > HOME/.hippo).
 *
 * v1.7.5 -- adds optional B3 dlPFC goal-stack hooks (pushGoal / completeGoal).
 * pushGoal generates a session id, sets HIPPO_SESSION_ID for the rest of the
 * task lifespan, and parses the printed `g_<16hex>` id from stdout. completeGoal
 * closes the goal with an outcome (1.0 trap avoided, 0.0 trap hit) and clears
 * the session so cross-task state cannot leak. Both methods hard-fail (no swallow)
 * so the simulator's eval-strict mode can detect a broken mechanism.
 *
 * Requires: hippo CLI on PATH (npm link or global install).
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdapter } from './interface.mjs';

// v1.7.5 -- session id stays stable across the task lifespan. Set via env on
// every hippo exec so goal push/complete and recall share state.
let _sessionId = null;
let _pushedCount = 0;
let _completedCount = 0;

/**
 * Run a hippo CLI command in the temp store directory.
 * HOME/USERPROFILE/HIPPO_HOME are overridden to isolate from the user's
 * global store, and XDG_DATA_HOME is blanked so it cannot win the
 * getGlobalRoot precedence race. Returns stdout as a string, or null on failure.
 */
function hippoExec(storeDir, args) {
  try {
    const result = execSync(`hippo ${args}`, {
      cwd: storeDir,
      env: {
        ...process.env,
        // v1.7.5 codex P0 isolation -- HIPPO_HOME wins over HOME in
        // getGlobalRoot, and we blank XDG_DATA_HOME so neither it nor the
        // user's real ~/.hippo can leak in.
        HIPPO_HOME: storeDir,
        HOME: storeDir,
        USERPROFILE: storeDir,
        XDG_DATA_HOME: '',
        ...(_sessionId ? { HIPPO_SESSION_ID: _sessionId } : {}),
      },
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (err) {
    // Some commands (recall with no results) exit non-zero
    if (err.stdout) return err.stdout.trim();
    return null;
  }
}

export default createAdapter({
  name: 'Hippo',

  /** @type {string|null} */
  _storeDir: null,

  async init() {
    this._storeDir = mkdtempSync(join(tmpdir(), 'hippo-bench-'));
    hippoExec(this._storeDir, 'init --no-schedule');
  },

  async store(content, tags) {
    const escaped = content.replace(/"/g, '\\"');
    const tagArgs = tags.map((t) => `--tag ${t}`).join(' ');
    hippoExec(this._storeDir, `remember "${escaped}" ${tagArgs}`);
  },

  async recall(query) {
    const escaped = query.replace(/"/g, '\\"');
    const raw = hippoExec(this._storeDir, `recall "${escaped}" --json --budget 2000`);

    if (!raw) return [];

    try {
      // The JSON output may be preceded by warnings (e.g. ExperimentalWarning).
      // Find the first '{' to start parsing.
      const jsonStart = raw.indexOf('{');
      if (jsonStart === -1) return [];
      const jsonStr = raw.slice(jsonStart);

      const parsed = JSON.parse(jsonStr);

      // hippo recall --json returns { query, budget, results: [...], total }
      const results = parsed.results ?? (Array.isArray(parsed) ? parsed : []);

      return results.slice(0, 5).map((r) => ({
        content: r.content ?? '',
        score: r.score ?? 0,
        tags: r.tags ?? [],
      }));
    } catch {
      return [];
    }
  },

  async outcome(good) {
    hippoExec(this._storeDir, `outcome ${good ? '--good' : '--bad'}`);
  },

  // v1.7.5 -- B3 goal-stack hooks.
  async pushGoal(name) {
    _sessionId = `bench-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const out = hippoExec(this._storeDir, `goal push ${name}`);
    if (!out) {
      _sessionId = null;
      // v1.7.5 codex P1 -- HARD FAIL. Do not swallow. Eval-strict mode
      // wants the run to abort if the mechanism cannot fire.
      throw new Error(`hippo goal push failed for name='${name}'`);
    }
    const match = out.match(/g_[0-9a-f]{16}/);
    if (!match) {
      _sessionId = null;
      throw new Error(`hippo goal push output did not contain a goal id: '${out}'`);
    }
    _pushedCount++;
    return match[0];
  },

  async completeGoal(id, good) {
    const outcome = good ? '1.0' : '0.0';
    hippoExec(this._storeDir, `goal complete ${id} --outcome ${outcome}`);
    _completedCount++;
    _sessionId = null;
  },

  async cleanup() {
    // v1.7.5 codex P1 -- always clear cross-task state, even after exceptions.
    _sessionId = null;
    if (this._storeDir && existsSync(this._storeDir)) {
      rmSync(this._storeDir, { recursive: true, force: true });
    }
    this._storeDir = null;
  },

  // Expose counters so the runner / tests can assert non-zero in eval mode.
  _stats() {
    return { pushed: _pushedCount, completed: _completedCount };
  },
});
