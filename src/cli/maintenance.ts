// Store upkeep verbs: `hippo refine`, `hippo dedup` and `hippo embed`.

import { envAnthropicApiKey } from '../util/env.js';
import { loadAllEntries, loadAllEntryIds } from '../store/entry-reads.js';
import { deduplicateStore } from '../consolidate/dedupe.js';
import { embedAll } from '../store/embeddings/index.js';
import { resolveEmbeddingProvider, type EmbeddingProvider } from '../store/embeddings/provider.js';
import { loadEmbeddingIndex, resetStoredParticles } from '../store/vector-index.js';
import { loadConfig } from '../core/config.js';
import { refineStore } from './refine-llm.js';
import { printError } from './output.js';
import { boolFlag, type CommandContext } from './flag-values.js';
import { requireInit, resolveAuthRoot } from './shared.js';
import { errorMessage } from '../util/log.js';
import { CliExit } from './exit.js';

const MAX_FAILED_SHOWN = 5;
const MAX_PAIRS_SHOWN = 15;
const PAIR_PREVIEW_CHARS = 90;

export async function handleRefine({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  const apiKey = envAnthropicApiKey();
  if (!apiKey) {
    printError('hippo refine needs ANTHROPIC_API_KEY in the environment.');
    throw new CliExit(1);
  }

  const dryRun = boolFlag(flags, 'dry-run');
  const all = boolFlag(flags, 'all');
  const limit = flags['limit'] !== undefined ? parseInt(String(flags['limit']), 10) : undefined;
  const model = flags['model'] ? String(flags['model']) : undefined;
  const asJson = boolFlag(flags, 'json');

  const result = await refineStore(hippoRoot, {
    apiKey,
    model,
    limit,
    dryRun,
    all,
    tenantId,
  });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Scanned:  ${result.scanned} consolidated semantic memories`);
  console.log(`Refined:  ${result.refined}${dryRun ? '  (dry-run — no writes)' : ''}`);
  console.log(`Skipped:  ${result.skipped}`);
  console.log(`Failed:   ${result.failed}`);
  if (result.failed > 0) {
    console.log('\nFailures:');
    for (const d of result.details.filter((x) => x.status === 'failed').slice(0, MAX_FAILED_SHOWN)) {
      console.log(`  ${d.id}: ${d.reason}`);
    }
  }
}

export function handleDedup({ hippoRoot, flags }: CommandContext): void {
  requireInit(hippoRoot);

  const dryRun = boolFlag(flags, 'dry-run');
  if (flags['threshold'] !== undefined) {
    printError('hippo dedup: --threshold is ignored; a duplicate is the same text apart from spacing.');
  }

  const entries = loadAllEntries(hippoRoot);
  console.log(`Scanning ${entries.length} memories for duplicates (same text apart from spacing)${dryRun ? ' (dry run)' : ''}...\n`);

  const result = deduplicateStore(hippoRoot, { dryRun });

  if (result.removed === 0) {
    console.log('No duplicates found.');
    return;
  }

  printDedupGroups(result, dryRun);
  printDedupPairs(result, dryRun);
}

type DedupResult = ReturnType<typeof deduplicateStore>;

function printDedupGroups(result: DedupResult, dryRun: boolean): void {
  // Group by reason
  const sameLayerSem = result.pairs.filter(p => p.keptLayer === 'semantic' && p.removedLayer === 'semantic');
  const sameLayerEpi = result.pairs.filter(p => p.keptLayer === 'episodic' && p.removedLayer === 'episodic');
  const crossLayer = result.pairs.filter(p => p.keptLayer !== p.removedLayer);

  console.log(`${dryRun ? 'Would remove' : 'Removed'} ${result.removed} duplicates:`);
  if (sameLayerSem.length > 0) {
    console.log(`  ${sameLayerSem.length} redundant semantic memories (consolidation regenerated near-identical patterns)`);
  }
  if (sameLayerEpi.length > 0) {
    console.log(`  ${sameLayerEpi.length} duplicate episodic memories (same lesson learned from multiple sources)`);
  }
  if (crossLayer.length > 0) {
    console.log(`  ${crossLayer.length} cross-layer duplicates (episodic content already consolidated into semantic)`);
  }

}

function printDedupPairs(result: DedupResult, dryRun: boolean): void {
  // Show detailed pairs
  console.log('');
  const shown = result.pairs.slice(0, MAX_PAIRS_SHOWN);
  for (const pair of shown) {
    const simPct = (pair.similarity * 100).toFixed(0);
    const action = dryRun ? 'Would remove' : 'Removed';
    console.log(`  ${simPct}% similar | kept [${pair.keptLayer}] strength=${pair.keptStrength.toFixed(2)}`);
    console.log(`    ${pair.keptContent.slice(0, PAIR_PREVIEW_CHARS)}`);
    console.log(`  ${action} [${pair.removedLayer}] strength=${pair.removedStrength.toFixed(2)}`);
    console.log(`    ${pair.removedContent.slice(0, PAIR_PREVIEW_CHARS)}`);
    console.log('');
  }
  if (result.pairs.length > 15) {
    console.log(`  ... and ${result.pairs.length - 15} more (run with --dry-run to see all)`);
  }
}

// Embed command

export async function handleEmbed(
  { hippoRoot, flags }: CommandContext,
  given?: EmbeddingProvider,
): Promise<void> {
  // --global mirrors resolveAuthRoot: initGlobal() + the global root, skipping the local requireInit,
  // so it heals pre-1.27.0 global stores from a directory with no local .hippo.
  const root = resolveAuthRoot(hippoRoot, flags);

  // --status and --reset-physics only read cached state, so they must work with no provider key (e.g. removed after an earlier embed);
  // the provider-availability gate is deferred to the embed path.
  if (flags['reset-physics']) {
    resetPhysics(root);
    return;
  }

  if (flags['status']) {
    printEmbedStatus(root);
    return;
  }

  const provider = readyEmbedProvider(root, given);
  if (!provider) return;

  console.log('Embedding all memories (this may take a moment on first run to download model)...');
  let count: number;
  try {
    count = await embedAll(root, undefined, provider);
  } catch (err) {
    printError(`Embedding failed: ${errorMessage(err)}`);
    const partial = loadEmbeddingIndex(root);
    printError(
      `Partial progress saved: ${Object.keys(partial).length} embeddings on disk. Re-run \`hippo embed\` to resume.`,
    );
    process.exitCode = 1;
    return;
  }
  const entriesAfter = loadAllEntries(root);
  const embIndexAfter = loadEmbeddingIndex(root);
  console.log(`Done. ${count} new embeddings created. ${Object.keys(embIndexAfter).length}/${entriesAfter.length} total.`);
  const unembedded = entriesAfter.filter((e) => !embIndexAfter[e.id]).length;
  if (unembedded > 0) {
    printError(`${unembedded} memories are still not embedded (the warnings above name them). Re-run \`hippo embed\` to retry.`);
    process.exitCode = 1;
  }
}

function resetPhysics(root: string): void {
  const embIndex = loadEmbeddingIndex(root);
  const count = resetStoredParticles(root, loadAllEntryIds(root), embIndex);
  console.log(`Reset physics state: ${count} particles re-initialized from embeddings.`);
}

function printEmbedStatus(root: string): void {
  const entries = loadAllEntries(root);
  const embIndex = loadEmbeddingIndex(root);
  const activeIds = new Set(entries.map((e) => e.id));
  const activeEmbedded = Object.keys(embIndex).filter((id) => activeIds.has(id)).length;
  const orphaned = Object.keys(embIndex).length - activeEmbedded;
  console.log(`Embedding status: ${activeEmbedded}/${entries.length} memories embedded`);
  if (orphaned > 0) {
    console.log(`  ${orphaned} orphaned embeddings (run \`hippo embed\` to prune)`);
  }
  const missing = entries.filter((e) => !embIndex[e.id]);
  if (missing.length > 0) {
    console.log(`  ${missing.length} memories need embedding (run \`hippo embed\` to embed them)`);
  }
}

/** The provider to embed with, or null after saying why none is usable. */
function readyEmbedProvider(root: string, given?: EmbeddingProvider): EmbeddingProvider | null {
  // Embedding (unlike status/reset) needs an available provider.
  const embedProvider = given ?? (() => {
    try {
      return resolveEmbeddingProvider(root);
    } catch (err) {
      printError(errorMessage(err));
      return null;
    }
  })();
  if (!embedProvider) {
    process.exitCode = 1;
    return null;
  }
  if (embedProvider.isAvailable()) return embedProvider;
  if (loadConfig(root).embeddings.enabled === false) {
    console.log('Embeddings are disabled in config (embeddings.enabled = false). Set it to true or "auto" to enable.');
    return null;
  }
  if (embedProvider.kind === 'local') {
    console.log('Embeddings not available. Install @huggingface/transformers to enable:');
    console.log('  npm install @huggingface/transformers');
    process.exitCode = 1;
  } else {
    printError(
      `Embedding provider '${embedProvider.kind}' is configured but ${embedProvider.keyEnv} is not set.`,
    );
    printError(`Export ${embedProvider.keyEnv}, or set config.embeddings.provider back to 'local'.`);
    process.exitCode = 1;
  }
  return null;
}
