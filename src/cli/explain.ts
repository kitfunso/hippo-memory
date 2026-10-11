// The `hippo explain` verb; main() loads it lazily from the command table.

import { confidenceFacets } from '../core/memory.js';
import { DEFAULT_RECALL_BUDGET, type SearchResult } from '../core/search-types.js';
import { loadConfig } from '../core/config.js';
import { dropHeldCopies } from '../util/same-text.js';
import { detectScope } from '../sharing/scope.js';
import { getGlobalRoot } from '../sharing/global-store.js';
import * as api from '../api/index.js';
import { cliRecallOrigin, scopeHiddenCount } from '../api/recall-cli.js';
import { cliApiContext } from './api-context.js';
import type { RankRecallResult } from '../api/recall-pipeline.js';
import { printedTokens } from '../api/context-render.js';
import { printError } from './output.js';
import { parseLimitFlag, parseBudgetFlag, type CliFlags, type CommandContext, parseAsOfFlag, engineFlags, boolFlag } from './flag-values.js';
import { requireInit } from './shared.js';
import { fmt, recallEntryText, recallHeading } from './print.js';
import { CliExit } from './exit.js';

const EXPLAIN_PREVIEW_CHARS = 48;

/** The SQL predicate drops denied rows before the window, so an unscoped probe counts what the policy hides. */
function noteScopeHidden(ctx: api.Context, globalRoot: string | undefined, query: string, requested: string | undefined): void {
  const hidden = scopeHiddenCount(ctx, query, globalRoot, requested);
  if (hidden > 0) {
    printError(`[note] ${hidden} candidate${hidden === 1 ? '' : 's'} hidden by recall scope policy (pass an explicit --scope to inspect).`);
  }
}

/** Where the read-only ranking lands; a `let` the callback assigned would read as never-assigned after the await. */
interface InspectedSlot { rank?: RankRecallResult }

async function cmdExplain(
  hippoRoot: string,
  tenantId: string,
  query: string,
  flags: CliFlags
): Promise<void> {
  requireInit(hippoRoot);

  const budget = parseBudgetFlag(flags['budget'], DEFAULT_RECALL_BUDGET);
  const limit = parseLimitFlag(flags['limit']);
  const asJson = boolFlag(flags, 'json');
  const includeSuperseded = boolFlag(flags, 'include-superseded');
  const asOf = parseAsOfFlag(flags);
  const globalRoot = getGlobalRoot();
  const ctx = cliApiContext(hippoRoot, tenantId);
  // Explain shows what recall would see, so it applies the same scope rule.
  const explicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  const activeScope = explicitScope || detectScope();
  // Unlike recall, explain reads the global store whenever it exists, even when it is the local root.
  const origin = cliRecallOrigin(ctx, { globalRoot, primaryIsGlobal: false, activeScope });
  const explainGlobalOn = origin.globalOn;
  noteScopeHidden(ctx, explainGlobalOn ? globalRoot : undefined, query, explicitScope || undefined);

  const config = loadConfig(hippoRoot);
  const engine = engineFlags(flags, config);
  // Priced as recall prints each result, so explain returns what recall's engines would.
  const cost = (r: SearchResult): number => printedTokens(recallEntryText(r, query, false, origin.isGlobal(r.entry.id)));
  const entryBudget = Math.max(0, budget - printedTokens(recallHeading(budget, budget, query)));

  const slot: InspectedSlot = {};
  await api.retrieve(
    ctx,
    {
      query,
      cliCore: {
        rank: {
          budget: entryBudget, cost, limit, includeSuperseded, asOf,
          explicitScope, activeScope,
          search: { ...engine, multihop: false, explain: true },
        },
        sources: { globalRoot: explainGlobalOn ? globalRoot : undefined },
        inspect: (ranking) => { slot.rank = ranking; },
      },
    },
  );
  const rank = slot.rank;
  if (!rank) throw new Error('explain ranked but inspected nothing');
  printExplainResults(rank, engine.usePhysics, query, asJson);
}

function printExplainResults(rank: RankRecallResult, usePhysics: boolean, query: string, asJson: boolean): void {
  const hasGlobal = rank.globalEntries.length > 0;
  const modeUsed: 'physics' | 'searchBothHybrid' | 'hybrid' = usePhysics && !hasGlobal
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
    const preview = r.entry.content.replace(/\s+/g, ' ').slice(0, EXPLAIN_PREVIEW_CHARS);
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

export async function handleExplain({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const query = args.join(' ').trim();
  if (!query) {
    printError('Please provide a search query.');
    throw new CliExit(1);
  }
  await cmdExplain(hippoRoot, tenantId, query, flags);
}
