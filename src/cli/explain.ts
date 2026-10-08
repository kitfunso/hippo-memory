// The `hippo explain` verb; main() loads it lazily from the command table.

import { confidenceFacets } from '../memory.js';
import { isInitialized } from '../store/open.js';
import { loadSearchEntries } from '../store/search-rows.js';
import { loadIndex } from '../store/index-and-stats.js';
import { DEFAULT_RECALL_BUDGET, type SearchResult } from '../search/types.js';
import { loadConfig } from '../config.js';
import { dropHeldCopies } from '../same-text.js';
import { detectScope } from '../scope.js';
import { getGlobalRoot } from '../shared.js';
import * as api from '../api.js';
import { resolveTenantId } from '../tenant.js';
import type { RankRecallResult } from '../recall-pipeline.js';
import { printedTokens } from '../context-render.js';
import { printError } from './output.js';
import {
  parseLimitFlag,
  parseBudgetFlag,
  requireInit,
  fmt,
  recallEntryText,
  recallHeading,
  type CliFlags,
  type CommandContext,
  parseAsOfFlag,
  engineFlags,
} from './shared.js';

/** The SQL predicate drops denied rows before the window, so an unscoped probe counts what the policy hides. */
function noteScopeHidden(hippoRoot: string, globalRoot: string | undefined, query: string, tenantId: string, requested: string | undefined): void {
  const probe = [
    ...loadSearchEntries(hippoRoot, query, undefined, tenantId),
    ...(globalRoot ? loadSearchEntries(globalRoot, query, undefined, tenantId) : []),
  ];
  // Window-capped, so the count is a floor on large stores; fine for a "why is my row missing" hint.
  const hidden = probe.filter((e) => !api.passesCliRecallScopeFilter(e.scope ?? null, requested)).length;
  if (hidden > 0) {
    printError(`[note] ${hidden} candidate${hidden === 1 ? '' : 's'} hidden by recall scope policy (pass an explicit --scope to inspect).`);
  }
}

/** Where the read-only ranking lands; a `let` the callback assigned would read as never-assigned after the await. */
interface InspectedSlot { rank?: RankRecallResult }

export async function cmdExplain(
  hippoRoot: string,
  query: string,
  flags: CliFlags
): Promise<void> {
  requireInit(hippoRoot);

  const budget = parseBudgetFlag(flags['budget'], DEFAULT_RECALL_BUDGET);
  const limit = parseLimitFlag(flags['limit']);
  const asJson = Boolean(flags['json']);
  const includeSuperseded = Boolean(flags['include-superseded']);
  const asOf = parseAsOfFlag(flags);
  const globalRoot = getGlobalRoot();
  const tenantId = resolveTenantId({});
  // Explain shows what recall would see, so it applies the same scope rule.
  const explicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  // Unlike recall, explain reads the global store whenever it exists, even when it is the local root.
  const explainGlobalOn = isInitialized(globalRoot);
  noteScopeHidden(hippoRoot, explainGlobalOn ? globalRoot : undefined, query, tenantId, explicitScope || undefined);

  const config = loadConfig(hippoRoot);
  const engine = engineFlags(flags, config);
  // Priced as recall prints each result, so explain returns what recall's engines would.
  const explainIndex = loadIndex(hippoRoot);
  const cost = (r: SearchResult): number =>
    printedTokens(recallEntryText(r, query, false, explainGlobalOn && !explainIndex.entries[r.entry.id]));
  const entryBudget = Math.max(0, budget - printedTokens(recallHeading(budget, budget, query)));

  const slot: InspectedSlot = {};
  await api.retrieve(
    { hippoRoot, tenantId, actor: api.adminActor('cli') },
    {
      query,
      cliCore: {
        rank: {
          budget: entryBudget, cost, limit, includeSuperseded, asOf,
          explicitScope, activeScope: explicitScope || detectScope(),
          search: { ...engine, multihop: false, explain: true },
        },
        sources: { globalRoot: explainGlobalOn ? globalRoot : undefined },
        inspect: (ranking) => { slot.rank = ranking; },
      },
    },
  );
  const rank = slot.rank;
  if (!rank) throw new Error('explain ranked but inspected nothing');
  const hasGlobal = rank.globalEntries.length > 0;
  const modeUsed: 'physics' | 'searchBothHybrid' | 'hybrid' = engine.usePhysics && !hasGlobal
    ? 'physics'
    : hasGlobal ? 'searchBothHybrid' : 'hybrid';
  const results = dropHeldCopies(rank.results, (r) => r.entry);

  const candidates = rank.localEntries.length + rank.globalEntries.length;

  if (asJson) {
    printExplainJson(results, query, modeUsed, candidates);
    return;
  }

  if (results.length === 0) {
    console.log(`No memories matched "${query}" (scanned ${candidates}).`);
    return;
  }

  printExplainTable(results, query, modeUsed, candidates);
  results.forEach((r, i) => printExplainBreakdown(r, i));

  console.log('Note: explain does not mark memories as retrieved (read-only).');
}

function printExplainJson(results: SearchResult[], query: string, modeUsed: string, candidates: number): void {
  const output = results.map((r, rank) => ({
    rank: rank + 1,
    id: r.entry.id,
    layer: r.entry.layer,
    confidence: confidenceFacets(r.entry).tier,
    aged_out: confidenceFacets(r.entry).agedOut,
    score: r.score,
    tokens: r.tokens,
    tags: r.entry.tags,
    content: r.entry.content,
    breakdown: r.breakdown,
  }));
  console.log(JSON.stringify({
    query,
    mode: modeUsed,
    candidates,
    returned: output.length,
    results: output,
  }));
}

function printExplainTable(results: SearchResult[], query: string, modeUsed: string, candidates: number): void {
  console.log(`Query: "${query}"`);
  console.log(`Mode:  ${modeUsed}   candidates: ${candidates}   returned: ${results.length}`);
  console.log();
  console.log('Rank  Score   Strength  Age    Layer      ID                Preview');
  console.log('----- ------- --------- ------ ---------- ----------------- ---------------------------------');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const b = r.breakdown;
    const preview = r.entry.content.replace(/\s+/g, ' ').slice(0, 48);
    const ageStr = b ? `${b.ageDays}d` : '?';
    console.log(
      `${String(i + 1).padEnd(5)} ${fmt(r.score, 3).padEnd(7)} ${fmt(r.entry.strength).padEnd(9)} ${ageStr.padEnd(6)} ${r.entry.layer.padEnd(10)} ${r.entry.id.padEnd(17)} ${preview}`,
    );
  }
  console.log();
}

function printExplainBreakdown(r: SearchResult, i: number): void {
  const b = r.breakdown;
  console.log(`[${i + 1}] ${r.entry.id}   composite=${fmt(r.score, 4)}`);
  if (!b) {
    console.log('    (no breakdown available)');
    console.log();
    return;
  }
  if (b.mode === 'physics') {
    console.log(`    mode:      physics-gravity`);
    console.log(`    cosine:    ${fmt(b.cosine, 3)}  (pre-amp baseline)`);
    console.log(`    final:     ${fmt(b.final, 4)}  (post-amp, from physics scorer)`);
  } else {
    const matched = b.matchedTerms.length > 0 ? b.matchedTerms.join(', ') : '(none)';
    console.log(`    mode:      ${b.mode}${b.mode === 'hybrid-no-vec' ? '  (no cached doc vector — run `hippo embed`)' : ''}`);
    console.log(`    BM25:      raw=${fmt(r.bm25, 3)}  normalized=${fmt(b.normBm25, 3)}  weight=${fmt(b.bm25Weight, 2)}  matched=[${matched}]`);
    console.log(`    embedding: cosine=${fmt(b.cosine, 3)}  weight=${fmt(b.embeddingWeight, 2)}`);
    console.log(`    base:      ${fmt(b.bm25Weight, 2)}*${fmt(b.normBm25, 3)} + ${fmt(b.embeddingWeight, 2)}*${fmt(b.cosine, 3)} = ${fmt(b.base, 4)}`);
    console.log(`    strength:  x${fmt(b.strengthMultiplier, 3)}  (strength=${fmt(r.entry.strength, 3)})`);
    console.log(`    recency:   x${fmt(b.recencyMultiplier, 3)}  (age=${b.ageDays}d)`);
    if (b.decisionBoost !== 1) console.log(`    decision:  x${fmt(b.decisionBoost, 2)}  (tagged 'decision')`);
    if (b.scopeBoost !== 1) console.log(`    scope:     x${fmt(b.scopeBoost, 2)}  (scope tag ${b.scopeBoost > 1 ? 'match' : 'mismatch'})`);
    if (b.pathBoost !== 1) console.log(`    path:      x${fmt(b.pathBoost, 3)}  (cwd path tag overlap)`);
    if (b.sourceBump !== 1) console.log(`    source:    x${fmt(b.sourceBump, 2)}  (local priority bump over global)`);
    if (b.outcomeBoost !== 1) console.log(`    outcome:   x${fmt(b.outcomeBoost, 3)}  (user feedback: pos-neg = ${(r.entry.outcome_positive ?? 0) - (r.entry.outcome_negative ?? 0)})`);
    if (b.churnStaleMultiplier !== 1) console.log(`    churn:     x${fmt(b.churnStaleMultiplier, 2)}  (tagged 'churn-stale')`);
    if (b.preMmrRank !== undefined && b.postMmrRank !== undefined && b.preMmrRank !== b.postMmrRank) {
      const arrow = b.postMmrRank < b.preMmrRank ? 'up' : 'down';
      console.log(`    mmr:       rank ${b.preMmrRank} -> ${b.postMmrRank}  (diversity ${arrow})`);
    }
    console.log(`    final:     ${fmt(b.final, 4)}`);
  }
  console.log();
}

export async function handleExplain({ hippoRoot, args, flags }: CommandContext): Promise<void> {
  const query = args.join(' ').trim();
  if (!query) {
    printError('Please provide a search query.');
    process.exit(1);
  }
  await cmdExplain(hippoRoot, query, flags);
}
