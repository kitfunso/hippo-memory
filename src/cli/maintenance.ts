// Store upkeep verbs: `hippo refine`, `hippo dedup` and `hippo embed`.

import { envAnthropicApiKey } from '../util/env.js';
import { deduplicateStore } from '../consolidate/dedupe.js';
import { resolveEmbeddingProvider, type EmbeddingProvider } from '../embeddings/provider.js';
import { embedCoverage, embedMissingMemories, resetPhysicsFromVectors, storedVectorCount } from '../api/embeddings.js';
import { listMemories } from '../api/memories.js';
import { cliApiContext } from './api-context.js';
import type * as api from '../api/index.js';
import { loadConfig } from '../core/config.js';
import { refineStore } from './refine-llm.js';
import { printError } from './output.js';
import { boolFlag, numberFlag, type CommandContext } from './flag-values.js';
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
  const limit = numberFlag(flags, 'limit');
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

export function handleDedup({ hippoRoot, tenantId, flags }: CommandContext): void {
  requireInit(hippoRoot);

  const dryRun = boolFlag(flags, 'dry-run');
  if (flags['threshold'] !== undefined) {
    printError('hippo dedup: --threshold is ignored; a duplicate is the same text apart from spacing.');
  }

  const entries = listMemories(cliApiContext(hippoRoot, tenantId), { everyTenant: true });
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
  { hippoRoot, tenantId, flags }: CommandContext,
  given?: EmbeddingProvider,
): Promise<void> {
  // --global mirrors resolveAuthRoot: initGlobal() + the global root, skipping the local requireInit,
  // so it heals pre-1.27.0 global stores from a directory with no local .hippo.
  const root = resolveAuthRoot(hippoRoot, flags);
  const ctx = cliApiContext(root, tenantId);

  // --status and --reset-physics only read cached state, so they must work with no provider key (e.g. removed after an earlier embed);
  // the provider-availability gate is deferred to the embed path.
  if (flags['reset-physics']) {
    resetPhysics(ctx);
    return;
  }

  if (flags['status']) {
    printEmbedStatus(ctx);
    return;
  }

  const provider = readyEmbedProvider(root, given);
  if (!provider) return;

  console.log('Embedding all memories (this may take a moment on first run to download model)...');
  let count: number;
  try {
    count = await embedMissingMemories(ctx, provider);
  } catch (err) {
    printError(`Embedding failed: ${errorMessage(err)}`);
    printError(
      `Partial progress saved: ${storedVectorCount(ctx)} embeddings on disk. Re-run \`hippo embed\` to resume.`,
    );
    process.exitCode = 1;
    return;
  }
  const after = embedCoverage(ctx);
  console.log(`Done. ${count} new embeddings created. ${after.vectorIds.length}/${after.memoryIds.length} total.`);
  const embeddedAfter = new Set(after.vectorIds);
  const unembedded = after.memoryIds.filter((id) => !embeddedAfter.has(id)).length;
  if (unembedded > 0) {
    printError(`${unembedded} memories are still not embedded (the warnings above name them). Re-run \`hippo embed\` to retry.`);
    process.exitCode = 1;
  }
}

function resetPhysics(ctx: api.Context): void {
  const count = resetPhysicsFromVectors(ctx);
  console.log(`Reset physics state: ${count} particles re-initialized from embeddings.`);
}

function printEmbedStatus(ctx: api.Context): void {
  const { memoryIds, vectorIds } = embedCoverage(ctx);
  const activeIds = new Set(memoryIds);
  const activeEmbedded = vectorIds.filter((id) => activeIds.has(id)).length;
  const orphaned = vectorIds.length - activeEmbedded;
  console.log(`Embedding status: ${activeEmbedded}/${memoryIds.length} memories embedded`);
  if (orphaned > 0) {
    console.log(`  ${orphaned} orphaned embeddings (run \`hippo embed\` to prune)`);
  }
  const embedded = new Set(vectorIds);
  const missing = memoryIds.filter((id) => !embedded.has(id));
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
