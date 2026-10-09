// What each replay arm would inject for a prompt or a failure: A1, the Z1 static and recall blocks, the Z1b block.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { admitEntry } from './stores.mjs';

const DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', '..', 'dist');
const distImport = (f) => import(pathToFileURL(path.join(DIST, f)).href);
const { estimateTokens } = await distImport('util/token-text.js');
const { isWorthSurfacing } = await distImport('core/memory-quality.js');
const { contentTokens, gatePromptRecall, scoreOverlap } = await distImport('core/prompt-recall.js');

const PIN_BUDGET = 1500;

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

export function selectA1(localEntries, globalEntries, ts, projectName) {
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

export function renderBlock(items, totalTokens, heading = 'Project Memory') {
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

export function z1Candidates(localAdm, globalAdm, promptTok, opts = {}) {
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
export function computeZ1bBlock(localAdm, globalAdm, queryTok, gate) {
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
export function selectZ1Static(rankedPins) {
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
export function selectZ1Recall(precomputed, promptTok, gate, pinnedReserve) {
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
