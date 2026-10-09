#!/usr/bin/env node
// Z1 prompt-recall replay: docs/plans/2026-09-26-z1-prompt-recall.md, prereg in docs/evals/.
// Prints AGGREGATE NUMBERS ONLY: never transcript, prompt, error or memory text.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'dist');
const distImport = (f) => import(pathToFileURL(path.join(DIST, f)).href);
const { textOverlap } = await distImport('util/tokenize.js');
const [{ estimateTokens, blockHash }, { shouldSkipUnchanged }] = await Promise.all([distImport('util/token-text.js'), distImport('store/token-ledger.js')]);
const { isWorthSurfacing } = await distImport('core/memory-quality.js');
const { ambientSecretAdmit } = await distImport('api/index.js');
const { resolveProjectIdentity, classifyOriginProject } = await distImport('core/project-identity.js');
const { passesScopeFilterForRecall } = await distImport('store/recall-scope.js');
const { contentTokens, promptTokens, gatePromptRecall, scoreOverlap } = await distImport('core/prompt-recall.js');

const PIN_BUDGET = 1500;
const REFRESH_TURNS = 10;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { store: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') out.corpus = argv[++i];
    else if (a === '--global') out.global = argv[++i];
    else if (a === '--store') out.store.push(argv[++i]);
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--split') out.split = argv[++i];
    else if (a === '--arm') out.arm = argv[++i];
    else if (a === '--judge-out') out.judgeOut = argv[++i];
    else if (a === '--since') out.since = argv[++i];
  }
  if (!out.arm) out.arm = 'z1';
  return out;
}

// Z1b tool-failure block: same LEADING_CD as src/capture/failure-reading.ts, its cd-stripping is query-only here.
const LEADING_CD = /^\s*(?:(?:cd|pushd)\b[^;&|]*(?:&&|\|\||;)\s*)+/;

// ---------------------------------------------------------------------------
// Store loading (read-only, tenant 'default' only)
// ---------------------------------------------------------------------------

function loadStore(dir) {
  const db = new DatabaseSync(path.join(dir, 'hippo.db'), { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, content, tags_json, created, pinned, superseded_by, origin_project, scope,
                source, confidence, extracted_from, dag_level
         FROM memories WHERE tenant_id = ?`,
      )
      .all('default');
    return rows.map((r) => ({
      id: String(r.id),
      content: String(r.content),
      tags: safeParseTags(r.tags_json),
      created: String(r.created),
      pinned: Boolean(r.pinned),
      superseded_by: r.superseded_by ?? null,
      origin_project: r.origin_project ?? null,
      scope: r.scope ?? null,
      // isWorthSurfacing judges by provenance, so without these every row would get a person's looser floor.
      source: String(r.source ?? ''),
      confidence: r.confidence ?? null,
      extracted_from: r.extracted_from ?? null,
      dag_level: Number(r.dag_level ?? 0),
    }));
  } finally {
    db.close();
  }
}

function safeParseTags(json) {
  try {
    const v = JSON.parse(String(json ?? '[]'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// ---------------------------------------------------------------------------
// admit: not superseded, scope passes, secret rule, not cross-project
// ---------------------------------------------------------------------------

function admitEntry(entry, tsMs, projectName) {
  if (entry.superseded_by) return false;
  if (!(Date.parse(entry.created) < tsMs)) return false;
  if (!passesScopeFilterForRecall(entry.scope, undefined)) return false;
  if (!ambientSecretAdmit(entry, projectName)) return false;
  if (classifyOriginProject(entry.origin_project, projectName) === 'cross-project') return false;
  return true;
}

// Admission at an arbitrary (cwd, ts), for the Z1b tool-failure query (not tied to a hook prompt).
function admittedAt(resolvers, globalEntries, cwd, tsMs) {
  const projectName = resolvers.projectNameFor(cwd);
  const localEntries = resolvers.localEntriesFor(cwd);
  const localAdm = localEntries.filter((e) => admitEntry(e, tsMs, projectName));
  const globalAdm = globalEntries.filter((e) => admitEntry(e, tsMs, projectName));
  return { localAdm, globalAdm };
}

// ---------------------------------------------------------------------------
// cwd -> project name / local store (live disk walk, cached per cwd)
// ---------------------------------------------------------------------------

function makeResolvers(home, storeMap) {
  const nameCache = new Map();
  const localCache = new Map();

  function projectNameFor(cwd) {
    let name = nameCache.get(cwd);
    if (name === undefined) {
      name = resolveProjectIdentity(cwd, { homeDir: home }).name;
      nameCache.set(cwd, name);
    }
    return name;
  }

  function localEntriesFor(cwd) {
    let result = localCache.get(cwd);
    if (result === undefined) {
      let dir = path.resolve(cwd);
      let root = null;
      for (let i = 0; i < 64; i++) {
        let isHippoDir = false;
        try {
          isHippoDir = fs.statSync(path.join(dir, '.hippo')).isDirectory();
        } catch {
          // no .hippo at this level; keep climbing
        }
        if (isHippoDir) {
          root = dir;
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      result = [];
      if (root && !samePath(root, home)) {
        const mapped = storeMap.get(root.toLowerCase());
        if (mapped) result = mapped;
      }
      localCache.set(cwd, result);
    }
    return result;
  }

  return { projectNameFor, localEntriesFor };
}

// ---------------------------------------------------------------------------
// SI0 machinery, copied verbatim (docs/plans/2026-09-24-si0-automatic-outcomes.md)
// ---------------------------------------------------------------------------

const sig = (t) => t.toLowerCase().replace(/[0-9a-f]{7,}/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
const ROUTINE = [
  /user (?:doesn't|does not) want|denied by (?:the )?user|user (?:rejected|declined|denied)|permission (?:denied|to use)|was blocked by (?:a )?hook/i,
  /\bno (?:matches|files|results) found\b/i,
];
const QUIET = /^\s*(?:grep|rg|egrep|fgrep|find|test|\[|diff|cmp|git diff|git grep)\b/;
const routine = (cmd, err) =>
  err.trim().length < 12 || ROUTINE.some((r) => r.test(err)) || (QUIET.test(cmd) && /exit code 1\b/i.test(err));
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const BUL =
  /^- \*\*\[[^\]]+\](?: ⚠️)? (?:Previously observed \(\d{4}-\d{2}-\d{2}\): |Consider checking: )?(?:\[global\] )?([\s\S]*)\*\*(?: \[[^\]]*\])?(?: \(\d+%\))?$/;

function buildIndices(allEntries) {
  const byId = new Map();
  const byContent = new Map();
  for (const e of allEntries) {
    byId.set(e.id, e);
    const k = norm(e.content);
    if (!byContent.has(k)) byContent.set(k, new Set());
    byContent.get(k).add(e.id);
  }
  return { byId, byContent };
}

function makeMapBlock(byId, byContent) {
  const contents = [...byContent.keys()];
  return function mapBlock(text) {
    const ids = new Set();
    if (!text.includes('## Project Memory')) return ids;
    const sec = text.slice(text.indexOf('## Project Memory'));
    const parts = sec.split(/\n(?=- \*\*\[)/).slice(1);
    for (let part of parts) {
      part = part.split(/\n\n/)[0];
      const m = BUL.exec(part.trim());
      if (!m) continue;
      let c = norm(m[1]);
      let hit = byContent.get(c);
      if (!hit && c.endsWith(' [truncated]')) {
        const pre = c.replace(/ \[truncated\]$/, '');
        const cands = contents.filter((k) => k.startsWith(pre));
        hit = cands.length === 1 ? byContent.get(cands[0]) : cands.length > 1 ? new Set(['a', 'b']) : undefined;
      }
      if (!hit || hit.size !== 1) continue;
      ids.add([...hit][0]);
    }
    return ids;
  };
}

function idsFromRecall(byId, txt) {
  return new Set(
    [...txt.matchAll(/(?:^|\n)--- (mem_[0-9a-f]{12})|"id":"(mem_[0-9a-f]{12})"/g)]
      .map((m) => m[1] || m[2])
      .filter((id) => byId.has(id)),
  );
}

// ---------------------------------------------------------------------------
// A1 (today's hook, simulated as-of a prompt ts)
// ---------------------------------------------------------------------------

// SHORTCUT: oldest-first, not production's strength order; exact only while all pins fit the budget (740 of 1500 tokens in this corpus).
function rankPins(localAdm, globalAdm) {
  const combined = [
    ...localAdm.filter((e) => e.pinned).map((entry) => ({ entry, isGlobal: false })),
    ...globalAdm.filter((e) => e.pinned).map((entry) => ({ entry, isGlobal: true })),
  ];
  combined.sort((a, b) => {
    if (a.isGlobal !== b.isGlobal) return a.isGlobal ? 1 : -1;
    const byCreated = Date.parse(a.entry.created) - Date.parse(b.entry.created);
    if (byCreated !== 0) return byCreated;
    return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
  });
  const seen = new Set();
  const ranked = [];
  for (const p of combined) {
    if (seen.has(p.entry.id)) continue;
    seen.add(p.entry.id);
    ranked.push({ entry: p.entry, isGlobal: p.isGlobal, tokens: estimateTokens(p.entry.content) });
  }
  return ranked;
}

function reserveBudget(rankedPins, budget) {
  let reserve = 0;
  for (const r of rankedPins) {
    if (reserve + r.tokens <= budget) reserve += r.tokens;
  }
  return reserve;
}

function selectA1(localEntries, globalEntries, ts, projectName) {
  const localAdm = localEntries.filter((e) => admitEntry(e, ts, projectName));
  const globalAdm = globalEntries.filter((e) => admitEntry(e, ts, projectName));
  const rankedPins = rankPins(localAdm, globalAdm);
  const pinnedReserve = reserveBudget(rankedPins, PIN_BUDGET);
  const recentBudget = Math.max(0, PIN_BUDGET - pinnedReserve);

  const selectedIds = new Set();
  const items = [];
  let used = 0;

  const recent = [
    ...localAdm.map((entry) => ({ entry, isGlobal: false })),
    ...globalAdm.map((entry) => ({ entry, isGlobal: true })),
  ]
    .sort((a, b) => {
      const byCreated = Date.parse(b.entry.created) - Date.parse(a.entry.created);
      if (byCreated !== 0) return byCreated;
      return b.entry.id < a.entry.id ? -1 : b.entry.id > a.entry.id ? 1 : 0;
    })
    .filter(({ entry }) => entry.pinned || isWorthSurfacing(entry))
    .slice(0, 5);

  for (const r of recent) {
    if (selectedIds.has(r.entry.id)) continue;
    const tokens = estimateTokens(r.entry.content);
    if (used + tokens > recentBudget) continue;
    items.push(toItem(r.entry, r.isGlobal, tokens));
    selectedIds.add(r.entry.id);
    used += tokens;
  }
  for (const r of rankedPins) {
    if (selectedIds.has(r.entry.id)) continue;
    if (used + r.tokens > PIN_BUDGET) continue;
    items.push(toItem(r.entry, r.isGlobal, r.tokens));
    selectedIds.add(r.entry.id);
    used += r.tokens;
  }
  return { items, totalTokens: used, rankedPins, pinnedReserve, localAdm, globalAdm };
}

function toItem(entry, isGlobal, tokens) {
  return { id: entry.id, content: entry.content, tags: entry.tags, created: entry.created, isGlobal, tokens };
}

function renderBlock(items, totalTokens, heading = 'Project Memory') {
  if (items.length === 0) return '';
  const lines = [`## ${heading} (${items.length} entries, ${totalTokens} tokens)`, ''];
  for (const it of items) {
    const dateStr = it.created.slice(0, 10);
    const tagStr = it.tags.length > 0 ? ` [${it.tags.join(', ')}]` : '';
    const globalPrefix = it.isGlobal ? '[global] ' : '';
    lines.push(`- **[observed] Previously observed (${dateStr}): ${globalPrefix}${it.content}**${tagStr}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Z1 candidates (grid / final only; a0 mode never calls these)
// ---------------------------------------------------------------------------

const tokenSetCache = new Map();
function tokensOf(entry) {
  let t = tokenSetCache.get(entry.id);
  if (!t) {
    t = contentTokens(entry.content);
    tokenSetCache.set(entry.id, t);
  }
  return t;
}

function z1Candidates(localAdm, globalAdm, promptTok, opts = {}) {
  const excludeAutoCaptured = opts.excludeAutoCaptured === true;
  const seen = new Set();
  const out = [];
  for (const { entries, isGlobal } of [
    { entries: localAdm, isGlobal: false },
    { entries: globalAdm, isGlobal: true },
  ]) {
    for (const entry of entries) {
      if (entry.pinned || seen.has(entry.id) || !isWorthSurfacing(entry)) continue;
      if (excludeAutoCaptured && entry.tags.includes('auto-captured')) continue;
      seen.add(entry.id);
      const tokens = tokensOf(entry);
      const { shared } = scoreOverlap(promptTok, tokens, 'jaccard');
      if (shared < 2) continue; // every grid point has minShared >= 2 (prereg Speed note)
      out.push({ id: entry.id, tokens, entry, isGlobal });
    }
  }
  return out;
}

// Z1b tool-failure block: same candidate/gate/budget shape as selectZ1Recall, minus the pin reserve.
function computeZ1bBlock(localAdm, globalAdm, queryTok, gate) {
  const candidates = z1Candidates(localAdm, globalAdm, queryTok, { excludeAutoCaptured: true });
  const gated = gatePromptRecall(queryTok, candidates, gate);
  const items = [];
  let used = 0;
  for (const g of gated) {
    const tokens = estimateTokens(g.item.entry.content);
    if (used + tokens > PIN_BUDGET) continue;
    items.push(toItem(g.item.entry, g.item.isGlobal, tokens));
    used += tokens;
  }
  return { items, totalTokens: used };
}

// Pins-only, same budget rule as A1's own pin admission; TE2-gated on its own state.
function selectZ1Static(rankedPins) {
  const items = [];
  let used = 0;
  for (const r of rankedPins) {
    if (used + r.tokens > PIN_BUDGET) continue;
    items.push(toItem(r.entry, r.isGlobal, r.tokens));
    used += r.tokens;
  }
  return { items, totalTokens: used };
}

// Never TE2-skipped: sent whenever non-empty (prereg: "always sent when non-empty").
function selectZ1Recall(precomputed, promptTok, gate, pinnedReserve) {
  const gated = gatePromptRecall(promptTok, precomputed, gate);
  const budget = Math.max(0, PIN_BUDGET - pinnedReserve);
  const items = [];
  let used = 0;
  for (const g of gated) {
    const tokens = estimateTokens(g.item.entry.content);
    if (used + tokens > budget) continue;
    items.push(toItem(g.item.entry, g.item.isGlobal, tokens));
    used += tokens;
  }
  return { items, totalTokens: used };
}

// ---------------------------------------------------------------------------
// Stats accumulation
// ---------------------------------------------------------------------------

function makeAcc() {
  return { total: 0, withContext: 0, atLeast02: 0, sumAll: 0, scores: [], contextSizes: [] };
}

function record(acc, candSet, errText, byId) {
  acc.total++;
  acc.contextSizes.push(candSet.size);
  if (candSet.size === 0) return;
  let mx = 0;
  for (const id of candSet) {
    const e = byId.get(id);
    if (!e) continue;
    const ov = textOverlap(e.content, errText);
    if (ov > mx) mx = ov;
  }
  acc.withContext++;
  acc.scores.push(mx);
  acc.sumAll += mx;
  if (mx >= 0.2) acc.atLeast02++;
}

function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function summarize(acc) {
  const scores = [...acc.scores].sort((a, b) => a - b);
  const ctx = [...acc.contextSizes].sort((a, b) => a - b);
  return {
    total: acc.total,
    withContext: acc.withContext,
    median: quantile(scores, 0.5),
    p90: quantile(scores, 0.9),
    max: scores.length ? scores[scores.length - 1] : null,
    atLeast0_2: acc.atLeast02,
    meanAllSignalEvents: acc.total ? acc.sumAll / acc.total : 0,
    medianContextSize: quantile(ctx, 0.5),
  };
}

function summarizeTokens(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    hookPrompts: arr.length,
    median: quantile(s, 0.5),
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0,
    p90: quantile(s, 0.9),
  };
}

function setDiff(a, b) {
  const out = new Set();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}

// Same PRNG as scripts/z1-latency.mjs / scripts/lifecycle-stress/inject.mjs: Math.random is banned for reproducibility.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seed) {
  const rng = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The newest |count| distinct ids A1 put in context, newest first (judge control C).
function buildControlC(a1OrderList, count, byId) {
  const seen = new Set();
  const out = [];
  for (let idx = a1OrderList.length - 1; idx >= 0 && out.length < count; idx--) {
    const id = a1OrderList[idx].id;
    if (seen.has(id)) continue;
    seen.add(id);
    const e = byId.get(id);
    if (e) out.push({ id, content: e.content, created: e.created });
  }
  return out;
}

// Judge items T (Z1b block) and C (control) for one eligible event; command/error not pre-collapsed for T's cap.
function buildJudgeEntries(eventId, cmd, err, tItems, maxItems, a1OrderList, byId, session) {
  const command = cmd.slice(0, 500);
  const error = err.slice(0, 1500);
  const tMems = tItems.slice(0, maxItems).map((it) => it.content.slice(0, 600));
  const cList = buildControlC(a1OrderList, Math.min(tItems.length, maxItems), byId);
  const entries = [{ eventId, arm: 'T', autoNo: false, command, error, memories: tMems, session }];
  if (cList.length === 0) {
    entries.push({ eventId, arm: 'C', autoNo: true, command, error, memories: [], session });
  } else {
    entries.push({ eventId, arm: 'C', autoNo: false, command, error, memories: cList.map((c) => c.content.slice(0, 600)), session });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Per-file replay
// ---------------------------------------------------------------------------

async function processFile(filePath, mode, ctx, z1Configs, arm = 'z1', collectJudge = false) {
  const { byId, mapBlock, resolvers } = ctx;
  const scored = (t) => ctx.sinceMs == null || t >= ctx.sinceMs;
  const session = createHash('sha256').update(path.basename(filePath)).digest('hex').slice(0, 12);
  const runZ1 = mode === 'grid' || mode === 'final' || mode === 'selftest';
  const isZ1b = runZ1 && arm === 'z1b';
  const a0 = { reset: new Set(), lifetime: new Set() };
  const a1 = { reset: new Set(), lifetime: new Set(), te2: null };
  // One state per config: static block has its own TE2; recall is never skipped, so no TE2 state for it.
  const z1States = runZ1 && !isZ1b ? z1Configs.map(() => ({ reset: new Set(), lifetime: new Set(), teStatic: null })) : null;
  const z1FileAccs = runZ1 && !isZ1b ? z1Configs.map(() => emptyZ1Bucket()) : null;
  // Z1b state per config: A1's ids plus a tool-failure block; teBlock gates the block's own skip rule.
  const z1bStates = isZ1b
    ? z1Configs.map(() => ({ reset: new Set(), lifetime: new Set(), teBlock: null, lastSentItems: { items: [], ts: null }, pendingTokens: 0, intervalHasBlock: false, lastIntervalIdx: null }))
    : null;
  const z1bFileAccs = isZ1b ? z1Configs.map(() => emptyZ1bBucket()) : null;
  // A1's per-prompt injection order, oldest first, reset at compaction: judge control C reads from its tail.
  let a1Order = isZ1b ? [] : null;
  const judgeItems = [];
  let nonRoutineFailures = 0;

  const primary = { a0: { reset: makeAcc(), lifetime: makeAcc() }, a1: { reset: makeAcc(), lifetime: makeAcc() } };
  const secondary = { a0: { reset: makeAcc(), lifetime: makeAcc() }, a1: { reset: makeAcc(), lifetime: makeAcc() } };
  const tokensPerPrompt = [];
  const tokensPerPromptScored = [];

  const uses = new Map();
  const firstErr = new Map();
  const firstFail = new Map();
  let pendingPrompt = null;
  let lastCwd = null;

  function fireHookPrompt(ts, cwd, text) {
    const isScored = scored(ts);
    const projectName = resolvers.projectNameFor(cwd);
    const localEntries = resolvers.localEntriesFor(cwd);
    const sel = selectA1(localEntries, ctx.globalEntries, ts, projectName);
    let a1TokensThisPrompt = 0;
    let a1Sent = false;
    if (sel.items.length === 0) {
      tokensPerPrompt.push(0);
      tokensPerPromptScored.push(isScored);
    } else {
      const text2 = renderBlock(sel.items, sel.totalTokens);
      const hash = blockHash(text2);
      if (shouldSkipUnchanged(a1.te2, hash, REFRESH_TURNS)) {
        tokensPerPrompt.push(0);
        tokensPerPromptScored.push(isScored);
        a1.te2 = { hash, skipsSince: a1.te2.skipsSince + 1 };
      } else {
        a1TokensThisPrompt = estimateTokens(text2);
        tokensPerPrompt.push(a1TokensThisPrompt);
        tokensPerPromptScored.push(isScored);
        for (const it of sel.items) {
          a1.reset.add(it.id);
          a1.lifetime.add(it.id);
        }
        a1.te2 = { hash, skipsSince: 0 };
        a1Sent = true;
      }
    }

    if (isZ1b) {
      // Z1b arm = A1's own injections plus the tool-failure block; no prompt-gated recall of its own.
      if (a1Sent) {
        for (const it of sel.items) a1Order.push({ id: it.id });
      }
      z1Configs.forEach((gate, i) => {
        const s = z1bStates[i];
        const acc = z1bFileAccs[i];
        if (a1Sent) for (const it of sel.items) { s.reset.add(it.id); s.lifetime.add(it.id); }
        // Finalize the interval this prompt is closing: its blocks landed after it fired, before this new one.
        // Since gate: the interval is scored iff the prompt that opened it (acc.tokensScored[idx]) was scored.
        if (s.lastIntervalIdx !== null) {
          const intervalScored = acc.tokensScored[s.lastIntervalIdx];
          acc.tokens[s.lastIntervalIdx] += s.pendingTokens;
          if (intervalScored) {
            acc.intervalHasBlock.total++;
            if (s.intervalHasBlock) acc.intervalHasBlock.count++;
          }
        } else {
          acc.tokensUnattributed += s.pendingTokens; // blocks before this file's first hook prompt
        }
        acc.tokens.push(a1TokensThisPrompt);
        acc.tokensScored.push(isScored);
        s.lastIntervalIdx = acc.tokens.length - 1;
        s.pendingTokens = 0;
        s.intervalHasBlock = false;
      });
    } else if (runZ1) {
      const promptTok = promptTokens(text);
      const precomputed = z1Candidates(sel.localAdm, sel.globalAdm, promptTok);
      // Static (pins) block is gate-independent: compute its text/tokens once, gate its TE2 send per config.
      const staticSel = selectZ1Static(sel.rankedPins);
      const staticText = renderBlock(staticSel.items, staticSel.totalTokens);
      const staticHash = staticSel.items.length > 0 ? blockHash(staticText) : null;

      z1Configs.forEach((gate, i) => {
        const state = z1States[i];
        const acc = z1FileAccs[i];
        let staticTokens = 0;
        if (staticSel.items.length > 0) {
          if (!shouldSkipUnchanged(state.teStatic, staticHash, REFRESH_TURNS)) {
            staticTokens = estimateTokens(staticText);
            for (const it of staticSel.items) { state.reset.add(it.id); state.lifetime.add(it.id); }
            state.teStatic = { hash: staticHash, skipsSince: 0 };
          } else {
            state.teStatic = { hash: staticHash, skipsSince: state.teStatic.skipsSince + 1 };
          }
        }

        const recallSel = selectZ1Recall(precomputed, promptTok, gate, sel.pinnedReserve);
        if (isScored) acc.noRecall.total++;
        let recallTokens = 0;
        if (recallSel.items.length > 0) {
          recallTokens = estimateTokens(renderBlock(recallSel.items, recallSel.totalTokens, 'Prompt-Relevant Memory'));
          for (const it of recallSel.items) { state.reset.add(it.id); state.lifetime.add(it.id); }
        } else {
          if (isScored) acc.noRecall.count++;
        }
        acc.tokens.push(staticTokens + recallTokens);
        acc.tokensScored.push(isScored);
      });
    }
  }

  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      a0.reset.clear();
      a1.reset.clear();
      a1.te2 = null;
      if (z1States) for (const s of z1States) { s.reset.clear(); s.teStatic = null; }
      if (z1bStates) for (const s of z1bStates) { s.reset.clear(); s.teBlock = null; }
      if (a1Order) a1Order = [];
      continue;
    }

    const a = o.attachment;
    if (a && (a.type === 'hook_additional_context' || a.type === 'hook_success')) {
      const t = Array.isArray(a.content) ? a.content.join('\n') : String(a.content ?? '');
      const ids = mapBlock(t);
      ids.forEach((i) => { a0.reset.add(i); a0.lifetime.add(i); });
      if (a.type === 'hook_additional_context' && a.hookEvent === 'UserPromptSubmit' && pendingPrompt) {
        fireHookPrompt(pendingPrompt.ts, pendingPrompt.cwd, pendingPrompt.text);
        pendingPrompt = null;
      }
      continue;
    }

    const promptText = o.message?.content;
    // String(x) === x holds only for string primitives; array content is a tool result, not a prompt.
    if (o.type === 'user' && !o.isMeta && String(promptText) === promptText) {
      pendingPrompt = { ts: Date.parse(o.timestamp), cwd: o.cwd, text: promptText };
    }
    if (o.cwd) lastCwd = o.cwd;

    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === 'tool_use' && b.name === 'Bash') uses.set(b.id, String(b.input?.command ?? ''));
      if (b.type === 'tool_result' && uses.has(b.tool_use_id)) {
        const cmd = uses.get(b.tool_use_id);
        const txt = Array.isArray(b.content) ? b.content.map((x) => x.text ?? '').join(' ') : String(b.content ?? '');
        if (/\bhippo (recall|context)\b/.test(cmd)) {
          const ids = new Set([...idsFromRecall(byId, txt), ...mapBlock(txt)]);
          ids.forEach((i) => { a0.reset.add(i); a0.lifetime.add(i); });
          continue;
        }
        const cs = sig(cmd);
        const snap = {
          a0: { reset: new Set(a0.reset), lifetime: new Set(a0.lifetime) },
          a1: { reset: new Set(a1.reset), lifetime: new Set(a1.lifetime) },
          z1: runZ1 && !isZ1b ? z1States.map((s) => ({ reset: new Set(s.reset), lifetime: new Set(s.lifetime) })) : null,
          z1b: isZ1b ? z1bStates.map((s) => ({ reset: new Set(s.reset), lifetime: new Set(s.lifetime) })) : null,
        };
        if (b.is_error) {
          const err = txt.replace(/\s+/g, ' ').trim();
          if (routine(cmd, err)) continue;
          const ts = Date.parse(o.timestamp);
          const isScoredFailure = scored(ts);
          if (isScoredFailure) nonRoutineFailures++;
          const es = sig(('Bash: ' + err).slice(0, 200));
          if (isScoredFailure) {
            record(secondary.a0.reset, snap.a0.reset, err, byId);
            record(secondary.a0.lifetime, snap.a0.lifetime, err, byId);
            record(secondary.a1.reset, snap.a1.reset, err, byId);
            record(secondary.a1.lifetime, snap.a1.lifetime, err, byId);
            if (runZ1 && !isZ1b) snap.z1.forEach((s, i) => {
              record(z1FileAccs[i].reset.secondary, s.reset, err, byId);
              record(z1FileAccs[i].lifetime.secondary, s.lifetime, err, byId);
            });
            if (isZ1b) snap.z1b.forEach((s, i) => {
              record(z1bFileAccs[i].reset.secondary, s.reset, err, byId);
              record(z1bFileAccs[i].lifetime.secondary, s.lifetime, err, byId);
            });
          }
          if (firstErr.has(es)) {
            if (isScoredFailure) {
              record(primary.a0.reset, snap.a0.reset, err, byId);
              record(primary.a0.lifetime, snap.a0.lifetime, err, byId);
              record(primary.a1.reset, snap.a1.reset, err, byId);
              record(primary.a1.lifetime, snap.a1.lifetime, err, byId);
              if (runZ1 && !isZ1b) snap.z1.forEach((s, i) => {
                record(z1FileAccs[i].reset.primary, s.reset, err, byId);
                record(z1FileAccs[i].lifetime.primary, s.lifetime, err, byId);
              });
              if (isZ1b) snap.z1b.forEach((s, i) => {
                record(z1bFileAccs[i].reset.primary, s.reset, err, byId);
                record(z1bFileAccs[i].lifetime.primary, s.lifetime, err, byId);
                const added = [...s.reset].some((id) => !snap.a1.reset.has(id));
                if (added) {
                  z1bFileAccs[i].addedEvents++;
                  const sent = z1bStates[i].lastSentItems; // most recent block sent before this event's own injection
                  const tItems = sent.items.slice(0, z1Configs[i].maxItems);
                  for (const it of tItems) {
                    const age = sent.ts - Date.parse(it.created); // age against the block's originating failure, not this repeat
                    if (age >= 0 && age <= 10 * 60 * 1000) z1bFileAccs[i].recalledCreatedWithin10MinEligible++;
                  }
                  if (collectJudge) {
                    const eventId = ctx.judgeEventCounter.n++;
                    judgeItems.push(...buildJudgeEntries(eventId, cmd, err, tItems, z1Configs[i].maxItems, a1Order, byId, session));
                  }
                }
              });
            }
          } else {
            firstErr.set(es, true);
          }
          // Snapshot A1's order now: a compaction before the eventual success must not change the judge's control C.
          if (!firstFail.has(cs)) firstFail.set(cs, { err, cmd, snap, ts, a1OrderSnapshot: a1Order ? a1Order.slice() : [] });

          // Z1b tool-failure block: after the event is recorded, so it counts toward later repeats and fail-then-pass.
          // The block's own computation/skip-state stays unconditional; only its accounting is since-gated.
          if (isZ1b) {
            const cwd = o.cwd || lastCwd;
            const tsMs = ts;
            const { localAdm, globalAdm } = admittedAt(resolvers, ctx.globalEntries, cwd, tsMs);
            const query = cmd.replace(LEADING_CD, '') + '\n' + err;
            const queryTok = contentTokens(query.slice(0, 4000));
            z1Configs.forEach((gate, i) => {
              const s = z1bStates[i];
              const acc = z1bFileAccs[i];
              if (isScoredFailure) acc.failuresSeen++;
              const blk = computeZ1bBlock(localAdm, globalAdm, queryTok, gate);
              if (blk.items.length === 0) return; // nothing clears the gate: no block, no skip-state change
              const idsKey = blk.items.map((it) => it.id).sort().join(',');
              if (shouldSkipUnchanged(s.teBlock, idsKey, REFRESH_TURNS)) {
                s.teBlock = { hash: idsKey, skipsSince: s.teBlock.skipsSince + 1 };
                return;
              }
              const tokens = estimateTokens(renderBlock(blk.items, blk.totalTokens, 'Failure-Relevant Memory'));
              for (const it of blk.items) { s.reset.add(it.id); s.lifetime.add(it.id); }
              s.teBlock = { hash: idsKey, skipsSince: 0 };
              s.lastSentItems = { items: blk.items, ts: tsMs };
              if (isScoredFailure) {
                s.pendingTokens += tokens;
                s.intervalHasBlock = true;
                acc.blocksSent++;
                for (const it of blk.items) {
                  const age = tsMs - Date.parse(it.created);
                  if (age >= 0 && age <= 10 * 60 * 1000) acc.recalledCreatedWithin10Min++;
                }
              }
            });
          }
        } else if (firstFail.has(cs)) {
          const ff = firstFail.get(cs);
          const successTs = Date.parse(o.timestamp);
          if (scored(ff.ts) && scored(successTs)) {
            const dReset0 = setDiff(a0.reset, ff.snap.a0.reset);
            const dLife0 = setDiff(a0.lifetime, ff.snap.a0.lifetime);
            const dReset1 = setDiff(a1.reset, ff.snap.a1.reset);
            const dLife1 = setDiff(a1.lifetime, ff.snap.a1.lifetime);
            record(primary.a0.reset, dReset0, ff.err, byId);
            record(primary.a0.lifetime, dLife0, ff.err, byId);
            record(primary.a1.reset, dReset1, ff.err, byId);
            record(primary.a1.lifetime, dLife1, ff.err, byId);
            if (runZ1 && !isZ1b) z1States.forEach((s, i) => {
              const dReset = setDiff(s.reset, ff.snap.z1[i].reset);
              const dLife = setDiff(s.lifetime, ff.snap.z1[i].lifetime);
              record(z1FileAccs[i].reset.primary, dReset, ff.err, byId);
              record(z1FileAccs[i].lifetime.primary, dLife, ff.err, byId);
            });
            if (isZ1b) z1bStates.forEach((s, i) => {
              const dReset = setDiff(s.reset, ff.snap.z1b[i].reset);
              const dLife = setDiff(s.lifetime, ff.snap.z1b[i].lifetime);
              record(z1bFileAccs[i].reset.primary, dReset, ff.err, byId);
              record(z1bFileAccs[i].lifetime.primary, dLife, ff.err, byId);
              const added = [...dReset].some((id) => !dReset1.has(id));
              if (added) {
                z1bFileAccs[i].addedEvents++;
                const sent = s.lastSentItems; // live: no block fires on a success line
                const tItems = sent.items.slice(0, z1Configs[i].maxItems);
                for (const it of tItems) {
                  const age = sent.ts - Date.parse(it.created); // age against the originating failure, not this success line
                  if (age >= 0 && age <= 10 * 60 * 1000) z1bFileAccs[i].recalledCreatedWithin10MinEligible++;
                }
                if (collectJudge) {
                  const eventId = ctx.judgeEventCounter.n++;
                  judgeItems.push(...buildJudgeEntries(eventId, ff.cmd, ff.err, tItems, z1Configs[i].maxItems, ff.a1OrderSnapshot, byId, session));
                }
              }
            });
          }
          firstFail.delete(cs);
        }
      }
    }
  }

  if (isZ1b) {
    // Include the final interval (blocks after the last hook prompt, to EOF); unattributed only if no prompt ever fired.
    z1bStates.forEach((s, i) => {
      const acc = z1bFileAccs[i];
      if (s.lastIntervalIdx !== null) {
        const intervalScored = acc.tokensScored[s.lastIntervalIdx];
        acc.tokens[s.lastIntervalIdx] += s.pendingTokens;
        if (intervalScored) {
          acc.intervalHasBlock.total++;
          if (s.intervalHasBlock) acc.intervalHasBlock.count++;
        }
      } else {
        acc.tokensUnattributed += s.pendingTokens;
      }
    });
  }

  // --since: drop token entries for unscored prompts/intervals; no-op (arrays untouched) when sinceMs is unset.
  if (ctx.sinceMs != null) {
    const keepScored = (arr, flags) => arr.filter((_, idx) => flags[idx]);
    const filteredTokensPerPrompt = keepScored(tokensPerPrompt, tokensPerPromptScored);
    if (z1FileAccs) for (const acc of z1FileAccs) acc.tokens = keepScored(acc.tokens, acc.tokensScored);
    if (z1bFileAccs) for (const acc of z1bFileAccs) acc.tokens = keepScored(acc.tokens, acc.tokensScored);
    return { primary, secondary, tokensPerPrompt: filteredTokensPerPrompt, z1PerConfig: z1FileAccs, z1bPerConfig: z1bFileAccs, judgeItems, nonRoutineFailures };
  }
  return { primary, secondary, tokensPerPrompt, z1PerConfig: z1FileAccs, z1bPerConfig: z1bFileAccs, judgeItems, nonRoutineFailures };
}

// ---------------------------------------------------------------------------
// Corpus walking + split
// ---------------------------------------------------------------------------

function walkCorpus(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(p);
    }
  }
  return out;
}

function splitOf(file) {
  const h = createHash('sha256').update(path.basename(file)).digest('hex');
  return parseInt(h.slice(0, 2), 16) % 2 === 0 ? 'tune' : 'heldout';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function emptyBucket() {
  return {
    a0: { reset: { primary: makeAcc(), secondary: makeAcc() }, lifetime: { primary: makeAcc(), secondary: makeAcc() } },
    a1: { reset: { primary: makeAcc(), secondary: makeAcc() }, lifetime: { primary: makeAcc(), secondary: makeAcc() } },
    tokens: [],
    files: 0,
  };
}

function fold(bucket, result) {
  for (const arm of ['a0', 'a1']) {
    for (const variant of ['reset', 'lifetime']) {
      foldAcc(bucket[arm][variant].primary, result.primary[arm][variant]);
      foldAcc(bucket[arm][variant].secondary, result.secondary[arm][variant]);
    }
  }
  bucket.tokens.push(...result.tokensPerPrompt);
  bucket.files++;
}

function foldAcc(into, from) {
  into.total += from.total;
  into.withContext += from.withContext;
  into.atLeast02 += from.atLeast02;
  into.sumAll += from.sumAll;
  into.scores.push(...from.scores);
  into.contextSizes.push(...from.contextSizes);
}

function renderBucket(bucket) {
  return {
    files: bucket.files,
    A0: {
      reset: { primary: summarize(bucket.a0.reset.primary), secondary: summarize(bucket.a0.reset.secondary) },
      lifetime: { primary: summarize(bucket.a0.lifetime.primary), secondary: summarize(bucket.a0.lifetime.secondary) },
    },
    A1: {
      reset: { primary: summarize(bucket.a1.reset.primary), secondary: summarize(bucket.a1.reset.secondary) },
      lifetime: { primary: summarize(bucket.a1.lifetime.primary), secondary: summarize(bucket.a1.lifetime.secondary) },
      tokens: summarizeTokens(bucket.tokens),
    },
  };
}

// One Z1 arm, one config: same shape as a0/a1's per-arm stats plus its own tokens and no-recall share.
function emptyZ1Bucket() {
  return {
    reset: { primary: makeAcc(), secondary: makeAcc() },
    lifetime: { primary: makeAcc(), secondary: makeAcc() },
    tokens: [],
    tokensScored: [], // per-file only: parallel scored flags; fold ignores them
    noRecall: { count: 0, total: 0 },
  };
}

function foldZ1(bucket, result) {
  foldAcc(bucket.reset.primary, result.reset.primary);
  foldAcc(bucket.reset.secondary, result.reset.secondary);
  foldAcc(bucket.lifetime.primary, result.lifetime.primary);
  foldAcc(bucket.lifetime.secondary, result.lifetime.secondary);
  bucket.tokens.push(...result.tokens);
  bucket.noRecall.count += result.noRecall.count;
  bucket.noRecall.total += result.noRecall.total;
}

function renderZ1Bucket(bucket) {
  return {
    reset: { primary: summarize(bucket.reset.primary), secondary: summarize(bucket.reset.secondary) },
    lifetime: { primary: summarize(bucket.lifetime.primary), secondary: summarize(bucket.lifetime.secondary) },
    tokens: summarizeTokens(bucket.tokens),
    noRecallShare: bucket.noRecall.total ? bucket.noRecall.count / bucket.noRecall.total : null,
  };
}

// Prereg pick rule, tune split only: eligible on token budget and a sample floor, then max signal.
function pickConfig(rows, a1TokenMedian) {
  const eligible = rows.filter((r) => {
    const tm = r.tune.tokens.median;
    return tm !== null && a1TokenMedian !== null && tm <= a1TokenMedian && r.tune.reset.primary.withContext >= 10;
  });
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const byMedian = (b.tune.reset.primary.median ?? -Infinity) - (a.tune.reset.primary.median ?? -Infinity);
    if (byMedian !== 0) return byMedian;
    const byMeanTokens = a.tune.tokens.mean - b.tune.tokens.mean;
    if (byMeanTokens !== 0) return byMeanTokens;
    return b.config.threshold - a.config.threshold;
  });
  return eligible[0].config;
}

// One Z1b arm, one config: Z1's fields plus addedEvents, the block-created-recently audit, tokensUnattributed.
function emptyZ1bBucket() {
  return {
    reset: { primary: makeAcc(), secondary: makeAcc() },
    lifetime: { primary: makeAcc(), secondary: makeAcc() },
    tokens: [],
    tokensScored: [], // per-file only: parallel scored flags; fold ignores them
    intervalHasBlock: { count: 0, total: 0 },
    tokensUnattributed: 0,
    addedEvents: 0,
    blocksSent: 0,
    failuresSeen: 0,
    recalledCreatedWithin10Min: 0,
    recalledCreatedWithin10MinEligible: 0,
  };
}

function foldZ1b(bucket, result) {
  foldAcc(bucket.reset.primary, result.reset.primary);
  foldAcc(bucket.reset.secondary, result.reset.secondary);
  foldAcc(bucket.lifetime.primary, result.lifetime.primary);
  foldAcc(bucket.lifetime.secondary, result.lifetime.secondary);
  bucket.tokens.push(...result.tokens);
  bucket.intervalHasBlock.count += result.intervalHasBlock.count;
  bucket.intervalHasBlock.total += result.intervalHasBlock.total;
  bucket.tokensUnattributed += result.tokensUnattributed;
  bucket.addedEvents += result.addedEvents;
  bucket.blocksSent += result.blocksSent;
  bucket.failuresSeen += result.failuresSeen;
  bucket.recalledCreatedWithin10Min += result.recalledCreatedWithin10Min;
  bucket.recalledCreatedWithin10MinEligible += result.recalledCreatedWithin10MinEligible;
}

function renderZ1bBucket(bucket) {
  return {
    reset: { primary: summarize(bucket.reset.primary), secondary: summarize(bucket.reset.secondary) },
    lifetime: { primary: summarize(bucket.lifetime.primary), secondary: summarize(bucket.lifetime.secondary) },
    tokens: summarizeTokens(bucket.tokens),
    tokensUnattributed: bucket.tokensUnattributed,
    intervalShare: bucket.intervalHasBlock.total ? bucket.intervalHasBlock.count / bucket.intervalHasBlock.total : null,
    addedEvents: bucket.addedEvents,
    blocksSent: bucket.blocksSent,
    failuresSeen: bucket.failuresSeen,
    recalledCreatedWithin10Min: bucket.recalledCreatedWithin10Min,
    recalledCreatedWithin10MinEligible: bucket.recalledCreatedWithin10MinEligible,
  };
}

// Z1b pick rule (prereg "Split and tuning"): token budget, mean cap, and an addedEvents floor, then max signal.
function pickConfigZ1b(rows, a1TokenMedian, a1TokenMean) {
  const eligible = rows.filter((r) => {
    const tm = r.tune.tokens.median;
    const mn = r.tune.tokens.mean;
    return (
      tm !== null && a1TokenMedian !== null && tm <= a1TokenMedian &&
      a1TokenMean !== null && mn <= 1.1 * a1TokenMean &&
      r.tune.addedEvents >= 10
    );
  });
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const byMedian = (b.tune.reset.primary.median ?? -Infinity) - (a.tune.reset.primary.median ?? -Infinity);
    if (byMedian !== 0) return byMedian;
    const byMeanTokens = a.tune.tokens.mean - b.tune.tokens.mean;
    if (byMeanTokens !== 0) return byMeanTokens;
    return b.config.threshold - a.config.threshold;
  });
  return eligible[0].config;
}

// Judge export: shuffled, unlabelled main file plus a separate itemId -> {eventId, arm} key file.
function writeJudgeExport(filePath, rawItems) {
  const shuffled = seededShuffle(rawItems, 20260926);
  const items = shuffled.map((it, idx) => ({ itemId: idx, autoNo: it.autoNo, command: it.command, error: it.error, memories: it.memories }));
  const key = shuffled.map((it, idx) => ({ itemId: idx, eventId: it.eventId, arm: it.arm, autoNo: it.autoNo, session: it.session }));
  fs.writeFileSync(filePath, JSON.stringify({ seed: 20260926, items }, null, 2));
  fs.writeFileSync(`${filePath}.key.json`, JSON.stringify(key, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = path.resolve(args.home);
  const globalEntries = loadStore(args.global);
  const storeMap = new Map();
  const namedEntries = [];
  for (const spec of args.store) {
    const eq = spec.indexOf('=');
    const root = path.resolve(spec.slice(0, eq));
    const dir = spec.slice(eq + 1);
    const entries = loadStore(dir);
    storeMap.set(root.toLowerCase(), entries);
    namedEntries.push(...entries);
  }
  const { byId, byContent } = buildIndices([...globalEntries, ...namedEntries]);
  const mapBlock = makeMapBlock(byId, byContent);
  const resolvers = makeResolvers(home, storeMap);
  const arm = args.arm === 'z1b' ? 'z1b' : 'z1';
  const judgeEventCounter = { n: 0 };
  const sinceMs = args.since ? Date.parse(args.since) : null;
  if (Number.isNaN(sinceMs)) {
    console.error(`invalid --since ${args.since}`);
    process.exit(1);
  }
  const ctx = { byId, mapBlock, resolvers, globalEntries, judgeEventCounter, sinceMs };
  const autoCapturedTotal = [...globalEntries, ...namedEntries].filter((e) => e.tags.includes('auto-captured')).length;

  let z1Configs = null;
  if (args.mode === 'grid') {
    if (args.split !== 'tune') {
      console.error('grid mode requires --split tune');
      process.exit(1);
    }
    const jaccardT = [0.04, 0.06, 0.08, 0.1, 0.12];
    const cosineT = [0.1, 0.15, 0.2, 0.25, 0.3];
    z1Configs = [];
    for (const metric of ['jaccard', 'cosine']) {
      for (const threshold of metric === 'jaccard' ? jaccardT : cosineT) {
        for (const minShared of [2, 3]) {
          for (const maxItems of [3, 5]) {
            z1Configs.push({ metric, threshold, minShared, maxItems });
          }
        }
      }
    }
  } else if (args.mode === 'final') {
    z1Configs = [JSON.parse(args.config)];
  } else if (args.mode === 'selftest') {
    // Hidden wiring check: fixed config, first 3 tune files, counts only, never a scored run.
    z1Configs = arm === 'z1b'
      ? [{ metric: 'jaccard', threshold: 0.08, minShared: 2, maxItems: 3 }]
      : [{ metric: 'cosine', threshold: 0.2, minShared: 2, maxItems: 3 }];
  }

  const files = walkCorpus(args.corpus);
  let wanted;
  if (args.mode === 'selftest') {
    wanted = files.filter((f) => splitOf(f) === 'tune').slice(0, 3);
  } else {
    wanted =
      args.split === 'tune' ? files.filter((f) => splitOf(f) === 'tune')
      : args.split === 'heldout' ? files.filter((f) => splitOf(f) === 'heldout')
      : files;
  }

  const buckets = { tune: emptyBucket(), heldout: emptyBucket(), all: emptyBucket() };
  const z1Buckets = z1Configs && arm !== 'z1b' ? z1Configs.map(() => ({ tune: emptyZ1Bucket(), heldout: emptyZ1Bucket(), all: emptyZ1Bucket() })) : null;
  const z1bBuckets = z1Configs && arm === 'z1b' ? z1Configs.map(() => ({ tune: emptyZ1bBucket(), heldout: emptyZ1bBucket(), all: emptyZ1bBucket() })) : null;
  const nonRoutineFailures = { tune: 0, heldout: 0, all: 0 };
  const judgeItems = [];
  const collectJudgeMode = args.mode === 'final' && arm === 'z1b' && !!args.judgeOut;
  const startedAt = Date.now();
  for (const f of wanted) {
    const label = splitOf(f);
    const collectJudge = collectJudgeMode && (sinceMs != null || label === 'heldout');
    const result = await processFile(f, args.mode, ctx, z1Configs, arm, collectJudge);
    fold(buckets[label], result);
    fold(buckets.all, result);
    nonRoutineFailures[label] += result.nonRoutineFailures;
    nonRoutineFailures.all += result.nonRoutineFailures;
    if (z1Buckets) {
      result.z1PerConfig.forEach((r, i) => {
        foldZ1(z1Buckets[i][label], r);
        foldZ1(z1Buckets[i].all, r);
      });
    }
    if (z1bBuckets) {
      result.z1bPerConfig.forEach((r, i) => {
        foldZ1b(z1bBuckets[i][label], r);
        foldZ1b(z1bBuckets[i].all, r);
      });
    }
    if (result.judgeItems.length) judgeItems.push(...result.judgeItems);
  }
  const runtimeMs = Date.now() - startedAt;

  if (args.mode === 'a0') {
    console.log(JSON.stringify({
      mode: 'a0',
      filesProcessed: wanted.length,
      runtimeMs,
      tune: renderBucket(buckets.tune),
      heldout: renderBucket(buckets.heldout),
      all: renderBucket(buckets.all),
    }, null, 2));
  } else if (args.mode === 'grid' && arm === 'z1b') {
    const a1Tune = renderBucket(buckets.tune).A1;
    const rows = z1Configs.map((cfg, i) => ({ config: cfg, tune: renderZ1bBucket(z1bBuckets[i].tune) }));
    const pick = pickConfigZ1b(rows, a1Tune.tokens.median, a1Tune.tokens.mean);
    console.log(JSON.stringify({ mode: 'grid', arm: 'z1b', filesProcessed: wanted.length, runtimeMs, A1: a1Tune, rows, pick }, null, 2));
  } else if (args.mode === 'grid') {
    const a1Tune = renderBucket(buckets.tune).A1;
    const rows = z1Configs.map((cfg, i) => ({ config: cfg, tune: renderZ1Bucket(z1Buckets[i].tune) }));
    const pick = pickConfig(rows, a1Tune.tokens.median);
    console.log(JSON.stringify({ mode: 'grid', filesProcessed: wanted.length, runtimeMs, A1: a1Tune, rows, pick }, null, 2));
  } else if (args.mode === 'final' && arm === 'z1b') {
    const out = {
      mode: 'final', arm: 'z1b', filesProcessed: wanted.length, runtimeMs, config: z1Configs[0],
      since: args.since ?? null,
      datasetAudit: { autoCapturedTotal },
    };
    for (const split of ['tune', 'heldout', 'all']) {
      out[split] = {
        A1: renderBucket(buckets[split]).A1,
        Z1b: renderZ1bBucket(z1bBuckets[0][split]),
        nonRoutineFailures: nonRoutineFailures[split],
      };
    }
    console.log(JSON.stringify(out, null, 2));
    if (args.judgeOut) writeJudgeExport(args.judgeOut, judgeItems);
  } else if (args.mode === 'final') {
    const out = { mode: 'final', filesProcessed: wanted.length, runtimeMs, config: z1Configs[0] };
    for (const split of ['tune', 'heldout', 'all']) {
      out[split] = { A1: renderBucket(buckets[split]).A1, Z1: renderZ1Bucket(z1Buckets[0][split]) };
    }
    console.log(JSON.stringify(out, null, 2));
  } else if (args.mode === 'selftest' && arm === 'z1b') {
    const z1bAll = renderZ1bBucket(z1bBuckets[0].all);
    console.log(JSON.stringify({
      mode: 'selftest',
      arm: 'z1b',
      filesProcessed: wanted.length,
      hookPrompts: buckets.all.tokens.length,
      z1bEventsWithContext: z1bAll.reset.primary.withContext,
      addedEvents: z1bAll.addedEvents,
      z1bTokenMedian: z1bAll.tokens.median,
      failuresSeen: z1bAll.failuresSeen,
      blocksSent: z1bAll.blocksSent,
    }, null, 2));
  } else if (args.mode === 'selftest') {
    const z1All = renderZ1Bucket(z1Buckets[0].all);
    console.log(JSON.stringify({
      mode: 'selftest',
      filesProcessed: wanted.length,
      hookPrompts: buckets.all.tokens.length,
      z1EventsWithContext: z1All.reset.primary.withContext,
      z1TokenMedian: z1All.tokens.median,
    }, null, 2));
  } else {
    console.error(`unknown --mode ${args.mode}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
