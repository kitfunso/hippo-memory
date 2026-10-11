#!/usr/bin/env node
/**
 * Real token usage from Claude Code's own session records, joined to what
 * hippo sent in the same sessions (ROADMAP Part IX, TE0 on a desktop).
 *
 * Claude Code writes every session to ~/.claude/projects/<project>/<session>.jsonl.
 * Each assistant message carries the usage the API billed for it:
 * input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
 * output_tokens. Subagent transcripts live in <session>/subagents/*.jsonl and
 * count towards their parent session. One API message is written as several
 * lines (one per content block) that repeat the same usage, so usage is
 * counted once per message id; summing lines would overcount.
 *
 * hippo's token ledger (`token_ledger`, schema v45) records the session id
 * from the hook payload, which is the transcript's file name, so the two join
 * exactly. hippo's numbers are estimates (characters / 4); Claude Code's are
 * the API's own counts.
 *
 * What this measures: what sessions cost, and how much of the new context
 * written in them was hippo's text. It does not measure savings; that needs
 * the paired A/B (TE5), because a session without hippo is a different
 * session.
 *
 * Run on the machine where Claude Code runs:
 *   npm run build && node scripts/token-eval/claude-usage.mjs
 *     [--projects ~/.claude/projects] [--days 30] [--hippo-root DIR ...]
 *     [--prices FILE] [--json] [--out FILE]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openHippoDb, closeHippoDb } from '../../dist/db/index.js';
import { tokensBySession } from '../../dist/store/token-ledger.js';
import { getGlobalRoot } from '../../dist/sharing/global-store.js';
import { isInitialized } from '../../dist/core/project-identity.js';
import { priceUsage, uncachedEquivalentInput } from '../../dist/eval/eval-stats.js';

const BUCKETS = [
  ['inputTokens', 'input_tokens'],
  ['cacheWriteTokens', 'cache_creation_input_tokens'],
  ['cacheReadTokens', 'cache_read_input_tokens'],
  ['outputTokens', 'output_tokens'],
];

function emptyUsage() {
  return { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
}

/**
 * Usage in one transcript file, counted once per API message id. Returns
 * the usage, message count, prompt count and first and last timestamps.
 */
export function readTranscript(file) {
  const byMessage = new Map();
  let prompts = 0;
  let first = null;
  let last = null;
  const models = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.timestamp) {
      if (first === null || o.timestamp < first) first = o.timestamp;
      if (last === null || o.timestamp > last) last = o.timestamp;
    }
    const m = o.message;
    if (o.type === 'assistant' && m && m.usage) {
      const id = m.id ?? o.uuid;
      byMessage.set(id, m.usage);
      if (m.model) models.add(m.model);
    } else if (o.type === 'user' && m && m.content !== undefined && m.content !== null && m.content.constructor === String && !o.isMeta) {
      prompts++;
    }
  }
  const usage = emptyUsage();
  for (const u of byMessage.values()) {
    for (const [ours, theirs] of BUCKETS) {
      const v = Number(u[theirs]);
      if (Number.isFinite(v)) usage[ours] += v;
    }
  }
  return { usage, messages: byMessage.size, prompts, first, last, models: [...models] };
}

/** Every session under a Claude Code projects directory, with subagents folded in. */
export function readProjects(projectsDir) {
  const sessions = [];
  if (!fs.existsSync(projectsDir)) return sessions;
  for (const project of fs.readdirSync(projectsDir)) {
    const pdir = path.join(projectsDir, project);
    if (!fs.statSync(pdir).isDirectory()) continue;
    for (const f of fs.readdirSync(pdir)) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.slice(0, -'.jsonl'.length);
      const main = readTranscript(path.join(pdir, f));
      const subDir = path.join(pdir, sessionId, 'subagents');
      const subs = fs.existsSync(subDir)
        ? fs.readdirSync(subDir).filter((x) => x.endsWith('.jsonl')).map((x) => readTranscript(path.join(subDir, x)))
        : [];
      const usage = emptyUsage();
      for (const t of [main, ...subs]) for (const [k] of BUCKETS) usage[k] += t.usage[k];
      sessions.push({
        project,
        sessionId,
        first: main.first,
        last: [main.last, ...subs.map((s) => s.last)].filter(Boolean).sort().pop() ?? null,
        prompts: main.prompts,
        messages: main.messages + subs.reduce((s, x) => s + x.messages, 0),
        subagents: subs.length,
        models: [...new Set([main, ...subs].flatMap((t) => t.models))],
        usage,
      });
    }
  }
  return sessions;
}

/** hippo ledger totals per session id from every store given. */
export function readLedger(hippoRoots, tenantId, sinceIso) {
  const bySession = new Map();
  for (const root of hippoRoots) {
    if (!isInitialized(root)) continue;
    const db = openHippoDb(root);
    try {
      for (const row of tokensBySession(db, tenantId, sinceIso)) {
        const prev = bySession.get(row.sessionId) ?? { sent: 0, skipped: 0, injections: 0 };
        bySession.set(row.sessionId, {
          sent: prev.sent + row.sent,
          skipped: prev.skipped + row.skipped,
          injections: prev.injections + row.injections,
        });
      }
    } catch {
      // A store older than schema v45 has no ledger; it contributes nothing.
    } finally {
      closeHippoDb(db);
    }
  }
  return bySession;
}

/** Join sessions to the ledger and total them. */
export function report(sessions, ledger, prices = null) {
  const rows = sessions.map((s) => {
    const h = ledger.get(s.sessionId) ?? null;
    return {
      ...s,
      uncachedEquivalentInput: Math.round(uncachedEquivalentInput(s.usage)),
      usd: prices ? priceUsage(s.usage, prices) : null,
      hippo: h,
      // Each hippo block enters the conversation as new context once, so
      // compare it with the new context written (cache writes + uncached input).
      hippoShareOfNewContext: h && s.usage.cacheWriteTokens + s.usage.inputTokens > 0
        ? h.sent / (s.usage.cacheWriteTokens + s.usage.inputTokens)
        : null,
    };
  });
  const total = emptyUsage();
  for (const r of rows) for (const [k] of BUCKETS) total[k] += r.usage[k];
  const withHippo = rows.filter((r) => r.hippo);
  return {
    sessions: rows.length,
    sessionsWithHippoRecords: withHippo.length,
    total,
    totalUsd: prices ? rows.reduce((s, r) => s + r.usd, 0) : null,
    hippoSent: withHippo.reduce((s, r) => s + r.hippo.sent, 0),
    hippoSkipped: withHippo.reduce((s, r) => s + r.hippo.skipped, 0),
    rows,
  };
}

function main() {
  const argv = process.argv;
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const projectsDir = flag('--projects', path.join(os.homedir(), '.claude', 'projects'));
  const days = Number(flag('--days', '30'));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const hippoRoots = [];
  argv.forEach((a, i) => { if (a === '--hippo-root' && argv[i + 1]) hippoRoots.push(argv[i + 1]); });
  if (hippoRoots.length === 0) hippoRoots.push(getGlobalRoot());
  const pricesFile = flag('--prices', null);
  const prices = pricesFile ? JSON.parse(fs.readFileSync(pricesFile, 'utf8')) : null;

  const sessions = readProjects(projectsDir).filter((s) => s.last && s.last >= since);
  const result = report(sessions, readLedger(hippoRoots, process.env.HIPPO_TENANT || 'default', since), prices);
  const out = {
    meta: {
      harness: 'scripts/token-eval/claude-usage.mjs',
      generatedAt: new Date().toISOString(),
      projectsDir,
      since,
      hippoRoots,
      source: 'Claude Code transcripts (API usage per message, deduplicated by message id) joined to hippo token_ledger by session id',
    },
    ...result,
  };
  const outFile = flag('--out', null);
  if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const n = (x) => x.toLocaleString('en-GB');
  console.log(`Claude Code usage, last ${days} days, ${result.sessions} sessions (${result.sessionsWithHippoRecords} with hippo ledger rows)\n`);
  console.log(`  uncached input  ${n(result.total.inputTokens)}`);
  console.log(`  cache writes    ${n(result.total.cacheWriteTokens)}`);
  console.log(`  cache reads     ${n(result.total.cacheReadTokens)}`);
  console.log(`  output          ${n(result.total.outputTokens)}`);
  if (result.totalUsd !== null) console.log(`  cost at the given prices: $${result.totalUsd.toFixed(2)}`);
  console.log(`\n  hippo sent ${n(result.hippoSent)} tokens (estimated) and skipped ${n(result.hippoSkipped)} as unchanged.`);
  const top = [...result.rows].sort((a, b) => b.usage.cacheReadTokens - a.usage.cacheReadTokens).slice(0, 10);
  console.log('\n  largest sessions by cache reads:');
  for (const r of top) {
    const share = r.hippoShareOfNewContext === null ? 'no hippo rows' : `hippo ${(r.hippoShareOfNewContext * 100).toFixed(2)}% of new context`;
    console.log(`  ${r.sessionId.slice(0, 8)} ${r.project.slice(0, 40).padEnd(40)} reads ${n(r.usage.cacheReadTokens).padStart(13)}  writes ${n(r.usage.cacheWriteTokens).padStart(11)}  ${share}`);
  }
  if (outFile) console.log(`\nWrote ${outFile}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
