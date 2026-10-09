#!/usr/bin/env node
/**
 * Session replay harness (ROADMAP Part IX, TE4).
 *
 * Replays recorded or synthetic agent sessions through hippo's real
 * per-prompt hook (`hippo context --pinned-only --include-recent 5
 * --format additional-context`, the command `hippo hook install
 * claude-code` registers) and measures what hippo itself adds to the
 * agent's context. No LLM is called, so it is deterministic and cheap enough
 * to gate CI.
 *
 * Arms:
 *   every-turn      `pinnedInject.skipUnchanged: false`, the behaviour before TE2
 *   skip-unchanged  the default: skip a block the session already has
 *
 * Per arm it reports tokens injected, how often an unchanged block rendered
 * byte-identically (TE1), and a cache-priced cost of hippo's text in
 * uncached-equivalent tokens: each injected block is written to the prompt
 * cache once (1.25x) and re-read on every later prompt (0.1x) until a
 * compaction drops it. It prices only hippo's text, not the whole
 * conversation.
 *
 * A trace is JSON: { name, description, synthetic, pinned: string[],
 * events: [{type:'prompt'} | {type:'remember', text} | {type:'compact'}] }.
 * Bundled traces live in benchmarks/token-eval/traces/ and are synthetic.
 *
 * Run: npm run build && node scripts/token-eval/replay.mjs
 *      [--traces DIR] [--out FILE]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createMemory, Layer } from '../../dist/memory.js';
import { initStore } from '../../dist/store/open.js';
import { writeEntry } from '../../dist/store/entry-writes.js';
import { estimateTokens } from '../../dist/token-ledger.js';
import { uncachedEquivalentInput, DEFAULT_CACHE_RATIOS } from '../../dist/eval/eval-stats.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const HIPPO_JS = path.join(REPO, 'bin', 'hippo.js');

export const ARMS = ['every-turn', 'skip-unchanged'];
const HOOK_ARGS = ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'];

function runCli(workDir, args, stdin) {
  const env = { ...process.env, HIPPO_HOME: path.join(workDir, 'global') };
  delete env.HIPPO_SESSION_ID;
  delete env.CLAUDE_CODE_SESSION_ID;
  return execFileSync(process.execPath, [HIPPO_JS, ...args], {
    cwd: workDir, env, encoding: 'utf8', input: stdin ?? '', stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Replay one trace in one arm in a fresh store. Returns per-arm metrics and
 * the per-prompt injected token counts.
 */
export function replayTrace(trace, arm) {
  if (!ARMS.includes(arm)) throw new Error(`unknown arm ${arm}`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-replay-'));
  const hippoRoot = path.join(workDir, '.hippo');
  try {
    initStore(hippoRoot);
    // Traces carry no prompt text, so prompt recall (default on since 1.55.0) would never fire.
    const pinnedInject = { promptRecall: false };
    if (arm === 'every-turn') pinnedInject.skipUnchanged = false;
    fs.writeFileSync(path.join(hippoRoot, 'config.json'), JSON.stringify({ pinnedInject }));
    for (const text of trace.pinned ?? []) {
      writeEntry(hippoRoot, createMemory(text, { pinned: true, layer: Layer.Episodic }));
    }
    const sessionId = `replay-${trace.name}`;
    const payload = JSON.stringify({ session_id: sessionId, prompt: 'next step' });

    const perPrompt = [];
    let active = [];
    let cacheWriteTokens = 0;
    let cacheReadTokens = 0;
    let prevBlock = null;
    let changedSincePrev = true;
    let unchangedOpportunities = 0;
    let unchangedIdentical = 0;

    for (const ev of trace.events) {
      if (ev.type === 'remember') {
        writeEntry(hippoRoot, createMemory(ev.text, { layer: Layer.Episodic }));
        changedSincePrev = true;
      } else if (ev.type === 'compact') {
        runCli(workDir, ['compact-resume'], JSON.stringify({ session_id: sessionId, source: 'compact' }));
        active = [];
        changedSincePrev = true;
      } else if (ev.type === 'prompt') {
        // Everything injected earlier is re-read from the cache on this prompt.
        cacheReadTokens += active.reduce((s, k) => s + k, 0);
        const out = runCli(workDir, HOOK_ARGS, payload).trim();
        let block = '';
        if (out) block = JSON.parse(out).hookSpecificOutput.additionalContext;
        const k = block ? estimateTokens(block) : 0;
        perPrompt.push(k);
        if (k > 0) {
          cacheWriteTokens += k;
          active.push(k);
          if (prevBlock !== null && !changedSincePrev) {
            unchangedOpportunities++;
            if (block === prevBlock) unchangedIdentical++;
          }
          prevBlock = block;
          changedSincePrev = false;
        }
      } else {
        throw new Error(`unknown event type ${ev.type}`);
      }
    }
    const usage = { inputTokens: 0, cacheWriteTokens, cacheReadTokens, outputTokens: 0 };
    return {
      trace: trace.name,
      arm,
      prompts: perPrompt.length,
      injections: perPrompt.filter((k) => k > 0).length,
      injectedTokens: cacheWriteTokens,
      cacheReadTokens,
      uncachedEquivalent: Math.round(uncachedEquivalentInput(usage, DEFAULT_CACHE_RATIOS)),
      // TE1: share of unchanged-memory re-renders that were byte-identical.
      // Measured in the every-turn arm, where every prompt renders.
      identicalWhenUnchanged: unchangedOpportunities === 0 ? null : unchangedIdentical / unchangedOpportunities,
      perPrompt,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Replay every trace in every arm and compare. */
export function replayAll(traces) {
  const rows = [];
  for (const trace of traces) {
    for (const arm of ARMS) rows.push(replayTrace(trace, arm));
  }
  const byTrace = traces.map((t) => {
    const base = rows.find((r) => r.trace === t.name && r.arm === 'every-turn');
    const skip = rows.find((r) => r.trace === t.name && r.arm === 'skip-unchanged');
    return {
      trace: t.name,
      description: t.description,
      synthetic: t.synthetic === true,
      prompts: base.prompts,
      everyTurn: { injections: base.injections, injectedTokens: base.injectedTokens, uncachedEquivalent: base.uncachedEquivalent },
      skipUnchanged: { injections: skip.injections, injectedTokens: skip.injectedTokens, uncachedEquivalent: skip.uncachedEquivalent },
      injectedReduction: base.injectedTokens === 0 ? 0 : 1 - skip.injectedTokens / base.injectedTokens,
      costReduction: base.uncachedEquivalent === 0 ? 0 : 1 - skip.uncachedEquivalent / base.uncachedEquivalent,
      identicalWhenUnchanged: base.identicalWhenUnchanged,
    };
  });
  return { rows, byTrace };
}

function loadTraces(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function main() {
  const flag = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
  };
  const tracesDir = flag('--traces', path.join(REPO, 'benchmarks', 'token-eval', 'traces'));
  const outFile = flag('--out', path.join(REPO, 'benchmarks', 'token-eval', 'replay-results.json'));
  const traces = loadTraces(tracesDir);
  const t0 = Date.now();
  const result = replayAll(traces);
  const out = {
    meta: {
      harness: 'scripts/token-eval/replay.mjs',
      generatedAt: new Date().toISOString(),
      cacheRatios: DEFAULT_CACHE_RATIOS,
      tokenEstimate: 'characters / 4',
      note: 'Prices only the text hippo injects, not the whole conversation. Bundled traces are synthetic.',
    },
    byTrace: result.byTrace,
    rows: result.rows.map(({ perPrompt, ...rest }) => ({ ...rest, perPrompt })),
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Session replay (${((Date.now() - t0) / 1000).toFixed(1)}s), cost in uncached-equivalent tokens\n`);
  for (const r of result.byTrace) {
    console.log(`${r.trace} (${r.prompts} prompts): every-turn ${r.everyTurn.injectedTokens} tok injected / ${r.everyTurn.uncachedEquivalent} cost; `
      + `skip-unchanged ${r.skipUnchanged.injectedTokens} / ${r.skipUnchanged.uncachedEquivalent}; `
      + `injected -${pct(r.injectedReduction)}, cost -${pct(r.costReduction)}, `
      + `identical when unchanged ${r.identicalWhenUnchanged === null ? 'n/a' : pct(r.identicalWhenUnchanged)}`);
  }
  console.log(`\nWrote ${path.relative(REPO, outFile)}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
