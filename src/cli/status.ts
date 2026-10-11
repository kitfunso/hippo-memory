// Read-only report verbs: status, inspect, tokens, failures, provenance, correction latency, doctor and support bundle.

import { envHomeDir } from '../util/env.js';
import { evalNow } from '../core/ablation.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'node:url';
import { calculateStrength, calculateRewardFactor, resolveConfidence, Layer } from '../core/memory.js';
import { loadCorrectionEntries, loadRawEntries } from '../store/report-reads.js';
import { loadStats } from '../store/index-and-stats.js';
import { loadStatusCounts, type StatusCounts } from '../store/candidates.js';
import { embeddingModelRequiresReindex } from '../store/embeddings/index.js';
import { resolveEmbeddingProvider } from '../embeddings/provider.js';
import { loadStoredParticles, storedVectorSummary } from '../store/vector-index.js';
import { computeSystemEnergy, vecNorm, type PhysicsParticle } from '../core/physics.js';
import { loadConfig } from '../core/config.js';
import { runDoctor, formatDoctor } from '../doctor.js';
import { buildSupportBundle, TAIL_MAX_LINES } from '../support-bundle.js';
import { PACKAGE_VERSION } from '../util/version.js';
import { FAILURE_LOG_RETENTION_DAYS } from '../store/failure-log.js';
import { getGlobalRoot } from '../sharing/global-store.js';
import { buildProvenanceCoverage } from './provenance-coverage.js';
import { buildCorrectionLatency } from './correction-latency.js';
import * as api from '../api/index.js';
import { getMemory } from '../api/memories.js';
import { cliApiContext } from './api-context.js';
import { errorMessage, log } from '../util/log.js';
import { printError } from './output.js';
import { parseCountFlag, type CommandContext, stringFlagOrExit, flagIsTrue } from './flag-values.js';
import { requireInit, resolveAuthRoot } from './shared.js';
import { fmt } from './print.js';
import { isJsonObject } from '../util/json.js';
import { hookStoreRoot } from './hook-runtime.js';
import { DAY_MS } from '../util/time.js';
import { CliExit } from './exit.js';

export function handleStatus({ hippoRoot }: CommandContext): void {
  requireInit(hippoRoot);

  const stats = loadStats(hippoRoot);
  const counts = loadStatusCounts(hippoRoot, evalNow(), 0.2);
  const { byLayer, byConfidence, pinned, atRisk, agedOut, avgStrength } = counts;

  console.log('Hippo Status');
  console.log('---------------------------');
  console.log(`Total memories:    ${counts.total}`);
  console.log(`  Buffer:          ${byLayer[Layer.Buffer]}`);
  console.log(`  Episodic:        ${byLayer[Layer.Episodic]}`);
  console.log(`  Semantic:        ${byLayer[Layer.Semantic]}`);
  console.log(`  Trace:           ${byLayer[Layer.Trace]}`);
  console.log(`Pinned:            ${pinned}`);
  console.log(`At risk (<0.2):    ${atRisk}`);
  console.log(`Open conflicts:    ${counts.openConflicts}`);
  console.log(`Avg strength:      ${fmt(avgStrength)}`);
  console.log('');
  console.log('Confidence breakdown:');
  console.log(`  Verified:        ${byConfidence['verified'] ?? 0}`);
  console.log(`  Observed:        ${byConfidence['observed'] ?? 0}`);
  console.log(`  Inferred:        ${byConfidence['inferred'] ?? 0}`);
  console.log(`  Stale:           ${byConfidence['stale'] ?? 0}`);
  console.log(`  Aged out:        ${agedOut}  (of the above; excludes pinned, verified)`);
  console.log('');
  console.log(`Total remembered:  ${stats.total_remembered ?? 0}`);
  console.log(`Total recalled:    ${stats.total_recalled ?? 0}`);
  console.log(`Total forgotten:   ${stats.total_forgotten ?? 0}`);

  const runs = stats.consolidation_runs ?? [];
  if (Array.isArray(runs) && runs.length > 0) {
    const last = runs[runs.length - 1];
    console.log(`Last sleep:        ${isJsonObject(last) ? last['timestamp'] : undefined}`);
  } else {
    console.log(`Last sleep:        never`);
  }

  printEmbeddingStatus(hippoRoot, counts);
  printPhysicsStatus(hippoRoot);
}

// Embedding status (provider-aware)
function printEmbeddingStatus(hippoRoot: string, counts: Pick<StatusCounts, 'total' | 'embedded'>): void {
  const embedProvider = (() => {
    try {
      return resolveEmbeddingProvider(hippoRoot);
    } catch {
      // Status reports a bad provider config as "misconfigured" below instead of failing.
      return null;
    }
  })();
  console.log('');
  if (!embedProvider) {
    console.log(`Embeddings:        misconfigured (check embeddings.provider / apiBaseUrl), BM25 only`);
    return;
  }
  const embeddingsDisabled = loadConfig(hippoRoot).embeddings.enabled === false;
  const embAvail = embedProvider.isAvailable();
  if (embeddingsDisabled) {
    console.log(`Embeddings:        disabled in config (embeddings.enabled = false), BM25 only`);
  } else if (embedProvider.kind === 'local') {
    console.log(`Embeddings:        ${embAvail ? `available [${embedProvider.id}]` : 'not installed (BM25 only)'}`);
  } else if (embAvail) {
    console.log(`Embeddings:        ${embedProvider.kind} api [${embedProvider.id}]`);
  } else {
    console.log(`Embeddings:        ${embedProvider.kind} configured but ${embedProvider.keyEnv} not set (BM25 only)`);
  }
  // Show cached counts whenever vectors exist on disk (even when disabled or
  // the key was removed), so the user still sees what is already indexed.
  const { ids: embeddedIds, dims } = storedVectorSummary(hippoRoot);
  if (!embAvail && embeddedIds.size === 0) return;
  const orphaned = embeddedIds.size - counts.embedded;
  let line = `Embedded:          ${counts.embedded}/${counts.total} memories`;
  if (dims) line += ` (${dims}-dim)`;
  if (orphaned > 0) line += ` (${orphaned} orphaned, run \`hippo embed\` to prune)`;
  console.log(line);
  // No index argument: the check then asks SQLite whether any vector exists instead of loading them.
  if (embeddingModelRequiresReindex(hippoRoot, embedProvider.id)) {
    console.log(`                   model changed, run \`hippo embed\` to reindex`);
  }
}

// The all-pairs energy sum is quadratic, so a large particle set skips it.
const PHYSICS_ENERGY_STATUS_MAX = 2000;

// Physics status
function printPhysicsStatus(hippoRoot: string): void {
  try {
    const particles = loadStoredParticles(hippoRoot);
    if (particles.length > 0) {
      let sumVelMag = 0;
      for (const p of particles) sumVelMag += vecNorm(p.velocity);
      const avgVelMag = sumVelMag / particles.length;
      console.log('');
      console.log(`Physics: ${particles.length} particles, ${physicsEnergyText(particles, loadConfig(hippoRoot).physics.G_memory)}, avg vel: ${fmt(avgVelMag, 4)}`);
    }
  } catch (err) {
    // The physics table may not exist yet, so status prints without that line.
    log.debug(`physics status skipped: ${errorMessage(err)}`);
  }
}

export function physicsEnergyText(particles: PhysicsParticle[], gMemory: number): string {
  if (particles.length > PHYSICS_ENERGY_STATUS_MAX) return `energy: skipped (${particles.length} particles)`;
  const energy = computeSystemEnergy(particles, gMemory);
  return `energy: ${fmt(energy.total, 4)} (KE: ${fmt(energy.kinetic, 4)}, PE: ${fmt(energy.potential, 4)})`;
}

async function cmdInspect(hippoRoot: string, tenantId: string, id: string): Promise<void> {
  requireInit(hippoRoot);

  const entry = await getMemory(cliApiContext(hippoRoot, tenantId), id);
  if (!entry) {
    printError(`Memory not found: ${id}`);
    throw new CliExit(1);
  }

  const now = evalNow();
  const currentStrength = calculateStrength(entry, now);
  const lastRetrieved = new Date(entry.last_retrieved);
  const created = new Date(entry.created);
  const ageDays = (now.getTime() - created.getTime()) / DAY_MS;
  const daysSince = (now.getTime() - lastRetrieved.getTime()) / DAY_MS;

  const effectiveConfidence = resolveConfidence(entry, now);

  console.log(`Memory: ${entry.id}`);
  console.log('---------------------------');
  console.log(`Layer:            ${entry.layer}`);
  console.log(`Confidence:       ${entry.confidence}${effectiveConfidence !== entry.confidence ? ` (effective: ${effectiveConfidence})` : ''}`);
  console.log(`Created:          ${entry.created} (${fmt(ageDays, 1)}d ago)`);
  console.log(`Last retrieved:   ${entry.last_retrieved} (${fmt(daysSince, 1)}d ago)`);
  console.log(`Retrieval count:  ${entry.retrieval_count}`);
  console.log(`Strength (live):  ${fmt(currentStrength)} (stored: ${fmt(entry.strength)})`);
  console.log(`Half-life:        ${entry.half_life_days}d`);
  console.log(`Emotional:        ${entry.emotional_valence}`);
  console.log(`Schema fit:       ${entry.schema_fit}`);
  console.log(`Pinned:           ${entry.pinned}`);
  console.log(`Tags:             ${entry.tags.join(', ') || 'none'}`);
  const rewardFactor = calculateRewardFactor(entry);
  const pos = entry.outcome_positive ?? 0;
  const neg = entry.outcome_negative ?? 0;
  const outcomeLabel = pos === 0 && neg === 0
    ? 'none'
    : `+${pos} / -${neg} (reward factor: ${fmt(rewardFactor)})`;
  console.log(`Outcomes:         ${outcomeLabel}`);
  if (entry.conflicts_with.length > 0) {
    console.log(`Conflicts with:   ${entry.conflicts_with.join(', ')}`);
  }
  console.log('');
  console.log('Content:');
  console.log('-'.repeat(40));
  console.log(entry.content);
}

/** `hippo tokens [--days <n>] [--json] [--global]`: the token ledger per surface, tokens saved by skipped unchanged blocks, and re-read hook tokens.
 * Counts are estimates (characters / 4), the same estimate every budget uses. */
export function handleTokens({ hippoRoot, tenantId, flags }: CommandContext): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const ctx = cliApiContext(root, tenantId);
  const days = parseCountFlag(flags['days']);
  const summary = api.tokenSummary(ctx, { days: days > 0 ? days : undefined });
  if (flags['json']) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const windowDays = days > 0 ? days : 30;
  if (summary.surfaces.length === 0) {
    console.log(`No memory text recorded in the last ${windowDays} days.`);
    return;
  }
  console.log(`Memory text handed to agents, last ${windowDays} days (estimated tokens, characters / 4)\n`);
  console.log(
    `  ${'surface'.padEnd(14)}${'sent'.padStart(8)}${'tokens'.padStart(12)}${'skipped'.padStart(10)}${'saved'.padStart(12)}`
    + `${'re-read'.padStart(12)}`,
  );
  for (const row of summary.surfaces) {
    console.log(
      `  ${row.surface.padEnd(14)}${String(row.injected).padStart(8)}${String(row.tokens).padStart(12)}`
      + `${String(row.skipped).padStart(10)}${String(row.tokensAvoided).padStart(12)}${String(row.tokensReread).padStart(12)}`,
    );
  }
  console.log('');
  console.log(`  Total sent: ${summary.totalTokens} tokens. Saved by skipping unchanged blocks: ${summary.totalTokensAvoided}.`);
  console.log(
    `  Re-read by later model calls until compaction: ${summary.totalTokensReread} tokens,`
    + ` counted for ${summary.rereadSessions} of ${summary.hookSessions} sessions.`,
  );
  if (summary.meanTokensPerSession > 0) {
    console.log(`  Mean per session (rows with a session id): ${summary.meanTokensPerSession} tokens.`);
  }
  console.log('  Re-reads are counted for hook and compact-resume blocks when a session ends; other surfaces, and open or crashed sessions, show sent only.');
  console.log("  Re-reads usually bill at the provider's cached-input rate, a fraction of the full input price.");
}

/** `hippo failures [--days <n>] [--json] [--global]`: failed tool calls by outcome, and repeats across sessions. */
export function handleFailures({ hippoRoot, tenantId, flags }: CommandContext): void {
  // The store the capture-error hook writes to; a report never creates one.
  const root = flags['global'] ? getGlobalRoot() : hookStoreRoot(hippoRoot);
  requireInit(root);
  const ctx = cliApiContext(root, tenantId);
  const days = parseCountFlag(flags['days']);
  const summary = api.failureSummary(ctx, { days: days > 0 ? days : undefined });
  if (flags['json']) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const windowDays = days > 0 ? days : 30;
  const kept = windowDays > FAILURE_LOG_RETENTION_DAYS ? ` (rows are kept ${FAILURE_LOG_RETENTION_DAYS} days)` : '';
  if (summary.total === 0) {
    console.log(`No failed tool calls recorded in the last ${windowDays} days${kept}.`);
    return;
  }
  const o = summary.outcomes;
  const errors = o.stored + o.duplicate + o['store-failed'];
  const unsaved = o['store-failed'] > 0 ? `, ${o['store-failed']} could not be saved` : '';
  const rows: ReadonlyArray<readonly [string, number, string]> = [
    ['errors', errors, `(${o.stored} new, ${o.duplicate} already in memory${unsaved})`],
    ['routine', o['skipped-routine'], ''],
    ['interrupted', o['skipped-interrupt'], ''],
    ['unreadable', o['skipped-invalid'], ''],
  ];
  console.log(`Failed tool calls seen by the capture-error hook, last ${windowDays} days${kept}\n`);
  for (const [label, count, note] of rows) {
    console.log(`  ${label.padEnd(13)}${String(count).padStart(6)}  ${note}`.trimEnd());
  }
  // Counts, not a rate: a share means little without a holdout arm to compare against.
  if (summary.rated > 0) {
    const noSession = errors - summary.rated;
    const unrated = noSession > 0 ? ` ${noSession} more had no session id.` : '';
    console.log(`\n  Repeats: ${summary.repeats} of ${summary.rated} errors first happened in another session.${unrated}`);
  }
}

export function handleCorrectionLatency({ hippoRoot, flags }: CommandContext): void {
  requireInit(hippoRoot);
  const report = buildCorrectionLatency(loadCorrectionEntries(hippoRoot));
  if (flags['json']) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.count === 0) {
    console.log('No supersessions found. Correction latency is undefined.');
  } else {
    const fmt = (ms: number | null) => {
      if (ms === null) return 'n/a';
      if (ms < 1000) return `${ms}ms`;
      if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
      if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
      return `${(ms / 3_600_000).toFixed(1)}h`;
    };
    console.log(`Corrections: ${report.count} total (${report.extractionCount} extraction-driven, ${report.manualCount} manual)`);
    console.log(`Latency p50: ${fmt(report.p50Ms)}, p95: ${fmt(report.p95Ms)}, max: ${fmt(report.maxMs)}`);
    if (report.extractionCount === 0 && report.manualCount > 0) {
      console.log(`\nAll ${report.manualCount} corrections were manual supersedes: no measurable observation lag.`);
      console.log(`To measure latency, route corrections through extraction (set new.extracted_from to the raw receipt).`);
    }
  }
}

export function handleProvenance({ hippoRoot, flags }: CommandContext): void {
  requireInit(hippoRoot);
  const coverage = buildProvenanceCoverage(loadRawEntries(hippoRoot));
  if (flags['json']) {
    console.log(JSON.stringify(coverage, null, 2));
  } else if (coverage.rawTotal === 0) {
    console.log('No kind=raw memories present. Coverage gate trivially satisfied.');
  } else {
    const pct = (coverage.coverage * 100).toFixed(1);
    console.log(`Provenance coverage: ${coverage.rawWithEnvelope}/${coverage.rawTotal} raw rows envelope-complete (${pct}%)`);
    if (coverage.gaps.length > 0) {
      console.log(`\nGaps:`);
      for (const g of coverage.gaps) {
        console.log(`  ${g.id}: missing ${g.missing.join(', ')}`);
      }
    }
  }
  if (flags['strict'] && coverage.coverage < 1) {
    throw new CliExit(1);
  }
}

export function handleDoctor({ flags }: CommandContext): void {
  // SAFETY: package.json always carries a string "version" (checked at release by check-manifest-versions).
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf-8')) as { version: string };
  const report = runDoctor({ version: pkg.version });
  console.log(flags['json'] ? JSON.stringify(report, null, 2) : formatDoctor(report));
  if (!report.ok) throw new CliExit(1);
}

export function handleSupportBundle({ flags }: CommandContext): void {
  const outFlag = stringFlagOrExit(flags, 'out');
  if (outFlag === '') {
    printError('--out requires a file path.');
    throw new CliExit(1);
  }
  const includeLogs = flagIsTrue(flags, 'include-logs');
  const home = envHomeDir() || os.homedir();
  const now = new Date();
  const bundle = buildSupportBundle({ cwd: process.cwd(), home, version: PACKAGE_VERSION, includeLogs, now });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = outFlag ?? path.join(process.cwd(), `hippo-support-${stamp}.json`);
  const json = JSON.stringify(bundle, null, 2);
  try {
    fs.writeFileSync(file, `${json}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
      printError(`${file} already exists; pass --out to choose another file. Nothing was written.`);
    } else {
      printError(errorMessage(err));
    }
    throw new CliExit(1);
  }
  const kb = Math.round(Buffer.byteLength(json) / 1024);
  console.log(`Wrote ${file} (${kb} KB).`);
  console.log(includeLogs
    ? `It holds versions, doctor checks, config with secrets removed, store counts, and the last ${TAIL_MAX_LINES} lines of each hippo log with known secret shapes removed. Those log lines can quote memory text. Read it before you attach it to a ticket.`
    : 'It holds versions, doctor checks, config with secrets removed, store counts and log file names. It never holds memory text. Read it before you ' +
      'attach it to a ticket.');
}

export async function handleInspect({ hippoRoot, tenantId, args }: CommandContext): Promise<void> {
  const id = args[0];
  if (!id) {
    printError('Please provide a memory ID.');
    throw new CliExit(1);
  }
  await cmdInspect(hippoRoot, tenantId, id);
}
