#!/usr/bin/env node
/**
 * Hippo CLI  - biologically-inspired memory system for AI agents.
 *
 * Commands:
 *   hippo init [--global]
 *   hippo remember <text> [--tag <t>] [--error] [--pin] [--global]
 *   hippo recall <query> [--budget <n>] [--json] [--why]
 *   hippo sleep [--dry-run]
 *   hippo status
 *   hippo outcome --good | --bad [--id <id>]
 *   hippo conflicts [--status <status>] [--json]
 *   hippo snapshot <save|show|clear>
 *   hippo session <log|show|latest|resume>
 *   hippo handoff <create|latest|show>
 *   hippo current <show>
 *   hippo forget <id>
 *   hippo inspect <id>
 *   hippo embed [--status]
 *   hippo watch "<command>"
 *   hippo learn --git [--days <n>] [--repos <paths>]
 *   hippo promote <id>
 *   hippo sync
 *   hippo decide "<decision>" [--context "<why>"] [--supersedes <id>]
 *   hippo wm <push|read|clear|flush>
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  createMemory,
  calculateStrength,
  calculateRewardFactor,
  deriveHalfLife,
  resolveConfidence,
  applyOutcome,
  computeSchemaFit,
  Layer,
  MemoryEntry,
  ConfidenceLevel,
  DECISION_HALF_LIFE_DAYS,
} from './memory.js';
import {
  getHippoRoot,
  isInitialized,
  initStore,
  writeEntry,
  readEntry,
  deleteEntry,
  loadAllEntries,
  loadSearchEntries,
  loadIndex,
  saveIndex,
  loadStats,
  updateStats,
  saveActiveTaskSnapshot,
  loadActiveTaskSnapshot,
  clearActiveTaskSnapshot,
  appendSessionEvent,
  listSessionEvents,
  listMemoryConflicts,
  resolveConflict,
  saveSessionHandoff,
  loadLatestHandoff,
  loadHandoffById,
  TaskSnapshot,
  SessionEvent,
} from './store.js';
import type { SessionHandoff } from './handoff.js';
import { search, markRetrieved, estimateTokens, hybridSearch, physicsSearch, explainMatch } from './search.js';
import { consolidate } from './consolidate.js';
import {
  isEmbeddingAvailable,
  embedAll,
  embedMemory,
  loadEmbeddingIndex,
} from './embeddings.js';
import { loadPhysicsState, resetAllPhysicsState } from './physics-state.js';
import { computeSystemEnergy, vecNorm } from './physics.js';
import { loadConfig } from './config.js';
import { openHippoDb, closeHippoDb } from './db.js';
import {
  captureError,
  extractLessons,
  deduplicateLesson,
  runWatched,
  fetchGitLog,
  isGitRepo,
} from './autolearn.js';
import { extractInvalidationTarget, invalidateMatching, InvalidationTarget } from './invalidation.js';
import { extractPathTags } from './path-context.js';
import {
  getGlobalRoot,
  initGlobal,
  promoteToGlobal,
  shareMemory,
  listPeers,
  autoShare,
  transferScore,
  searchBoth,
  searchBothHybrid,
  syncGlobalToLocal,
} from './shared.js';
import {
  importChatGPT,
  importClaude,
  importCursor,
  importGenericFile,
  importMarkdown,
  ImportOptions,
} from './importers.js';
import { cmdCapture, CaptureOptions } from './capture.js';
import { wmPush, wmRead, wmClear, wmFlush, WorkingMemoryItem } from './working-memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLimitFlag(value: string | boolean | string[] | undefined): number {
  if (!value) return Infinity;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : Infinity;
}

function requireInit(hippoRoot: string): void {
  if (!isInitialized(hippoRoot)) {
    console.error('No .hippo directory found. Run `hippo init` first.');
    process.exit(1);
  }
}

function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean | string[]> } {
  const [, , command = '', ...rest] = argv;
  const args: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  let i = 0;
  while (i < rest.length) {
    const part = rest[i];
    if (part.startsWith('--')) {
      const key = part.slice(2);
      const next = rest[i + 1];

      if (!next || next.startsWith('--')) {
        // Boolean flag
        flags[key] = true;
        i++;
      } else {
        // Check if it's a repeatable flag (tag, artifact)
        if (key === 'tag' || key === 'artifact') {
          if (Array.isArray(flags[key])) {
            (flags[key] as string[]).push(next);
          } else {
            flags[key] = [next];
          }
        } else {
          flags[key] = next;
        }
        i += 2;
      }
    } else {
      args.push(part);
      i++;
    }
  }

  return { command, args, flags };
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInit(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  if (flags['global']) {
    const globalRoot = getGlobalRoot();
    if (isInitialized(globalRoot)) {
      console.log('Already initialized global store at', globalRoot);
      return;
    }
    initGlobal();
    console.log('Initialized global Hippo store at', globalRoot);
    return;
  }

  const alreadyExists = isInitialized(hippoRoot);
  if (alreadyExists) {
    console.log('Already initialized at', hippoRoot);
  } else {
    initStore(hippoRoot);
    console.log('Initialized Hippo at', hippoRoot);
    console.log('   Directories: buffer/ episodic/ semantic/ conflicts/');
    console.log('   Files: hippo.db index.json stats.json');
  }

  // Auto-detect and install hooks (unless --no-hooks)
  if (!flags['no-hooks']) {
    autoInstallHooks(alreadyExists);
  }

  // Auto-setup daily schedule (unless --no-schedule)
  if (!flags['no-schedule'] && !flags['global']) {
    setupDailySchedule(hippoRoot);
  }

  // Seed with git history on first init (unless --no-learn)
  if (!alreadyExists && !flags['no-learn'] && !flags['global']) {
    if (isGitRepo(process.cwd())) {
      const seedDays = 30;
      console.log(`\n   Seeding memories from last ${seedDays} days of git history...`);
      const { added, skipped } = learnFromRepo(hippoRoot, process.cwd(), seedDays);
      if (added > 0) {
        console.log(`   Learned ${added} lessons from git (${skipped} duplicates skipped).`);
      } else {
        console.log(`   No matching commits found in git history.`);
      }
    }
  }
}

/**
 * Detect agent config files in cwd and auto-install hippo hooks.
 * Skips files that already have a <!-- hippo:start --> block.
 */
function autoInstallHooks(quiet: boolean): void {
  const cwd = process.cwd();

  // Map: filename to check -> hook key(s) to install
  const detectors: Array<{ files: string[]; hook: string }> = [
    { files: ['CLAUDE.md', '.claude/settings.json'], hook: 'claude-code' },
    { files: ['AGENTS.md', '.codex'], hook: 'codex' },
    { files: ['.cursorrules', '.cursor/rules'], hook: 'cursor' },
    { files: ['.openclaw', 'AGENTS.md'], hook: 'openclaw' },
    { files: ['.opencode', 'opencode.json'], hook: 'opencode' },
  ];

  // Track which hook files we've already touched to avoid double-patching AGENTS.md
  const installed = new Set<string>();

  for (const { files, hook } of detectors) {
    const hookDef = HOOKS[hook];
    if (!hookDef) continue;

    // Check if any marker file exists
    const detected = files.some((f) => fs.existsSync(path.join(cwd, f)));
    if (!detected) continue;

    const targetPath = path.resolve(cwd, hookDef.file);

    // Skip if we already installed a hook into this file
    if (installed.has(targetPath)) continue;

    // Skip if hook already present
    if (fs.existsSync(targetPath)) {
      const content = fs.readFileSync(targetPath, 'utf8');
      if (content.includes(HOOK_MARKERS.start)) continue;
    }

    // Install the hook
    const block = `${HOOK_MARKERS.start}\n${hookDef.content}\n${HOOK_MARKERS.end}`;

    if (fs.existsSync(targetPath)) {
      const existing = fs.readFileSync(targetPath, 'utf8');
      const sep = existing.endsWith('\n') ? '\n' : '\n\n';
      fs.writeFileSync(targetPath, existing + sep + block + '\n', 'utf8');
    } else {
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(targetPath, block + '\n', 'utf8');
    }

    installed.add(targetPath);
    console.log(`   Auto-installed ${hook} hook in ${hookDef.file}`);

    // For claude-code, also install the Stop hook in settings.json
    if (hook === 'claude-code') {
      if (installClaudeCodeStopHook()) {
        console.log(`   Auto-installed hippo sleep Stop hook in Claude Code settings.json`);
      }
    }
  }
}

/**
 * Set up a daily cron job for hippo learn + sleep.
 * Linux/macOS: writes to user crontab.
 * Windows: creates a scheduled task.
 * Skips if already installed.
 */
function setupDailySchedule(hippoRoot: string): void {
  const projectDir = path.resolve(path.dirname(hippoRoot));
  // Reject paths with characters that could break shell/crontab quoting
  // (backslash is normal on Windows, only dangerous in Unix shell/crontab)
  const unsafeChars = process.platform === 'win32' ? /["`$%\n\r]/ : /["`$\n\r\\]/;
  if (unsafeChars.test(projectDir)) {
    console.log(`   Skipping schedule: project path contains unsafe characters.`);
    return;
  }
  const isWindows = process.platform === 'win32';
  const taskName = `hippo-daily-${path.basename(projectDir)}`.replace(/[^a-zA-Z0-9_-]/g, '-');

  if (isWindows) {
    // Check if task already exists
    try {
      const existing = execSync(`schtasks /query /tn "${taskName}" 2>nul`, { encoding: 'utf-8' });
      if (existing.includes(taskName)) {
        return; // already scheduled
      }
    } catch {
      // Task doesn't exist, create it
    }

    const cmd = `cd /d "${projectDir}" && hippo learn --git --days 1 && hippo sleep`;
    try {
      execSync(
        `schtasks /create /tn "${taskName}" /tr "cmd /c ${cmd.replace(/"/g, '""')}" /sc daily /st 06:15 /f`,
        { stdio: 'pipe' }
      );
      console.log(`   Scheduled daily learn+sleep (6:15am) via Task Scheduler: ${taskName}`);
    } catch {
      // No admin rights or schtasks unavailable, fall back to printing instructions
      console.log(`   To schedule daily learn+sleep, run:`);
      console.log(`   schtasks /create /tn "${taskName}" /tr "cmd /c ${cmd}" /sc daily /st 06:15`);
    }
  } else {
    // Unix: check crontab for existing entry
    const marker = `# hippo:${taskName}`;
    try {
      const existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
      if (existing.includes(marker)) {
        return; // already scheduled
      }

      const cronLine = `15 6 * * * cd "${projectDir}" && hippo learn --git --days 1 && hippo sleep ${marker}`;
      const newCrontab = existing.trimEnd() + '\n' + cronLine + '\n';
      execSync('crontab -', { input: newCrontab, stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(`   Scheduled daily learn+sleep (6:15am) via crontab`);
    } catch {
      const cronLine = `15 6 * * * cd "${projectDir}" && hippo learn --git --days 1 && hippo sleep`;
      console.log(`   To schedule daily learn+sleep, add to crontab (crontab -e):`);
      console.log(`   ${cronLine}`);
    }
  }
}

function cmdRemember(
  hippoRoot: string,
  text: string,
  flags: Record<string, string | boolean | string[]>
): void {
  const useGlobal = Boolean(flags['global']);
  const targetRoot = useGlobal ? getGlobalRoot() : hippoRoot;

  if (useGlobal) {
    initGlobal();
  } else {
    requireInit(hippoRoot);
  }

  const rawTags: string[] = Array.isArray(flags['tag']) ? flags['tag'] as string[] : [];
  if (flags['error']) rawTags.push('error');

  // Resolve explicit confidence flag (default: 'verified' for manual remember)
  let confidence: ConfidenceLevel = 'verified';
  if (flags['observed']) confidence = 'observed';
  if (flags['inferred']) confidence = 'inferred';
  if (flags['verified']) confidence = 'verified';

  // Compute schema fit against existing memories
  const existing = loadAllEntries(targetRoot);
  const schemaFit = computeSchemaFit(text, rawTags, existing);

  const entry = createMemory(text, {
    layer: Layer.Episodic,
    tags: rawTags,
    pinned: Boolean(flags['pin']),
    source: useGlobal ? 'cli-global' : 'cli',
    confidence,
    schema_fit: schemaFit,
  });

  // Auto-tag with path context
  const pathTags = extractPathTags(process.cwd());
  for (const pt of pathTags) {
    if (!entry.tags.includes(pt)) entry.tags.push(pt);
  }

  writeEntry(targetRoot, entry);
  updateStats(targetRoot, { remembered: 1 });

  const prefix = useGlobal ? '[global] ' : '';
  console.log(`${prefix}Remembered [${entry.id}]`);
  console.log(`   Layer: ${entry.layer} | Strength: ${fmt(entry.strength)} | Half-life: ${entry.half_life_days}d | Confidence: ${entry.confidence}`);
  if (entry.tags.length > 0) console.log(`   Tags: ${entry.tags.join(', ')}`);
  if (entry.pinned) console.log('   Pinned (no decay)');

  // Auto-embed if available
  if (isEmbeddingAvailable()) {
    embedMemory(targetRoot, entry).catch(() => {
      // Silently ignore embedding errors
    });
  }
}

async function cmdRecall(
  hippoRoot: string,
  query: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  requireInit(hippoRoot);

  const budget = parseInt(String(flags['budget'] ?? '4000'), 10);
  const limit = parseLimitFlag(flags['limit']);
  const asJson = Boolean(flags['json']);
  const showWhy = Boolean(flags['why']);
  const forcePhysics = Boolean(flags['physics']);
  const forceClassic = Boolean(flags['classic']);
  const globalRoot = getGlobalRoot();

  const localEntries = loadSearchEntries(hippoRoot, query);
  const globalEntries = isInitialized(globalRoot) ? loadSearchEntries(globalRoot, query) : [];

  const hasGlobal = globalEntries.length > 0;

  // Determine search mode: --physics forces physics, --classic forces BM25+cosine,
  // default uses physics if config.physics.enabled is not false
  const config = loadConfig(hippoRoot);
  const usePhysics = forcePhysics
    || (!forceClassic && config.physics.enabled !== false);

  let results;
  if (usePhysics && !hasGlobal) {
    results = await physicsSearch(query, localEntries, {
      budget,
      hippoRoot,
      physicsConfig: config.physics,
    });
  } else if (hasGlobal) {
    // Use searchBothHybrid for merged results with embedding support
    results = await searchBothHybrid(query, hippoRoot, globalRoot, { budget });
  } else {
    results = await hybridSearch(query, localEntries, { budget, hippoRoot });
  }

  if (limit < results.length) {
    results = results.slice(0, limit);
  }

  if (results.length === 0) {
    if (asJson) {
      console.log(JSON.stringify({ query, results: [], total: 0 }));
    } else {
      console.log('No memories found for:', query);
    }
    return;
  }

  // Update retrieval metadata and persist
  const updated = markRetrieved(results.map((r) => r.entry));
  const localIndex = loadIndex(hippoRoot);
  for (const u of updated) {
    const targetRoot = localIndex.entries[u.id] ? hippoRoot : (isInitialized(globalRoot) ? globalRoot : hippoRoot);
    writeEntry(targetRoot, u);
  }

  // Track last retrieval IDs for outcome command
  localIndex.last_retrieval_ids = updated.map((u) => u.id);
  saveIndex(hippoRoot, localIndex);

  updateStats(hippoRoot, { recalled: results.length });

  if (asJson) {
    const output = results.map((r) => {
      const isGlobal = isInitialized(globalRoot) && !localIndex.entries[r.entry.id];
      const base: Record<string, unknown> = {
        id: r.entry.id,
        score: r.score,
        strength: r.entry.strength,
        tokens: r.tokens,
        tags: r.entry.tags,
        content: r.entry.content,
      };
      if (showWhy) {
        const explanation = explainMatch(query, r);
        base.layer = r.entry.layer;
        base.confidence = resolveConfidence(r.entry);
        base.source = isGlobal ? 'global' : 'local';
        base.reason = explanation.reason;
        base.bm25 = r.bm25;
        base.cosine = r.cosine;
      }
      return base;
    });
    console.log(JSON.stringify({ query, budget, results: output, total: output.length }));
    return;
  }

  const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
  console.log(`Found ${results.length} memories (${totalTokens} tokens) for: "${query}"\n`);

  for (const r of results) {
    const e = r.entry;
    const conf = resolveConfidence(e);
    const confLabel = conf === 'stale' || conf === 'inferred' ? `[${conf}] \u26A0\uFE0F` : `[${conf}]`;
    const strengthBar = '\u2588'.repeat(Math.round(e.strength * 10)) + '\u2591'.repeat(10 - Math.round(e.strength * 10));
    const isGlobal = isInitialized(globalRoot) && !localIndex.entries[e.id];
    const globalMark = isGlobal ? ' [global]' : '';
    const sourceMark = isGlobal ? ' [global]' : ' [local]';
    console.log(`--- ${e.id} [${e.layer}] ${confLabel}${globalMark} score=${fmt(r.score, 3)} strength=${fmt(e.strength)}`);
    console.log(`    [${strengthBar}] tags: ${e.tags.join(', ') || 'none'} | retrieved: ${e.retrieval_count}x`);
    if (showWhy) {
      const explanation = explainMatch(query, r);
      console.log(`    source:${sourceMark} | layer: [${e.layer}] | confidence: [${conf}]`);
      console.log(`    reason: ${explanation.reason}`);
    }
    console.log();
    console.log(e.content);
    console.log();
  }
}

function cmdSleep(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  // Auto-learn from git before consolidating (unless --no-learn)
  if (!flags['no-learn']) {
    const config = loadConfig(hippoRoot);
    if (config.autoLearnOnSleep && isGitRepo(process.cwd())) {
      const { added } = learnFromRepo(hippoRoot, process.cwd(), 1);
      if (added > 0) console.log(`Auto-learned ${added} lessons from today's git commits.`);
    }
  }

  const dryRun = Boolean(flags['dry-run']);
  console.log(`Running consolidation${dryRun ? ' (dry run)' : ''}...`);

  const result = consolidate(hippoRoot, { dryRun });

  console.log(`\nResults:`);
  console.log(`   Active memories:  ${result.decayed}`);
  console.log(`   Removed (decayed): ${result.removed}`);
  console.log(`   Merged episodic:   ${result.merged}`);
  console.log(`   New semantic:      ${result.semanticCreated}`);

  if (result.details.length > 0) {
    console.log('\nDetails:');
    for (const d of result.details) {
      console.log(d);
    }
  }

  if (dryRun) console.log('\n(dry run  - nothing written)');
}

function cmdStatus(hippoRoot: string): void {
  requireInit(hippoRoot);

  const entries = loadAllEntries(hippoRoot);
  const stats = loadStats(hippoRoot);
  const now = new Date();

  const byLayer = {
    [Layer.Buffer]: 0,
    [Layer.Episodic]: 0,
    [Layer.Semantic]: 0,
  };

  const byConfidence: Record<string, number> = {
    verified: 0,
    observed: 0,
    inferred: 0,
    stale: 0,
  };

  let totalStrength = 0;
  let pinned = 0;
  let atRisk = 0; // strength < 0.2

  for (const e of entries) {
    const s = calculateStrength(e, now);
    byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1;
    totalStrength += s;
    if (e.pinned) pinned++;
    if (s < 0.2) atRisk++;
    const conf = resolveConfidence(e, now);
    byConfidence[conf] = (byConfidence[conf] ?? 0) + 1;
  }

  const avgStrength = entries.length > 0 ? totalStrength / entries.length : 0;

  console.log('Hippo Status');
  console.log('---------------------------');
  console.log(`Total memories:    ${entries.length}`);
  console.log(`  Buffer:          ${byLayer[Layer.Buffer]}`);
  console.log(`  Episodic:        ${byLayer[Layer.Episodic]}`);
  console.log(`  Semantic:        ${byLayer[Layer.Semantic]}`);
  const conflictCount = listMemoryConflicts(hippoRoot).length;

  console.log(`Pinned:            ${pinned}`);
  console.log(`At risk (<0.2):    ${atRisk}`);
  console.log(`Open conflicts:    ${conflictCount}`);
  console.log(`Avg strength:      ${fmt(avgStrength)}`);
  console.log('');
  console.log('Confidence breakdown:');
  console.log(`  Verified:        ${byConfidence['verified'] ?? 0}`);
  console.log(`  Observed:        ${byConfidence['observed'] ?? 0}`);
  console.log(`  Inferred:        ${byConfidence['inferred'] ?? 0}`);
  console.log(`  Stale:           ${byConfidence['stale'] ?? 0}`);
  console.log('');
  console.log(`Total remembered:  ${(stats as Record<string,number>)['total_remembered'] ?? 0}`);
  console.log(`Total recalled:    ${(stats as Record<string,number>)['total_recalled'] ?? 0}`);
  console.log(`Total forgotten:   ${(stats as Record<string,number>)['total_forgotten'] ?? 0}`);

  const runs = (stats as Record<string, unknown[]>)['consolidation_runs'] ?? [];
  if (Array.isArray(runs) && runs.length > 0) {
    const last = runs[runs.length - 1] as Record<string, unknown>;
    console.log(`Last sleep:        ${last['timestamp']}`);
  } else {
    console.log(`Last sleep:        never`);
  }

  // Embedding status
  const embAvail = isEmbeddingAvailable();
  console.log('');
  console.log(`Embeddings:        ${embAvail ? 'available' : 'not installed (BM25 only)'}`);
  if (embAvail) {
    const embIndex = loadEmbeddingIndex(hippoRoot);
    const activeIds = new Set(entries.map((e) => e.id));
    const activeEmbedded = Object.keys(embIndex).filter((id) => activeIds.has(id)).length;
    const orphaned = Object.keys(embIndex).length - activeEmbedded;
    let line = `Embedded:          ${activeEmbedded}/${entries.length} memories`;
    if (orphaned > 0) line += ` (${orphaned} orphaned — run \`hippo embed\` to prune)`;
    console.log(line);
  }

  // Physics status
  try {
    const db = openHippoDb(hippoRoot);
    try {
      const physicsMap = loadPhysicsState(db);
      if (physicsMap.size > 0) {
        const particles = Array.from(physicsMap.values());
        const physConfig = loadConfig(hippoRoot);
        const energy = computeSystemEnergy(particles, physConfig.physics.G_memory);
        let sumVelMag = 0;
        let maxVelMag = 0;
        for (const p of particles) {
          const mag = vecNorm(p.velocity);
          sumVelMag += mag;
          if (mag > maxVelMag) maxVelMag = mag;
        }
        const avgVelMag = sumVelMag / particles.length;
        console.log('');
        console.log(`Physics: ${particles.length} particles, energy: ${fmt(energy.total, 4)} (KE: ${fmt(energy.kinetic, 4)}, PE: ${fmt(energy.potential, 4)}), avg vel: ${fmt(avgVelMag, 4)}`);
      }
    } finally {
      closeHippoDb(db);
    }
  } catch {
    // Physics table may not exist yet — degrade gracefully
  }
}

function cmdOutcome(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const good = Boolean(flags['good']);
  const bad = Boolean(flags['bad']);

  if (!good && !bad) {
    console.error('Specify --good or --bad');
    process.exit(1);
  }

  const specificId = flags['id'] ? String(flags['id']) : null;
  const index = loadIndex(hippoRoot);

  const ids = specificId ? [specificId] : index.last_retrieval_ids;

  if (ids.length === 0) {
    console.log('No recent recall to apply outcome to. Use --id <id> to target a specific memory.');
    return;
  }

  let updated = 0;
  for (const id of ids) {
    const entry = readEntry(hippoRoot, id);
    if (!entry) continue;
    const upd = applyOutcome(entry, good);
    writeEntry(hippoRoot, upd);
    updated++;
  }

  console.log(`Applied ${good ? 'positive' : 'negative'} outcome to ${updated} memor${updated === 1 ? 'y' : 'ies'}`);
}

function cmdForget(hippoRoot: string, id: string): void {
  requireInit(hippoRoot);

  const ok = deleteEntry(hippoRoot, id);
  if (ok) {
    updateStats(hippoRoot, { forgotten: 1 });
    console.log(`Forgot ${id}`);
  } else {
    console.error(`Memory not found: ${id}`);
    process.exit(1);
  }
}

function cmdInspect(hippoRoot: string, id: string): void {
  requireInit(hippoRoot);

  const entry = readEntry(hippoRoot, id);
  if (!entry) {
    console.error(`Memory not found: ${id}`);
    process.exit(1);
  }

  const now = new Date();
  const currentStrength = calculateStrength(entry, now);
  const lastRetrieved = new Date(entry.last_retrieved);
  const created = new Date(entry.created);
  const ageDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
  const daysSince = (now.getTime() - lastRetrieved.getTime()) / (1000 * 60 * 60 * 24);

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

function printActiveTaskSnapshot(snapshot: TaskSnapshot): void {
  console.log('## Active Task Snapshot\n');
  console.log(`- Task: ${snapshot.task}`);
  console.log(`- Status: ${snapshot.status}`);
  console.log(`- Updated: ${snapshot.updated_at}`);
  console.log(`- Source: ${snapshot.source}`);
  if (snapshot.session_id) {
    console.log(`- Session: ${snapshot.session_id}`);
  }
  console.log('');
  console.log('### Summary');
  console.log(snapshot.summary);
  console.log('');
  console.log('### Next step');
  console.log(snapshot.next_step);
  console.log('');
}

function printSessionEvents(events: SessionEvent[]): void {
  if (events.length === 0) {
    console.log('No session events found.');
    return;
  }

  const latest = events[events.length - 1]!;
  console.log('## Recent Session Trail\n');
  console.log(`- Session: ${latest.session_id}`);
  console.log(`- Task: ${latest.task ?? 'n/a'}`);
  console.log(`- Updated: ${latest.created_at}`);
  console.log('');

  for (const event of events) {
    console.log(`- [${event.created_at}] (${event.event_type}) ${event.content}`);
  }
  console.log('');
}

function cmdConflicts(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const conflicts = listMemoryConflicts(hippoRoot, String(flags['status'] ?? 'open'));
  if (flags['json']) {
    console.log(JSON.stringify({ conflicts }, null, 2));
    return;
  }

  if (conflicts.length === 0) {
    console.log('No memory conflicts found.');
    return;
  }

  console.log(`Found ${conflicts.length} memory conflict${conflicts.length === 1 ? '' : 's'}\n`);
  for (const conflict of conflicts) {
    console.log(`--- conflict_${conflict.id} score=${fmt(conflict.score, 3)} status=${conflict.status}`);
    console.log(`    ${conflict.memory_a_id} <-> ${conflict.memory_b_id}`);
    console.log(`    reason: ${conflict.reason}`);
    console.log('');
  }
}

function cmdResolve(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const rawId = args[0] ?? '';
  // Accept "42" or "conflict_42"
  const conflictId = parseInt(rawId.replace(/^conflict_/, ''), 10);
  if (isNaN(conflictId)) {
    console.error('Usage: hippo resolve <conflict_id> --keep <memory_id> [--forget]');
    process.exit(1);
  }

  const keepId = String(flags['keep'] ?? '').trim();
  if (!keepId) {
    // Show the conflict details to help the user decide
    const conflicts = listMemoryConflicts(hippoRoot, 'open');
    const conflict = conflicts.find((c) => c.id === conflictId);
    if (!conflict) {
      console.error(`Conflict ${conflictId} not found or already resolved.`);
      process.exit(1);
    }

    console.log(`Conflict ${conflictId}:`);
    console.log(`  ${conflict.memory_a_id} <-> ${conflict.memory_b_id}`);
    console.log(`  Reason: ${conflict.reason}`);
    console.log('');

    const entryA = readEntry(hippoRoot, conflict.memory_a_id);
    const entryB = readEntry(hippoRoot, conflict.memory_b_id);
    if (entryA) {
      console.log(`  [A] ${conflict.memory_a_id}:`);
      console.log(`      ${entryA.content.slice(0, 120)}${entryA.content.length > 120 ? '...' : ''}`);
    }
    if (entryB) {
      console.log(`  [B] ${conflict.memory_b_id}:`);
      console.log(`      ${entryB.content.slice(0, 120)}${entryB.content.length > 120 ? '...' : ''}`);
    }
    console.log('');
    console.log(`Resolve with: hippo resolve ${conflictId} --keep <memory_id> [--forget]`);
    return;
  }

  const forgetLoser = Boolean(flags['forget']);
  const result = resolveConflict(hippoRoot, conflictId, keepId, forgetLoser);

  if (!result) {
    console.error(`Could not resolve conflict ${conflictId}. Check the ID and --keep value.`);
    process.exit(1);
  }

  const action = forgetLoser ? 'deleted' : 'weakened (half-life halved)';
  console.log(`Resolved conflict ${conflictId}: kept ${keepId}, ${action} ${result.loserId}`);
}

function cmdSnapshot(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';

  if (subcommand === 'save') {
    const task = String(flags['task'] ?? '').trim();
    const summary = String(flags['summary'] ?? '').trim();
    const nextStep = String(flags['next-step'] ?? '').trim();
    const sessionId = String(flags['session'] ?? flags['id'] ?? '').trim();

    if (!task || !summary || !nextStep) {
      console.error('Usage: hippo snapshot save --task <task> --summary <summary> --next-step <step> [--source <source>] [--session <session-id>]');
      process.exit(1);
    }

    const snapshot = saveActiveTaskSnapshot(hippoRoot, {
      task,
      summary,
      next_step: nextStep,
      source: String(flags['source'] ?? 'cli'),
      session_id: sessionId || null,
    });

    console.log(`Saved active task snapshot #${snapshot.id}`);
    console.log(`   Task: ${snapshot.task}`);
    console.log(`   Next: ${snapshot.next_step}`);
    if (snapshot.session_id) {
      console.log(`   Session: ${snapshot.session_id}`);
    }
    return;
  }

  if (subcommand === 'clear') {
    const cleared = clearActiveTaskSnapshot(hippoRoot, String(flags['status'] ?? 'cleared'));
    if (!cleared) {
      console.log('No active task snapshot to clear.');
      return;
    }
    console.log('Cleared active task snapshot.');
    return;
  }

  if (subcommand === 'show') {
    const snapshot = loadActiveTaskSnapshot(hippoRoot);
    if (!snapshot) {
      if (flags['json']) {
        console.log(JSON.stringify({ snapshot: null }));
      } else {
        console.log('No active task snapshot saved.');
      }
      return;
    }

    if (flags['json']) {
      console.log(JSON.stringify({ snapshot }, null, 2));
      return;
    }

    printActiveTaskSnapshot(snapshot);
    return;
  }

  console.error('Usage: hippo snapshot <save|show|clear>');
  process.exit(1);
}

function cmdSession(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';
  const sessionId = String(flags['id'] ?? flags['session'] ?? '').trim();
  const task = String(flags['task'] ?? '').trim();
  const limit = Math.max(1, parseInt(String(flags['limit'] ?? '8'), 10) || 8);

  if (subcommand === 'log') {
    const eventType = String(flags['type'] ?? 'note').trim();
    const content = String(flags['content'] ?? '').trim();

    if (!sessionId || !content) {
      console.error('Usage: hippo session log --id <session-id> --content <text> [--type <type>] [--task <task>] [--source <source>]');
      process.exit(1);
    }

    const event = appendSessionEvent(hippoRoot, {
      session_id: sessionId,
      task: task || null,
      event_type: eventType || 'note',
      content,
      source: String(flags['source'] ?? 'cli'),
    });

    console.log(`Logged session event #${event.id}`);
    console.log(`   Session: ${event.session_id}`);
    console.log(`   Type: ${event.event_type}`);
    return;
  }

  if (subcommand === 'show') {
    const events = listSessionEvents(hippoRoot, {
      session_id: sessionId || undefined,
      task: task || undefined,
      limit,
    });

    if (flags['json']) {
      console.log(JSON.stringify({ events }, null, 2));
      return;
    }

    printSessionEvents(events);
    return;
  }

  if (subcommand === 'latest') {
    const snapshot = loadActiveTaskSnapshot(hippoRoot);
    const events = listSessionEvents(hippoRoot, {
      session_id: sessionId || snapshot?.session_id || undefined,
      limit,
    });

    if (flags['json']) {
      console.log(JSON.stringify({ snapshot: snapshot ?? null, events }, null, 2));
      return;
    }

    if (snapshot) {
      printActiveTaskSnapshot(snapshot);
    } else {
      console.log('No active task snapshot.');
      console.log('');
    }
    printSessionEvents(events);
    return;
  }

  if (subcommand === 'resume') {
    const handoff = loadLatestHandoff(hippoRoot, sessionId || undefined);
    if (!handoff) {
      console.log('No handoff to resume from.');
      return;
    }

    const lines: string[] = [
      '## Session Handoff (resumed)',
      '',
      `- Session: ${handoff.sessionId}`,
      `- Updated: ${handoff.updatedAt}`,
    ];
    if (handoff.taskId) lines.push(`- Task: ${handoff.taskId}`);
    if (handoff.repoRoot) lines.push(`- Repo: ${handoff.repoRoot}`);
    lines.push('', '### Summary', handoff.summary);
    if (handoff.nextAction) {
      lines.push('', '### Next action', handoff.nextAction);
    }
    if (handoff.artifacts && handoff.artifacts.length > 0) {
      lines.push('', '### Artifacts');
      for (const artifact of handoff.artifacts) {
        lines.push(`- ${artifact}`);
      }
    }
    lines.push('');
    console.log(lines.join('\n'));
    return;
  }

  console.error('Usage: hippo session <log|show|latest|resume>');
  process.exit(1);
}

function printHandoff(handoff: SessionHandoff): void {
  console.log('## Session Handoff\n');
  console.log(`- Session: ${handoff.sessionId}`);
  console.log(`- Updated: ${handoff.updatedAt}`);
  if (handoff.taskId) console.log(`- Task: ${handoff.taskId}`);
  if (handoff.repoRoot) console.log(`- Repo: ${handoff.repoRoot}`);
  console.log('');
  console.log('### Summary');
  console.log(handoff.summary);
  if (handoff.nextAction) {
    console.log('');
    console.log('### Next action');
    console.log(handoff.nextAction);
  }
  if (handoff.artifacts && handoff.artifacts.length > 0) {
    console.log('');
    console.log('### Artifacts');
    for (const artifact of handoff.artifacts) {
      console.log(`- ${artifact}`);
    }
  }
  console.log('');
}

function cmdHandoff(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'latest';

  if (subcommand === 'create') {
    const summary = String(flags['summary'] ?? '').trim();
    if (!summary) {
      console.error('Usage: hippo handoff create --summary "..." [--next "..."] [--session <id>] [--task <id>] [--artifact <path>...]');
      process.exit(1);
    }

    const sessionId = String(flags['session'] ?? flags['id'] ?? '').trim() || `fallback-${Date.now()}-${process.pid}`;
    const nextAction = String(flags['next'] ?? '').trim() || undefined;
    const taskId = String(flags['task'] ?? '').trim() || undefined;
    const artifactFlag = flags['artifact'];
    const artifacts: string[] = Array.isArray(artifactFlag)
      ? artifactFlag
      : (typeof artifactFlag === 'string' ? [artifactFlag] : []);

    const handoff = saveSessionHandoff(hippoRoot, {
      version: 1,
      sessionId,
      repoRoot: process.cwd(),
      taskId,
      summary,
      nextAction,
      artifacts,
    });

    console.log(`Created session handoff for session ${handoff.sessionId}`);
    console.log(`   Summary: ${handoff.summary}`);
    if (handoff.nextAction) console.log(`   Next: ${handoff.nextAction}`);
    if (handoff.artifacts && handoff.artifacts.length > 0) {
      console.log(`   Artifacts: ${handoff.artifacts.join(', ')}`);
    }
    return;
  }

  if (subcommand === 'latest') {
    const sessionId = String(flags['session'] ?? flags['id'] ?? '').trim() || undefined;
    const handoff = loadLatestHandoff(hippoRoot, sessionId);

    if (!handoff) {
      if (flags['json']) {
        console.log(JSON.stringify({ handoff: null }));
      } else {
        console.log('No session handoff found.');
      }
      return;
    }

    if (flags['json']) {
      console.log(JSON.stringify({ handoff }, null, 2));
      return;
    }

    printHandoff(handoff);
    return;
  }

  if (subcommand === 'show') {
    const idArg = args[1];
    if (!idArg) {
      console.error('Usage: hippo handoff show <id> [--json]');
      process.exit(1);
    }

    const handoffId = parseInt(idArg, 10);
    if (!Number.isFinite(handoffId) || handoffId <= 0) {
      console.error(`Invalid handoff ID: ${idArg}`);
      process.exit(1);
    }

    const handoff = loadHandoffById(hippoRoot, handoffId);

    if (!handoff) {
      if (flags['json']) {
        console.log(JSON.stringify({ handoff: null }));
      } else {
        console.log(`No handoff found with ID ${handoffId}.`);
      }
      return;
    }

    if (flags['json']) {
      console.log(JSON.stringify({ handoff }, null, 2));
      return;
    }

    printHandoff(handoff);
    return;
  }

  console.error('Usage: hippo handoff <create|latest|show>');
  process.exit(1);
}

function cmdCurrent(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';

  if (subcommand === 'show') {
    const asJson = Boolean(flags['json']);
    const snapshot = loadActiveTaskSnapshot(hippoRoot);
    const sessionId = snapshot?.session_id ?? undefined;
    const events = listSessionEvents(hippoRoot, {
      session_id: sessionId,
      limit: 5,
    });

    if (asJson) {
      console.log(JSON.stringify({
        snapshot: snapshot ?? null,
        events: events.map((ev) => ({
          id: ev.id,
          session_id: ev.session_id,
          event_type: ev.event_type,
          content: ev.content,
          created_at: ev.created_at,
        })),
      }));
      return;
    }

    if (!snapshot && events.length === 0) {
      console.log('No active task or recent session events.');
      return;
    }

    console.log('# Current State\n');

    if (snapshot) {
      console.log(`Task: ${snapshot.task}`);
      console.log(`Status: ${snapshot.status} | Source: ${snapshot.source} | Updated: ${snapshot.updated_at}`);
      if (snapshot.session_id) {
        console.log(`Session: ${snapshot.session_id}`);
      }
      console.log(`Summary: ${snapshot.summary}`);
      console.log(`Next: ${snapshot.next_step}`);
    } else {
      console.log('No active task snapshot.');
    }

    if (events.length > 0) {
      console.log('');
      console.log('Recent events:');
      for (const ev of events) {
        const ts = ev.created_at.slice(0, 19).replace('T', ' ');
        console.log(`  [${ts}] (${ev.event_type}) ${ev.content}`);
      }
    }

    return;
  }

  console.error('Usage: hippo current <show>');
  process.exit(1);
}

async function cmdContext(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  requireInit(hippoRoot);

  const budget = parseInt(String(flags['budget'] ?? '1500'), 10);
  const limit = parseLimitFlag(flags['limit']);

  // If budget is 0, skip entirely (zero token cost)
  if (budget <= 0) return;

  // Determine query: explicit args, --auto (git diff), or fallback
  let query = args.join(' ').trim();

  if (!query && flags['auto']) {
    query = autoDetectContext();
  }

  if (!query) {
    // Fallback: return strongest memories regardless of query
    query = '*';
  }

  const globalRoot = getGlobalRoot();
  const hasGlobal = isInitialized(globalRoot);
  const localEntries = loadAllEntries(hippoRoot);
  const globalEntries = hasGlobal ? loadAllEntries(globalRoot) : [];
  const allEntries = [...localEntries];

  if (allEntries.length === 0 && globalEntries.length === 0) return; // no memories, zero output

  let selectedItems: Array<{ entry: MemoryEntry; score: number; tokens: number; isGlobal?: boolean }> = [];
  let totalTokens = 0;
  const activeSnapshot = loadActiveTaskSnapshot(hippoRoot);
  const recentSessionEvents = activeSnapshot?.session_id
    ? listSessionEvents(hippoRoot, { session_id: activeSnapshot.session_id, limit: 5 })
    : [];

  if (query === '*') {
    // No query: return strongest memories by strength, up to budget
    const now = new Date();
    const localRanked = localEntries
      .map((e) => ({
        entry: e,
        score: calculateStrength(e, now),
        tokens: estimateTokens(e.content),
        isGlobal: false,
      }))
      .sort((a, b) => b.score - a.score);

    const globalRanked = globalEntries
      .map((e) => ({
        entry: e,
        score: calculateStrength(e, now) * (1 / 1.2), // global slightly lower
        tokens: estimateTokens(e.content),
        isGlobal: true,
      }))
      .sort((a, b) => b.score - a.score);

    const combined = [...localRanked, ...globalRanked].sort((a, b) => b.score - a.score);

    let used = 0;
    for (const r of combined) {
      if (used + r.tokens > budget) continue;
      selectedItems.push(r);
      used += r.tokens;
    }
    totalTokens = used;
  } else {
    let results;
    if (hasGlobal) {
      const merged = await searchBothHybrid(query, hippoRoot, globalRoot, { budget });
      const localIndex = loadIndex(hippoRoot);
      results = merged.map((r) => ({
        entry: r.entry,
        score: r.score,
        tokens: r.tokens,
        isGlobal: !localIndex.entries[r.entry.id],
      }));
    } else {
      const ctxConfig = loadConfig(hippoRoot);
      const usePhysicsCtx = ctxConfig.physics?.enabled !== false;
      const ctxResults = usePhysicsCtx
        ? await physicsSearch(query, localEntries, { budget, hippoRoot, physicsConfig: ctxConfig.physics })
        : await hybridSearch(query, localEntries, { budget, hippoRoot });
      results = ctxResults.map((r) => ({
        entry: r.entry,
        score: r.score,
        tokens: r.tokens,
        isGlobal: false,
      }));
    }

    selectedItems = results;
    totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
  }

  if (limit < selectedItems.length) {
    selectedItems = selectedItems.slice(0, limit);
    totalTokens = selectedItems.reduce((sum, r) => sum + r.tokens, 0);
  }

  if (selectedItems.length === 0 && !activeSnapshot && recentSessionEvents.length === 0) return;

  // Mark retrieved and persist
  const toUpdate = selectedItems.map((s) => s.entry);
  const updatedEntries = markRetrieved(toUpdate);
  const localIndex = loadIndex(hippoRoot);

  for (const u of updatedEntries) {
    const targetRoot = localIndex.entries[u.id] ? hippoRoot : (hasGlobal ? globalRoot : hippoRoot);
    writeEntry(targetRoot, u);
  }

  localIndex.last_retrieval_ids = updatedEntries.map((u) => u.id);
  saveIndex(hippoRoot, localIndex);
  updateStats(hippoRoot, { recalled: selectedItems.length });

  const format = String(flags['format'] ?? 'markdown');

  const framing = String(flags['framing'] ?? 'observe');

  if (format === 'json') {
    const output = selectedItems.map((r) => ({
      id: r.entry.id,
      score: r.score,
      strength: r.entry.strength,
      tags: r.entry.tags,
      confidence: r.entry.confidence,
      content: r.entry.content,
      global: r.isGlobal ?? false,
    }));
    console.log(JSON.stringify({ query, activeSnapshot, recentSessionEvents, memories: output, tokens: totalTokens }));
  } else {
    if (activeSnapshot) {
      printActiveTaskSnapshot(activeSnapshot);
    }
    if (recentSessionEvents.length > 0) {
      printSessionEvents(recentSessionEvents);
    }
    printContextMarkdown(
      selectedItems.map((r) => ({
        entry: updatedEntries.find((u) => u.id === r.entry.id) ?? r.entry,
        score: r.score,
        tokens: r.tokens,
        isGlobal: r.isGlobal ?? false,
      })),
      totalTokens,
      framing
    );
  }
}

function printContextMarkdown(
  items: Array<{ entry: MemoryEntry; score: number; tokens: number; isGlobal: boolean }>,
  totalTokens: number,
  framing: string = 'observe'
): void {
  const now = new Date();
  console.log(`## Project Memory (${items.length} entries, ${totalTokens} tokens)\n`);
  for (const item of items) {
    const e = item.entry;
    const tagStr = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : '';
    const strengthPct = Math.round(calculateStrength(e) * 100);
    const globalPrefix = item.isGlobal ? '[global] ' : '';
    const effectiveConf = resolveConfidence(e, now);
    const confWarning = (effectiveConf === 'stale' || effectiveConf === 'inferred') ? ' \u26A0\uFE0F' : '';
    const confTag = `[${effectiveConf}]${confWarning}`;

    if (framing === 'observe') {
      const dateStr = new Date(e.created).toISOString().slice(0, 10);
      if (effectiveConf === 'verified') {
        // Verified: no date prefix, just the rule
        console.log(`- **${confTag} ${globalPrefix}${e.content}**${tagStr} (${strengthPct}%)`);
      } else if (effectiveConf === 'stale') {
        console.log(`- **${confTag} Previously observed (${dateStr}): ${globalPrefix}${e.content}**${tagStr} (${strengthPct}%)`);
      } else {
        console.log(`- **${confTag} Previously observed (${dateStr}): ${globalPrefix}${e.content}**${tagStr} (${strengthPct}%)`);
      }
    } else if (framing === 'suggest') {
      console.log(`- **${confTag} Consider checking: ${globalPrefix}${e.content}**${tagStr} (${strengthPct}%)`);
    } else {
      // framing === 'assert': no prefix (bare facts)
      console.log(`- **${confTag} ${globalPrefix}${e.content}**${tagStr} (${strengthPct}%)`);
    }
  }
}

function autoDetectContext(): string {
  // Try git diff --name-only for changed files
  try {
    const diff = execSync('git diff --name-only HEAD 2>&1', {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();

    if (diff) {
      // Extract meaningful terms from file paths
      const terms = diff
        .split('\n')
        .flatMap((f: string) => f.replace(/[\/\\\.]/g, ' ').split(/\s+/))
        .filter((t: string) => t.length > 2 && !['src', 'dist', 'test', 'tests', 'node_modules', 'index'].includes(t))
        .slice(0, 10);
      if (terms.length > 0) return terms.join(' ');
    }

    // Try branch name
    const branch = execSync('git branch --show-current 2>&1', {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();

    if (branch && branch !== 'main' && branch !== 'master') {
      return branch.replace(/[-_\/]/g, ' ');
    }
  } catch {
    // Not a git repo or git not available, fall through
  }

  return '';
}

// ---------------------------------------------------------------------------
// Embed command
// ---------------------------------------------------------------------------

async function cmdEmbed(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  requireInit(hippoRoot);

  if (!isEmbeddingAvailable()) {
    console.log('Embeddings not available. Install @xenova/transformers to enable:');
    console.log('  npm install @xenova/transformers');
    return;
  }

  if (flags['reset-physics']) {
    const entries = loadAllEntries(hippoRoot);
    const embIndex = loadEmbeddingIndex(hippoRoot);
    const db = openHippoDb(hippoRoot);
    try {
      const count = resetAllPhysicsState(db, entries, embIndex);
      console.log(`Reset physics state: ${count} particles re-initialized from embeddings.`);
    } finally {
      closeHippoDb(db);
    }
    return;
  }

  if (flags['status']) {
    const entries = loadAllEntries(hippoRoot);
    const embIndex = loadEmbeddingIndex(hippoRoot);
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
    return;
  }

  console.log('Embedding all memories (this may take a moment on first run to download model)...');
  const count = await embedAll(hippoRoot);
  const entriesAfter = loadAllEntries(hippoRoot);
  const embIndexAfter = loadEmbeddingIndex(hippoRoot);
  console.log(`Done. ${count} new embeddings created. ${Object.keys(embIndexAfter).length}/${entriesAfter.length} total.`);
}

// ---------------------------------------------------------------------------
// Watch command
// ---------------------------------------------------------------------------

async function cmdWatch(command: string, hippoRoot: string): Promise<void> {
  if (!command) {
    console.error('Usage: hippo watch "<command>"');
    process.exit(1);
  }

  const { exitCode, stderr } = await runWatched(command);

  if (exitCode === 0) {
    // Success: no noise
    return;
  }

  // Only create memory if hippo is initialized
  if (!isInitialized(hippoRoot)) {
    console.error('Command failed but .hippo not initialized. Run `hippo init` to enable auto-learn.');
    process.exit(exitCode);
  }

  const entry = captureError(exitCode, stderr, command);
  // Compute schema fit against existing memories
  const existingWatch = loadAllEntries(hippoRoot);
  const watchFit = computeSchemaFit(entry.content, entry.tags, existingWatch);
  entry.schema_fit = watchFit;
  entry.half_life_days = deriveHalfLife(7, entry);
  entry.strength = calculateStrength(entry);
  writeEntry(hippoRoot, entry);
  updateStats(hippoRoot, { remembered: 1 });

  if (isEmbeddingAvailable()) {
    embedMemory(hippoRoot, entry).catch(() => {});
  }

  const preview = stderr.trim().slice(0, 80);
  console.error(`\nHippo learned from failure: "${preview}"`);

  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Learn command
// ---------------------------------------------------------------------------

function learnFromRepo(
  hippoRoot: string,
  repoPath: string,
  days: number,
  label?: string
): { added: number; skipped: number } {
  const prefix = label ? `[${label}] ` : '';

  if (!isGitRepo(repoPath)) {
    console.log(`${prefix}No git history found (or not a git repository).`);
    return { added: 0, skipped: 0 };
  }

  const gitLog = fetchGitLog(repoPath, days);
  if (!gitLog.trim()) {
    console.log(`${prefix}No fix/revert/bug commits found in the specified period.`);
    return { added: 0, skipped: 0 };
  }

  const lessons = extractLessons(gitLog);
  if (lessons.length === 0) {
    console.log(`${prefix}No fix/revert/bug commits found in the specified period.`);
    return { added: 0, skipped: 0 };
  }

  let added = 0;
  let skipped = 0;
  const gitLearnTags = ['error', 'git-learned'];
  const existingForSchema = loadAllEntries(hippoRoot);

  for (const lesson of lessons) {
    if (deduplicateLesson(existingForSchema, lesson)) {
      skipped++;
      continue;
    }

    const target = extractInvalidationTarget(lesson);
    if (target) {
      const invResult = invalidateMatching(hippoRoot, target);
      if (invResult.invalidated > 0) {
        console.log(`${prefix}   Invalidated ${invResult.invalidated} memories referencing "${target.from}"`);
      }
    }

    const schemaFitVal = computeSchemaFit(lesson, gitLearnTags, existingForSchema);

    const entry = createMemory(lesson, {
      layer: Layer.Episodic,
      tags: [...gitLearnTags],
      source: 'git-learn',
      confidence: 'observed',
      schema_fit: schemaFitVal,
    });

    // Auto-tag with path context from the repo being learned
    const learnPathTags = extractPathTags(repoPath);
    for (const pt of learnPathTags) {
      if (!entry.tags.includes(pt)) entry.tags.push(pt);
    }

    writeEntry(hippoRoot, entry);
    updateStats(hippoRoot, { remembered: 1 });

    if (isEmbeddingAvailable()) {
      embedMemory(hippoRoot, entry).catch(() => {});
    }

    added++;
  }

  console.log(`${prefix}${added} new lessons added, ${skipped} duplicates skipped.`);
  return { added, skipped };
}

function cmdLearn(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  if (!flags['git']) {
    console.error('Usage: hippo learn --git [--days <n>] [--repos <paths>]');
    process.exit(1);
  }

  const days = parseInt(String(flags['days'] ?? '7'), 10);

  console.log(`Scanning git log for the last ${days} days...`);

  const reposFlag = flags['repos'];
  if (reposFlag && typeof reposFlag === 'string') {
    const repos = reposFlag.split(',').map((r) => r.trim()).filter(Boolean);
    let totalAdded = 0;
    let totalSkipped = 0;

    for (const repo of repos) {
      const label = path.basename(repo);
      const { added, skipped } = learnFromRepo(hippoRoot, repo, days, label);
      totalAdded += added;
      totalSkipped += skipped;
    }

    console.log(`Git learn complete: ${totalAdded} new lessons added, ${totalSkipped} duplicates skipped across ${repos.length} repos.`);
  } else {
    const { added, skipped } = learnFromRepo(hippoRoot, process.cwd(), days);
    console.log(`Git learn complete: ${added} new lessons added, ${skipped} duplicates skipped.`);
  }
}

// ---------------------------------------------------------------------------
// Import command
// ---------------------------------------------------------------------------

function cmdImport(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  const useGlobal = Boolean(flags['global']);
  const dryRun = Boolean(flags['dry-run']);
  const extraTags: string[] = Array.isArray(flags['tag'])
    ? (flags['tag'] as string[])
    : flags['tag']
      ? [String(flags['tag'])]
      : [];

  const targetRoot = useGlobal ? getGlobalRoot() : hippoRoot;

  if (useGlobal) {
    initGlobal();
  } else {
    requireInit(hippoRoot);
  }

  const importOptions: ImportOptions = {
    dryRun,
    global: useGlobal,
    extraTags,
    hippoRoot,
  };

  // Determine which importer to use based on flag
  let filePath: string | undefined;
  let importer: ((fp: string, opts: ImportOptions) => ReturnType<typeof importChatGPT>) | undefined;
  let importerName = '';

  if (flags['chatgpt']) {
    filePath = String(flags['chatgpt']);
    importer = importChatGPT;
    importerName = 'ChatGPT';
  } else if (flags['claude']) {
    filePath = String(flags['claude']);
    importer = importClaude;
    importerName = 'Claude';
  } else if (flags['cursor']) {
    filePath = String(flags['cursor']);
    importer = importCursor;
    importerName = 'Cursor';
  } else if (flags['file']) {
    filePath = String(flags['file']);
    importer = importGenericFile;
    importerName = 'File';
  } else if (flags['markdown']) {
    filePath = String(flags['markdown']);
    importer = importMarkdown;
    importerName = 'Markdown';
  } else if (args[0]) {
    // Positional: try to auto-detect from extension
    filePath = args[0];
    importer = importGenericFile;
    importerName = 'File';
  }

  if (!filePath || !importer) {
    console.error('Usage: hippo import <--chatgpt|--claude|--cursor|--file|--markdown> <path>');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const result = importer(filePath, importOptions);

  const storeLabel = useGlobal ? `global (${getGlobalRoot()})` : targetRoot;

  console.log(`\nImport ${importerName}: ${filePath}`);
  console.log(`  Source entries found:  ${result.total}`);
  console.log(`  Imported:              ${result.imported}`);
  console.log(`  Skipped (dedup/noise): ${result.skipped}`);
  if (dryRun) {
    console.log('\n  (dry run - nothing written)');
    if (result.entries.length > 0) {
      console.log('\n  Would import:');
      for (const e of result.entries.slice(0, 10)) {
        console.log(`    - ${e.content.slice(0, 80)}`);
      }
      if (result.entries.length > 10) {
        console.log(`    ... and ${result.entries.length - 10} more`);
      }
    }
  } else {
    console.log(`  Store:                 ${storeLabel}`);
  }
}

// ---------------------------------------------------------------------------
// Promote command
// ---------------------------------------------------------------------------

function cmdPromote(hippoRoot: string, id: string): void {
  requireInit(hippoRoot);

  if (!id) {
    console.error('Usage: hippo promote <id>');
    process.exit(1);
  }

  try {
    const globalEntry = promoteToGlobal(hippoRoot, id);
    console.log(`Promoted ${id} to global store as ${globalEntry.id}`);
    console.log(`   Global store: ${getGlobalRoot()}`);
  } catch (err) {
    console.error(`Failed to promote: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Sync command
// ---------------------------------------------------------------------------

function cmdSync(hippoRoot: string): void {
  requireInit(hippoRoot);

  const globalRoot = getGlobalRoot();
  if (!isInitialized(globalRoot)) {
    console.log('No global store found. Run `hippo init --global` first.');
    return;
  }

  const count = syncGlobalToLocal(hippoRoot, globalRoot);
  console.log(`Synced ${count} global memories into local project.`);
}

// ---------------------------------------------------------------------------
// Hook install/uninstall
// ---------------------------------------------------------------------------

const HOOK_MARKERS = {
  start: '<!-- hippo:start -->',
  end: '<!-- hippo:end -->',
};

const HOOKS: Record<string, { file: string; content: string; description: string }> = {
  'claude-code': {
    file: 'CLAUDE.md',
    description: 'Claude Code',
    content: `
## Project Memory (Hippo)

Before starting work, load relevant context:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`

When you learn something important:
\`\`\`bash
hippo remember "<lesson>"
\`\`\`

When you hit an error or discover a gotcha:
\`\`\`bash
hippo remember "<what went wrong and why>" --error
\`\`\`

After significant discussions or decisions, capture context:
\`\`\`bash
hippo capture --stdin <<< 'summary of what was decided'
\`\`\`

After completing work successfully:
\`\`\`bash
hippo outcome --good
\`\`\`
`.trim(),
  },
  'codex': {
    file: 'AGENTS.md',
    description: 'OpenAI Codex',
    content: `
## Project Memory (Hippo)

At the start of every task, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

On errors or unexpected behaviour:
\`\`\`bash
hippo remember "<description of what went wrong>" --error
\`\`\`

On task completion:
\`\`\`bash
hippo outcome --good
\`\`\`
`.trim(),
  },
  'cursor': {
    file: '.cursorrules',
    description: 'Cursor',
    content: `
# Project Memory (Hippo)
# Before each task, load context:
#   hippo context --auto --budget 1500
# After errors:
#   hippo remember "<error description>" --error
# After completing:
#   hippo outcome --good
`.trim(),
  },
  'openclaw': {
    file: 'AGENTS.md',
    description: 'OpenClaw',
    content: `
## Project Memory (Hippo)

At the start of every session, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

On errors or unexpected behaviour:
\`\`\`bash
hippo remember "<description of what went wrong>" --error
\`\`\`

On task completion:
\`\`\`bash
hippo outcome --good
\`\`\`

After significant coding sessions:
\`\`\`bash
hippo learn --git
\`\`\`
`.trim(),
  },
  'opencode': {
    file: 'AGENTS.md',
    description: 'OpenCode',
    content: `
## Project Memory (Hippo)

At the start of every task, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

When you learn something important or hit an error:
\`\`\`bash
hippo remember "<lesson>" --error
\`\`\`

When stuck or repeating yourself, check if this happened before:
\`\`\`bash
hippo recall "<what's going wrong>" --budget 2000
\`\`\`

On task completion:
\`\`\`bash
hippo outcome --good
\`\`\`
`.trim(),
  },
};

function cmdHook(
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  const subcommand = args[0];
  const target = args[1];

  if (subcommand === 'list') {
    console.log('Available hooks:\n');
    for (const [name, hook] of Object.entries(HOOKS)) {
      console.log(`  ${name.padEnd(15)} -> ${hook.file} (${hook.description})`);
    }
    console.log('\nUsage: hippo hook install <name>');
    console.log('       hippo hook uninstall <name>');
    return;
  }

  if (subcommand === 'install') {
    if (!target || !HOOKS[target]) {
      console.error(`Unknown hook target: ${target ?? '(none)'}`);
      console.error(`   Available: ${Object.keys(HOOKS).join(', ')}`);
      process.exit(1);
    }

    const hook = HOOKS[target];
    const filepath = path.resolve(process.cwd(), hook.file);
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const block = `${HOOK_MARKERS.start}\n${hook.content}\n${HOOK_MARKERS.end}`;

    if (fs.existsSync(filepath)) {
      const existing = fs.readFileSync(filepath, 'utf8');

      // Check if already installed
      if (existing.includes(HOOK_MARKERS.start)) {
        // Replace existing block
        const re = new RegExp(
          `${escapeRegex(HOOK_MARKERS.start)}[\\s\\S]*?${escapeRegex(HOOK_MARKERS.end)}`,
          'g'
        );
        const updated = existing.replace(re, block);
        fs.writeFileSync(filepath, updated, 'utf8');
        console.log(`Updated Hippo hook in ${hook.file}`);
      } else {
        // Append
        const sep = existing.endsWith('\n') ? '\n' : '\n\n';
        fs.writeFileSync(filepath, existing + sep + block + '\n', 'utf8');
        console.log(`Installed Hippo hook in ${hook.file} (appended)`);
      }
    } else {
      // Create new file
      fs.writeFileSync(filepath, block + '\n', 'utf8');
      console.log(`Created ${hook.file} with Hippo hook`);
    }

    // For claude-code, also install the Stop hook in settings.json
    if (target === 'claude-code') {
      if (installClaudeCodeStopHook()) {
        console.log(`Installed hippo sleep Stop hook in Claude Code settings.json`);
      }
    }

    return;
  }

  if (subcommand === 'uninstall') {
    if (!target || !HOOKS[target]) {
      console.error(`Unknown hook target: ${target ?? '(none)'}`);
      process.exit(1);
    }

    const hook = HOOKS[target];
    const filepath = path.resolve(process.cwd(), hook.file);

    if (!fs.existsSync(filepath)) {
      console.log(`${hook.file} not found, nothing to uninstall.`);
      return;
    }

    const existing = fs.readFileSync(filepath, 'utf8');
    if (!existing.includes(HOOK_MARKERS.start)) {
      console.log(`No Hippo hook found in ${hook.file}.`);
      return;
    }

    const re = new RegExp(
      `\\n?${escapeRegex(HOOK_MARKERS.start)}[\\s\\S]*?${escapeRegex(HOOK_MARKERS.end)}\\n?`,
      'g'
    );
    const cleaned = existing.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trim();
    fs.writeFileSync(filepath, cleaned + '\n', 'utf8');
    console.log(`Removed Hippo hook from ${hook.file}`);

    // For claude-code, also remove the Stop hook from settings.json
    if (target === 'claude-code') {
      if (uninstallClaudeCodeStopHook()) {
        console.log(`Removed hippo sleep Stop hook from Claude Code settings.json`);
      }
    }

    return;
  }

  console.error('Usage: hippo hook <install|uninstall|list> [target]');
  process.exit(1);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Claude Code settings.json Stop hook (hippo sleep on session end)
// ---------------------------------------------------------------------------

const HIPPO_STOP_HOOK_MARKER = 'hippo sleep';

/**
 * Resolve the Claude Code user-level settings.json path (~/.claude/settings.json).
 * Always targets the global config so the Stop hook runs for all sessions.
 */
function resolveClaudeSettingsPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.claude', 'settings.json');
}

/**
 * Check if hippo sleep Stop hook is already installed in Claude Code settings.
 */
function hasClaudeCodeStopHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks?.Stop) return false;
  return JSON.stringify(hooks.Stop).includes(HIPPO_STOP_HOOK_MARKER);
}

/**
 * Install a Claude Code Stop hook that runs `hippo sleep` at session end.
 * Merges into existing settings.json without clobbering other hooks.
 */
function installClaudeCodeStopHook(): boolean {
  const settingsPath = resolveClaudeSettingsPath();
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      console.error(`   Warning: could not parse ${settingsPath}, skipping Stop hook install`);
      return false;
    }
  }

  if (hasClaudeCodeStopHook(settings)) return false;

  // Ensure hooks.Stop array exists
  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;
  if (!Array.isArray(hooks.Stop)) hooks.Stop = [];

  // Append hippo sleep hook entry (silent: runs every turn, must not produce errors)
  hooks.Stop.push({
    hooks: [
      {
        type: 'command',
        command: 'hippo sleep 2>/dev/null || true',
        timeout: 30,
      },
    ],
  });

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return true;
}

/**
 * Remove the hippo sleep Stop hook from Claude Code settings.json.
 */
function uninstallClaudeCodeStopHook(): boolean {
  const settingsPath = resolveClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) return false;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return false;
  }

  if (!hasClaudeCodeStopHook(settings)) return false;

  const hooks = settings.hooks as Record<string, unknown[]>;
  hooks.Stop = hooks.Stop.filter(
    (entry) => !JSON.stringify(entry).includes(HIPPO_STOP_HOOK_MARKER)
  );

  // Clean up empty Stop array
  if (hooks.Stop.length === 0) delete hooks.Stop;
  // Clean up empty hooks object
  if (Object.keys(hooks).length === 0) delete settings.hooks;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return true;
}

// ---------------------------------------------------------------------------
// Working Memory
// ---------------------------------------------------------------------------

function cmdWm(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? '';

  if (subcommand === 'push') {
    const scope = String(flags['scope'] ?? 'default').trim();
    const content = String(flags['content'] ?? '').trim();
    const importance = parseFloat(String(flags['importance'] ?? '0.5'));
    const sessionId = flags['session'] ? String(flags['session']).trim() : undefined;
    const taskId = flags['task'] ? String(flags['task']).trim() : undefined;

    if (!content) {
      console.error('Usage: hippo wm push --scope <scope> --content "..." [--importance 0.8] [--session <id>] [--task <id>]');
      process.exit(1);
    }

    const id = wmPush(hippoRoot, {
      scope,
      content,
      importance: Number.isFinite(importance) ? importance : 0.5,
      sessionId,
      taskId,
    });

    console.log(`Pushed working memory #${id} (scope=${scope}, importance=${Number.isFinite(importance) ? importance : 0.5})`);
    return;
  }

  if (subcommand === 'read') {
    const scope = flags['scope'] ? String(flags['scope']).trim() : undefined;
    const sessionId = flags['session'] ? String(flags['session']).trim() : undefined;
    const limit = parseInt(String(flags['limit'] ?? '20'), 10) || 20;

    const items = wmRead(hippoRoot, { scope, sessionId, limit });

    if (flags['json']) {
      console.log(JSON.stringify({ items }, null, 2));
      return;
    }

    if (items.length === 0) {
      console.log('No working memory entries.');
      return;
    }

    console.log(`Working memory (${items.length} entries):\n`);
    for (const item of items) {
      const sessionLabel = item.sessionId ? ` session=${item.sessionId}` : '';
      const taskLabel = item.taskId ? ` task=${item.taskId}` : '';
      console.log(`  #${item.id} [${item.scope}] importance=${item.importance}${sessionLabel}${taskLabel}`);
      console.log(`    ${item.content}`);
      console.log(`    created=${item.createdAt}`);
      console.log('');
    }
    return;
  }

  if (subcommand === 'clear') {
    const scope = flags['scope'] ? String(flags['scope']).trim() : undefined;
    const sessionId = flags['session'] ? String(flags['session']).trim() : undefined;

    const count = wmClear(hippoRoot, { scope, sessionId });
    console.log(`Cleared ${count} working memory entries.`);
    return;
  }

  if (subcommand === 'flush') {
    const scope = flags['scope'] ? String(flags['scope']).trim() : undefined;
    const sessionId = flags['session'] ? String(flags['session']).trim() : undefined;

    const count = wmFlush(hippoRoot, { scope, sessionId });
    console.log(`Flushed ${count} working memory entries.`);
    return;
  }

  console.error('Usage: hippo wm <push|read|clear|flush>');
  process.exit(1);
}

function printUsage(): void {
  console.log(`
Hippo - biologically-inspired memory system for AI agents

Usage: hippo <command> [options]

Commands:
  init                     Create .hippo/ structure in current directory
    --global               Init the global store ($HIPPO_HOME or ~/.hippo/)
    --no-hooks             Skip auto-detecting and installing agent hooks
    --no-schedule          Skip auto-creating daily learn+sleep cron job
    --no-learn             Skip seeding memories from git history
  remember <text>          Store a memory
    --tag <tag>            Add a tag (repeatable)
    --error                Tag as error (boosts retention)
    --pin                  Pin memory (never decays)
    --verified             Set confidence: verified (default)
    --observed             Set confidence: observed
    --inferred             Set confidence: inferred
    --global               Store in global store ($HIPPO_HOME or ~/.hippo/)
  recall <query>           Search and retrieve memories (local + global)
    --budget <n>           Token budget (default: 4000)
    --json                 Output as JSON
    --why                  Show match reasons and source annotations
  context                  Smart context injection for AI agents
    --auto                 Auto-detect task from git state
    --budget <n>           Token budget (default: 1500)
    --format <fmt>         Output format: markdown (default) or json
    --framing <mode>       Framing: observe (default), suggest, assert
  sleep                    Run consolidation pass (auto-learns from git first)
    --dry-run              Preview without writing
    --no-learn             Skip auto git-learn before consolidation
  status                   Show memory health stats
  outcome                  Apply feedback to last recall
    --good                 Memories were helpful
    --bad                  Memories were irrelevant
    --id <id>              Target a specific memory
  conflicts                List detected open memory conflicts
    --status <status>      Filter by status (default: open)
    --json                 Output as JSON
  resolve <conflict_id>    Resolve a memory conflict
    --keep <memory_id>     Memory to keep (required)
    --forget               Delete the losing memory (default: halve half-life)
  snapshot <sub>           Persist or inspect the current active task
    snapshot save          Save active task state
      --task <task>
      --summary <summary>
      --next-step <step>
      --source <source>    Optional source label
      --session <id>       Link snapshot to a session trail
    snapshot show          Show the active task snapshot
      --json               Output as JSON
    snapshot clear         Clear the active task snapshot
      --status <status>    Mark final status (default: cleared)
  session <sub>            Append or inspect short-term session history
    session log            Append a structured session event
      --id <session-id>
      --content <text>
      --type <type>        Event type (default: note)
      --task <task>        Optional task label
      --source <source>    Optional source label
    session show           Show recent events for a session or task
      --id <session-id>
      --task <task>
      --limit <n>          Event limit (default: 8)
      --json               Output as JSON
    session latest         Show latest task snapshot + events
      --id <session-id>   Filter by session
      --json               Output as JSON
    session resume         Re-inject latest handoff as context output
      --id <session-id>   Filter by session
  handoff <sub>            Manage session handoffs for continuity
    handoff create         Create a new session handoff
      --summary <text>     Handoff summary (required)
      --next <text>        Next action for successor
      --session <id>       Session ID (auto-generated if omitted)
      --task <id>          Associated task ID
      --artifact <path>    Related file path (repeatable)
    handoff latest         Show the most recent handoff
      --session <id>       Filter by session
      --json               Output as JSON
    handoff show <id>      Show a specific handoff by ID
  current <sub>            Show compact current state for agent injection
    current show           Active task + recent session events (default)
      --json               Output as JSON
  forget <id>              Force remove a memory
  inspect <id>             Show full memory detail
  embed                    Embed all memories for semantic search
    --status               Show embedding coverage
  watch "<command>"        Run command, auto-learn from failures
  learn                    Learn lessons from repository history
    --git                  Scan recent git commits for lessons
    --days <n>             Scan this many days back (default: 7)
    --repos <paths>        Comma-separated repo paths to scan
  promote <id>             Copy a local memory to the global store
  share <id>               Share a memory with attribution + transfer scoring
    --force                Share even if transfer score is low
    --auto                 Auto-share all high-transfer-score memories
    --dry-run              Preview what would be shared
    --min-score <n>        Minimum transfer score (default: 0.6)
  peers                    List projects contributing to global store
  sync                     Pull global memories into local project
  import                   Import memories from other AI tools
    --chatgpt <path>       Import from ChatGPT memory export (JSON or txt)
    --claude <path>        Import from CLAUDE.md or Claude memory.json
    --cursor <path>        Import from .cursorrules or .cursor/rules
    --file <path>          Import from any markdown or text file
    --markdown <path>      Import from structured MEMORY.md / AGENTS.md
    --dry-run              Preview without writing
    --global               Write to global store ($HIPPO_HOME or ~/.hippo/)
    --tag <tag>            Add extra tag (repeatable)
  export [file]            Export all memories (default: stdout)
    --format <fmt>         Output format: json (default) or markdown
  capture                  Extract memories from conversation text
    --stdin                Read from piped input
    --file <path>          Read from a file
    --last-session         (placeholder) Read from agent session logs
    --dry-run              Preview without writing
    --global               Write to global store ($HIPPO_HOME or ~/.hippo/)
  hook <sub> [target]      Manage framework integrations
    hook list              Show available hooks
    hook install <target>  Install hook (claude-code|codex|cursor|openclaw|opencode)
                           claude-code also installs Stop hook (hippo sleep on exit)
    hook uninstall <target> Remove hook
  decide "<decision>"      Record an architectural decision (90-day half-life)
    --context "<why>"      Why this decision was made
    --supersedes <id>      Supersede a previous decision (weakens it)
  invalidate "<pattern>"   Actively weaken memories matching an old pattern
    --reason "<why>"       Optional: what replaced it
  wm <sub>                 Working memory — bounded buffer for current state
    wm push                Push a working memory entry
      --scope <scope>      Scope name (default: default)
      --content <text>     Content to store (required)
      --importance <n>     Priority 0-1 (default: 0.5)
      --session <id>       Session ID
      --task <id>          Task ID
    wm read                Read working memory entries
      --scope <scope>      Filter by scope
      --session <id>       Filter by session
      --limit <n>          Max entries (default: 20)
      --json               Output as JSON
    wm clear               Clear working memory entries
      --scope <scope>      Filter by scope
      --session <id>       Filter by session
    wm flush               Flush working memory (session end)
      --scope <scope>      Filter by scope
      --session <id>       Filter by session
  dashboard                Open web dashboard for memory health
    --port <n>             Port to serve on (default: 3333)
  mcp                      Start MCP server (stdio transport)

Examples:
  hippo init
  hippo remember "FRED cache can silently drop series" --tag error
  hippo recall "data pipeline issues" --budget 2000
  hippo context --auto --budget 1500
  hippo conflicts
  hippo session log --id sess_123 --task "Ship feature" --type progress --content "Build is green, next step is docs"
  hippo session latest --json
  hippo session resume
  hippo snapshot save --task "Ship feature" --summary "Tests are green" --next-step "Open the PR" --session sess_123
  hippo handoff create --summary "PR is open, tests green" --next "Merge after review" --session sess_123 --artifact src/foo.ts
  hippo embed --status
  hippo watch "npm run build"
  hippo learn --git --days 30
  hippo promote mem_abc123
  hippo sync
  hippo hook install claude-code
  hippo decide "Use PostgreSQL for new services" --context "JSONB support"
  hippo invalidate "REST API" --reason "migrated to GraphQL"
  hippo export memories.json
  hippo export --format markdown memories.md
  hippo sleep --dry-run
  hippo outcome --good
  hippo status
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const { command, args, flags } = parseArgs(process.argv);
const hippoRoot = getHippoRoot(process.cwd());

async function main(): Promise<void> {
  switch (command) {
    case 'init':
      cmdInit(hippoRoot, flags);
      break;

    case 'remember': {
      const text = args.join(' ').trim();
      if (!text) {
        console.error('Please provide text to remember.');
        process.exit(1);
      }
      cmdRemember(hippoRoot, text, flags);
      break;
    }

    case 'recall': {
      const query = args.join(' ').trim();
      if (!query) {
        console.error('Please provide a search query.');
        process.exit(1);
      }
      await cmdRecall(hippoRoot, query, flags);
      break;
    }

    case 'sleep':
      cmdSleep(hippoRoot, flags);
      break;

    case 'status':
      cmdStatus(hippoRoot);
      break;

    case 'outcome':
      cmdOutcome(hippoRoot, flags);
      break;

    case 'conflicts':
      cmdConflicts(hippoRoot, flags);
      break;

    case 'resolve':
      cmdResolve(hippoRoot, args, flags);
      break;

    case 'snapshot':
      cmdSnapshot(hippoRoot, args, flags);
      break;

    case 'session':
      cmdSession(hippoRoot, args, flags);
      break;

    case 'handoff':
      cmdHandoff(hippoRoot, args, flags);
      break;

    case 'current':
      cmdCurrent(hippoRoot, args, flags);
      break;

    case 'forget': {
      const id = args[0];
      if (!id) {
        console.error('Please provide a memory ID.');
        process.exit(1);
      }
      cmdForget(hippoRoot, id);
      break;
    }

    case 'inspect': {
      const id = args[0];
      if (!id) {
        console.error('Please provide a memory ID.');
        process.exit(1);
      }
      cmdInspect(hippoRoot, id);
      break;
    }

    case 'context':
      await cmdContext(hippoRoot, args, flags);
      break;

    case 'hook':
      cmdHook(args, flags);
      break;

    case 'embed':
      await cmdEmbed(hippoRoot, flags);
      break;

    case 'watch': {
      const watchCmd = args.join(' ').trim();
      await cmdWatch(watchCmd, hippoRoot);
      break;
    }

    case 'learn':
      cmdLearn(hippoRoot, flags);
      break;

    case 'promote': {
      const id = args[0];
      if (!id) {
        console.error('Please provide a memory ID.');
        process.exit(1);
      }
      cmdPromote(hippoRoot, id);
      break;
    }

    case 'sync':
      cmdSync(hippoRoot);
      break;

    case 'share': {
      const shareId = args[0];
      if (shareId === '--auto' || flags['auto']) {
        // Auto-share mode
        requireInit(hippoRoot);
        const minScore = parseFloat(String(flags['min-score'] ?? '0.6'));
        const dryRun = Boolean(flags['dry-run']);
        const results = autoShare(hippoRoot, { minScore, dryRun });
        if (results.length === 0) {
          console.log('No memories meet the sharing threshold.');
        } else if (dryRun) {
          console.log(`Would share ${results.length} memories:\n`);
          for (const e of results) {
            const score = transferScore(e);
            console.log(`  ${e.id} (transfer=${fmt(score)}) ${e.content.slice(0, 80)}...`);
          }
        } else {
          console.log(`Shared ${results.length} memories to global store.`);
          for (const e of results) {
            console.log(`  ${e.id} <- ${e.source}`);
          }
        }
      } else if (shareId) {
        requireInit(hippoRoot);
        const force = Boolean(flags['force']);
        const result = shareMemory(hippoRoot, shareId, { force });
        if (result) {
          console.log(`Shared [${result.id}] to global store.`);
          console.log(`  Source: ${result.source}`);
        } else {
          const entry = readEntry(hippoRoot, shareId);
          if (entry) {
            const score = transferScore(entry);
            console.log(`Transfer score too low (${fmt(score)}). This memory looks project-specific.`);
            console.log('Use --force to share anyway.');
          } else {
            console.error(`Memory not found: ${shareId}`);
            process.exit(1);
          }
        }
      } else {
        console.error('Usage: hippo share <memory_id> [--force] or hippo share --auto [--dry-run]');
        process.exit(1);
      }
      break;
    }

    case 'peers': {
      const peers = listPeers();
      if (peers.length === 0) {
        console.log('No peers found. Share memories with: hippo share <id>');
      } else {
        console.log(`${peers.length} project${peers.length === 1 ? '' : 's'} contributing to global store:\n`);
        for (const p of peers) {
          console.log(`  ${p.project.padEnd(25)} ${String(p.count).padStart(4)} memories  (latest: ${p.latest.slice(0, 10)})`);
        }
      }
      break;
    }

    case 'import':
      cmdImport(hippoRoot, args, flags);
      break;

    case 'export': {
      requireInit(hippoRoot);
      const format = (flags['format'] as string) || 'json';
      const outputPath = args[0] || null;
      const entries = loadAllEntries(hippoRoot);

      let output: string;
      if (format === 'markdown' || format === 'md') {
        output = entries.map(e => {
          const meta = [
            `id: ${e.id}`,
            `created: ${e.created}`,
            `tags: ${e.tags.join(', ')}`,
            `confidence: ${e.confidence}`,
            `half_life: ${e.half_life_days}d`,
            `strength: ${e.strength.toFixed(2)}`,
          ].join(' | ');
          return `### ${e.id}\n\n${e.content}\n\n_${meta}_`;
        }).join('\n\n---\n\n');
      } else {
        output = JSON.stringify(entries, null, 2);
      }

      if (outputPath) {
        fs.writeFileSync(outputPath, output, 'utf8');
        console.log(`Exported ${entries.length} memories to ${outputPath}`);
      } else {
        console.log(output);
      }
      break;
    }

    case 'capture': {
      let captureSource: CaptureOptions['source'] | null = null;
      let captureFile: string | undefined;

      if (flags['stdin']) { captureSource = 'stdin'; }
      else if (flags['file']) { captureSource = 'file'; captureFile = String(flags['file']); }
      else if (flags['last-session']) { captureSource = 'last-session'; }

      if (!captureSource) {
        console.error('Usage: hippo capture --stdin|--file <path>|--last-session [--dry-run] [--global]');
        process.exit(1);
      }

      cmdCapture(hippoRoot, {
        source: captureSource,
        filePath: captureFile,
        dryRun: Boolean(flags['dry-run']),
        global: Boolean(flags['global']),
      });
      break;
    }

    case 'dashboard': {
      requireInit(hippoRoot);
      const port = parseInt(String(flags['port'] ?? '3333'), 10);
      const { serveDashboard } = await import('./dashboard.js');
      serveDashboard(hippoRoot, port);
      await new Promise(() => {}); // run until Ctrl+C
      break;
    }

    case 'wm':
      cmdWm(hippoRoot, args, flags);
      break;

    case 'mcp':
      // Start MCP server over stdio - dynamically import to keep main CLI lean
      await import('./mcp/server.js');
      // Server runs until stdin closes, so we never reach here
      await new Promise(() => {}); // hang forever
      break;

    case 'invalidate': {
      requireInit(hippoRoot);
      const target = args[0];
      if (!target) {
        console.error('Usage: hippo invalidate "<old pattern>" [--reason "<why>"]');
        process.exit(1);
      }
      const reason = flags['reason'] as string || null;
      const invTarget: InvalidationTarget = {
        from: target,
        to: reason,
        type: 'migration',
      };
      const result = invalidateMatching(hippoRoot, invTarget);
      if (result.invalidated === 0) {
        console.log(`No memories matched "${target}".`);
      } else {
        console.log(`Invalidated ${result.invalidated} memories referencing "${target}".`);
        result.targets.forEach(id => console.log(`   ${id}`));
      }
      break;
    }

    case 'decide': {
      requireInit(hippoRoot);
      const text = args[0];
      if (!text) {
        console.error('Usage: hippo decide "<decision>" [--context "<why>"] [--supersedes <id>]');
        process.exit(1);
      }

      const context = flags['context'] as string || '';
      const supersedesId = flags['supersedes'] as string || null;

      // Build content with context
      const decisionContent = context ? `${text}\n\nContext: ${context}` : text;

      // Handle supersession
      if (supersedesId) {
        const oldEntry = readEntry(hippoRoot, supersedesId);
        if (!oldEntry) {
          console.error(`Memory ${supersedesId} not found.`);
          process.exit(1);
        }
        oldEntry.half_life_days = Math.max(1, Math.floor(oldEntry.half_life_days / 2));
        oldEntry.confidence = 'stale';
        if (!oldEntry.tags.includes('superseded')) oldEntry.tags.push('superseded');
        writeEntry(hippoRoot, oldEntry);
        console.log(`Superseded ${supersedesId} (half-life halved, marked stale)`);
      }

      // Create decision memory
      const mem = createMemory(decisionContent, {
        tags: ['decision'],
        layer: Layer.Semantic,
        confidence: 'verified',
        source: 'decision',
      });
      mem.half_life_days = DECISION_HALF_LIFE_DAYS;

      // Auto-tag with path context
      const decisionPathTags = extractPathTags(process.cwd());
      for (const pt of decisionPathTags) {
        if (!mem.tags.includes(pt)) mem.tags.push(pt);
      }

      writeEntry(hippoRoot, mem);

      console.log(`Decision recorded: ${mem.id}`);
      if (supersedesId) {
        console.log(`   Supersedes: ${supersedesId}`);
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h':
    case '':
      printUsage();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message ?? err);
  process.exit(1);
});
