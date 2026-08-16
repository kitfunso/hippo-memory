/**
 * Trap Detection Test: Repeated Mistake Harness
 *
 * Simulates what happens when an agent works on code WITH and WITHOUT Hippo memory.
 * For each trap in trap-definitions.json, we check:
 *   - Does `hippo recall <query>` return the memory that would prevent it?
 *
 * Score:
 *   WITH memory:    traps_caught / total_traps (should be high)
 *   WITHOUT memory: 0 / total_traps (baseline — no memory = guaranteed mistakes)
 *
 * This does NOT run an LLM. It tests the retrieval system's ability to surface
 * the correct preventive memory when given a task-related query.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createMemory,
  type MemoryEntry,
} from '../src/memory.js';
import {
  initStore,
  writeEntry,
  loadAllEntries,
} from '../src/store.js';
import { search } from '../src/search.js';

// ---------------------------------------------------------------------------
// Load trap definitions
// ---------------------------------------------------------------------------

const TRAP_DEFS_PATH = path.join(__dirname, 'traps', 'trap-definitions.json');

interface TrapDefinition {
  id: string;
  file: string;
  line: number;
  description: string;
  code_snippet: string;
  memory_label: string;
  memory_id: string;
  recall_query: string;
}

// SAFETY: trap-definitions.json is this repo's own fixture file, hand-
// authored to match the TrapDefinition shape declared above.
const trapDefs: TrapDefinition[] = JSON.parse(
  fs.readFileSync(TRAP_DEFS_PATH, 'utf8')
).traps as TrapDefinition[];

// ---------------------------------------------------------------------------
// Setup: seed the store with the exact memories that prevent each trap
// ---------------------------------------------------------------------------

let tmpDir: string;
const memoryStore: Record<string, MemoryEntry> = {};

/** Seed memories that map to the trap prevention IDs */
function seedTrapMemories(hippoRoot: string): void {
  const memories: Array<{ label: string; id: string; content: string; opts: Parameters<typeof createMemory>[1] }> = [
    {
      label: 'never_overwrite',
      id: 'bm_never_overwrite',
      content: `NEVER overwrite existing production files. When improving a model:
1. Create a new versioned file (e.g. brent_production_v5.py)
2. Keep the original intact
3. Let Keith decide when to promote/replace
Violating this destroys live PnL history and cannot be undone from git blame alone.`,
      opts: { tags: ['production', 'rule', 'deploy', 'overwrite'], emotional_valence: 'critical', pinned: true },
    },
    {
      label: 'eia_path_change',
      id: 'bm_eia_path_change',
      content: `EIA API path changed silently. /petroleum/sum/wkly became /petroleum/sum/sndw.
This broke 9 of 10 EIA series silently because exceptions were swallowed with bare except: pass.
Always log failed API calls, don't just pass. Bare except is a data-pipeline anti-pattern.`,
      opts: { tags: ['data-pipeline', 'eia', 'api', 'error', 'exception'], emotional_valence: 'negative' },
    },
    {
      label: 'no_emoji_python',
      id: 'bm_no_emoji_python',
      content: `No emoji in Python print statements on Windows. cp1252 encoding crashes on emoji characters.
Example crash: print("✅ Success!"). Use plain ASCII instead: print("OK") or print("[OK]").
Affects all Windows Python scripts including pipeline status scripts.`,
      opts: { tags: ['platform', 'windows', 'encoding', 'emoji', 'print', 'crash'], emotional_valence: 'negative' },
    },
    {
      label: 'powershell_semicolons',
      id: 'bm_powershell_semicolons',
      content: `PowerShell uses semicolons not && to chain commands.
Correct: npm run build; npx wrangler deploy
Wrong:   npm run build && npx wrangler deploy
The && operator is bash syntax and causes silent failure in PowerShell. Use ; instead.`,
      opts: { tags: ['platform', 'powershell', 'windows', 'shell', 'operator'], emotional_valence: 'negative' },
    },
    {
      label: 'walk_forward_overestimates',
      id: 'bm_walk_forward_overestimates',
      content: `Walk-forward OOS Sharpe overestimates true performance by ~50%. CPCV experiment
(Exp 7) showed walk-forward OOS Sharpe overestimates by +0.59 on average (mean WF=1.15 vs CPCV=0.56).
Use CPCV-deflated Sharpe for risk management and honest reporting. Never report raw walk-forward
Sharpe as the final OOS number without this caveat.`,
      opts: { tags: ['quant', 'backtest', 'sharpe', 'cpcv', 'walk-forward', 'oos'], emotional_valence: 'negative' },
    },
    {
      label: 'constants_must_sync',
      id: 'bm_constants_must_sync',
      content: `Frontend and backend trading constants must stay in sync.
Shared constants: production/shared_constants.py <-> website/frontend/src/lib/trading-constants.ts
Any change to RISK_PER_TRADE, position sizing, or signal thresholds must be updated in BOTH files.
Mismatch causes silent wrong position sizing on the frontend dashboard.`,
      opts: { tags: ['frontend', 'backend', 'constants', 'sync', 'risk', 'position-sizing'], emotional_valence: 'negative' },
    },
    {
      label: 'subagent_slop_words',
      id: 'bm_subagent_slop_words',
      content: `Sub-agents produce AI slop words that must be removed before deploying.
Common offenders: comprehensive, robust, leverage, harness, tapestry, landscape, compelling.
Always review sub-agent text output for these before deploying. Words like "comprehensive solution"
and "robust framework" signal AI-generated copy that needs human editing.`,
      opts: { tags: ['sub-agent', 'review', 'copywriting', 'slop', 'agent-output'] },
    },
    {
      label: 'staleness_hides_ok',
      id: 'bm_staleness_hides_ok',
      content: `Data source staleness can hide behind "OK" exit codes. Daily cache refresh
reported "14/14 OK" while 5+ sources were silently stale (WB date format change, DBnomics
stuck at 2023, IndexMundi SSL expired, EIA path change). Don't trust exit code alone.
Always verify actual file modification times and spot-check data values.`,
      opts: { tags: ['data-pipeline', 'staleness', 'monitoring', 'exit-code', 'cache'], emotional_valence: 'negative' },
    },
    {
      label: 'data_mining_honesty',
      id: 'bm_data_mining_honesty',
      content: `Data mining honesty: selecting features by testing on ALL data, then reporting
results as "OOS" is data mining. The reported Sharpe (1.74) is inflated; honest results
(theory-only features) give ~0.87. Fix: select features based on economic theory only,
OR select on early data, freeze selection, then test on later data. Never iterate based
on backtest results.`,
      opts: { tags: ['quant', 'data-mining', 'feature-selection', 'backtest', 'oos'], emotional_valence: 'negative' },
    },
    {
      label: 'subagent_fabrication',
      id: 'bm_subagent_fabrication',
      content: `Always verify sub-agent model metrics before accepting. Natgas V3
(commit b99c890) claimed Min Sharpe 0.99 -> 1.60 (+62%). Actual CV=-0.73. The commit message
and PRODUCTION_MANIFEST were both falsified. Always run:
  python production/{commodity}_production_std.py
and compare actual output to claimed metrics before accepting any model upgrade.`,
      opts: { tags: ['sub-agent', 'verification', 'metrics', 'fabrication', 'manifest'], emotional_valence: 'critical' },
    },
  ];

  for (const m of memories) {
    const entry = createMemory(m.content, m.opts);
    const withId: MemoryEntry = { ...entry, id: m.id };
    writeEntry(hippoRoot, withId);
    memoryStore[m.label] = withId;
  }
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-traps-'));
  initStore(tmpDir);
  seedTrapMemories(tmpDir);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: query the store and check if the expected memory appears
// ---------------------------------------------------------------------------

function recallTop(query: string, n = 5): string[] {
  const entries = loadAllEntries(tmpDir);
  const results = search(query, entries, { budget: 8000 });
  return results.slice(0, n).map((r) => r.entry.id);
}

function trapCaught(trap: TrapDefinition): boolean {
  const topIds = recallTop(trap.recall_query);
  return topIds.includes(trap.memory_id);
}

// ---------------------------------------------------------------------------
// Trap file content assertions (static code review — no LLM needed)
// ---------------------------------------------------------------------------

describe('Trap repo files contain expected issues', () => {
  const repoDir = path.join(__dirname, 'traps', 'trap-repo', 'src');

  it('deploy.py has direct shutil.copy overwrite', () => {
    const code = fs.readFileSync(path.join(repoDir, 'deploy.py'), 'utf8');
    expect(code).toContain('shutil.copy(new_model, "production/gold_production.py")');
  });

  it('data_refresh.py has bare except: pass', () => {
    const code = fs.readFileSync(path.join(repoDir, 'data_refresh.py'), 'utf8');
    expect(code).toMatch(/except\s*:/);  // bare except
    expect(code).toContain('pass');
  });

  it('print_status.py has emoji in print statements', () => {
    const code = fs.readFileSync(path.join(repoDir, 'print_status.py'), 'utf8');
    expect(code).toContain('✅');
  });

  it('build.ps1 uses && instead of ;', () => {
    const code = fs.readFileSync(path.join(repoDir, 'build.ps1'), 'utf8');
    expect(code).toContain('&&');
  });

  it('model.py reports walk-forward Sharpe as OOS without calling the right method', () => {
    const code = fs.readFileSync(path.join(repoDir, 'model.py'), 'utf8');
    // The file prints OOS Sharpe...
    expect(code).toContain('OOS Sharpe:');
    // ...but the function that produces it is walk_forward_sharpe, not a CPCV function
    expect(code).toContain('walk_forward_sharpe');
    // There is no function call to any cpcv routine in the production path
    expect(code).not.toContain('cpcv_sharpe(');
    expect(code).not.toContain('combinatorial_purged(');
  });

  it('config.ts has RISK_PER_TRADE mismatch (0.02 vs 0.015)', () => {
    const code = fs.readFileSync(path.join(repoDir, 'config.ts'), 'utf8');
    expect(code).toContain('RISK_PER_TRADE = 0.02');
    expect(code).toContain('0.015');  // commented reference to the correct value
  });

  it('agent_output.py contains slop words', () => {
    const code = fs.readFileSync(path.join(repoDir, 'agent_output.py'), 'utf8');
    expect(code).toContain('comprehensive');
    expect(code).toContain('robust');
    expect(code.toLowerCase()).toContain('leverage');
  });

  it('cache_check.py trusts exit code without staleness check', () => {
    const code = fs.readFileSync(path.join(repoDir, 'cache_check.py'), 'utf8');
    expect(code).toContain('if exit_code == 0');
    expect(code).toContain('print("All OK")');
  });

  it('feature_eng.py tests features on full dataset', () => {
    const code = fs.readFileSync(path.join(repoDir, 'feature_eng.py'), 'utf8');
    expect(code).toContain('OOS results');
    // The function selects on X (full), not X_train
    expect(code).toContain('def select_features_data_mining');
  });

  it('model_upgrade.py claims improvement without verification', () => {
    const code = fs.readFileSync(path.join(repoDir, 'model_upgrade.py'), 'utf8');
    expect(code).toContain('1.60');
    expect(code).toContain('unverified claim');
  });
});

// ---------------------------------------------------------------------------
// Memory recall tests: does hippo surface the right memory for each trap?
// ---------------------------------------------------------------------------

describe('Memory recall catches traps (with memory)', () => {
  let caughtCount = 0;
  const results: Array<{ trap: string; caught: boolean; query: string; topIds: string[] }> = [];

  for (const trap of trapDefs) {
    it(`trap: ${trap.id} — "${trap.description.slice(0, 60)}..."`, () => {
      const topIds = recallTop(trap.recall_query);
      const caught = topIds.includes(trap.memory_id);

      results.push({ trap: trap.id, caught, query: trap.recall_query, topIds });
      if (caught) caughtCount++;

      // Soft assertion: log result even on failure for diagnostics
      if (!caught) {
        console.warn(
          `  MISSED trap: ${trap.id}\n` +
          `  Query: "${trap.recall_query}"\n` +
          `  Expected: ${trap.memory_id}\n` +
          `  Got top-5: ${topIds.join(', ')}`
        );
      }

      // Each trap should be caught (correct memory in top-5)
      expect(caught, `Trap ${trap.id} not caught. Memory "${trap.memory_id}" not in top-5 for query "${trap.recall_query}"`).toBe(true);
    });
  }
});

describe('Baseline without memory', () => {
  it('without memory search returns 0 results (empty store)', () => {
    // Create a fresh empty store to simulate no memory
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-empty-'));
    initStore(emptyDir);

    try {
      const entries = loadAllEntries(emptyDir);
      const results = search('deploying model to production overwrite file', entries, { budget: 8000 });
      // No memories -> no results -> agent has no guidance
      expect(results.length).toBe(0);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('score without memory: 0/10 traps caught', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-empty2-'));
    initStore(emptyDir);

    let caughtWithout = 0;
    try {
      for (const trap of trapDefs) {
        const entries = loadAllEntries(emptyDir);
        const topIds = search(trap.recall_query, entries, { budget: 8000 })
          .slice(0, 5)
          .map((r) => r.entry.id);
        if (topIds.includes(trap.memory_id)) caughtWithout++;
      }
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }

    expect(caughtWithout).toBe(0);
    console.log(`\n  Traps caught WITHOUT memory: ${caughtWithout}/${trapDefs.length}`);
  });
});

describe('Trap detection score summary', () => {
  it('catches >= 80% of traps with memory loaded', () => {
    let caught = 0;
    for (const trap of trapDefs) {
      if (trapCaught(trap)) caught++;
    }

    const score = caught / trapDefs.length;
    console.log(`\n  ── Trap Detection Summary ─────────────────────────`);
    console.log(`  Traps defined:        ${trapDefs.length}`);
    console.log(`  Caught (with memory): ${caught}`);
    console.log(`  Score:                ${(score * 100).toFixed(0)}%`);
    console.log(`  Baseline (no memory): 0%`);
    console.log(`  ───────────────────────────────────────────────────`);

    expect(score, `Only caught ${caught}/${trapDefs.length} traps (${(score * 100).toFixed(0)}%)`).toBeGreaterThanOrEqual(0.8);
  });
});
