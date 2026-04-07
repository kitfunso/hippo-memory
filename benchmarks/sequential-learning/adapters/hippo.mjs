/**
 * Hippo Memory Adapter
 *
 * Uses the hippo CLI via subprocess calls for full isolation.
 * Creates a temporary directory, sets HOME/USERPROFILE to it so the
 * global store (~/.hippo) is also isolated from the user's real store.
 *
 * Requires: hippo CLI on PATH (npm link or global install)
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAdapter } from './interface.mjs';

/**
 * Run a hippo CLI command in the temp store directory.
 * HOME/USERPROFILE are overridden to isolate from the user's global store.
 * Returns stdout as a string, or null on failure.
 */
function hippoExec(storeDir, args) {
  try {
    const result = execSync(`hippo ${args}`, {
      cwd: storeDir,
      env: {
        ...process.env,
        // Override home directory so getGlobalRoot() points into our temp dir
        HOME: storeDir,
        USERPROFILE: storeDir,
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

  async cleanup() {
    if (this._storeDir && existsSync(this._storeDir)) {
      rmSync(this._storeDir, { recursive: true, force: true });
    }
    this._storeDir = null;
  },
});
