#!/usr/bin/env node
/**
 * Hippo CLI  - biologically-inspired memory system for AI agents.
 *
 * Commands:
 *   hippo init [--global]
 *   hippo remember <text> [--tag <t>] [--error] [--pin] [--global]
 *   hippo recall <query> [--budget <n>] [--json]
 *   hippo sleep [--dry-run]
 *   hippo status
 *   hippo outcome --good | --bad [--id <id>]
 *   hippo forget <id>
 *   hippo inspect <id>
 *   hippo embed [--status]
 *   hippo watch "<command>"
 *   hippo learn --git [--days <n>]
 *   hippo promote <id>
 *   hippo sync
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import {
  createMemory,
  calculateStrength,
  applyOutcome,
  Layer,
  MemoryEntry,
} from './memory.js';
import {
  getHippoRoot,
  isInitialized,
  initStore,
  writeEntry,
  readEntry,
  deleteEntry,
  loadAllEntries,
  loadIndex,
  saveIndex,
  loadStats,
  updateStats,
} from './store.js';
import { search, markRetrieved, estimateTokens, hybridSearch } from './search.js';
import { consolidate } from './consolidate.js';
import {
  isEmbeddingAvailable,
  embedAll,
  embedMemory,
  loadEmbeddingIndex,
} from './embeddings.js';
import {
  captureError,
  extractLessons,
  deduplicateLesson,
  runWatched,
  fetchGitLog,
} from './autolearn.js';
import {
  getGlobalRoot,
  initGlobal,
  promoteToGlobal,
  searchBoth,
  syncGlobalToLocal,
} from './shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
        // Check if it's a repeatable flag (tag)
        if (key === 'tag') {
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

  if (isInitialized(hippoRoot)) {
    console.log('Already initialized at', hippoRoot);
    return;
  }
  initStore(hippoRoot);
  console.log('Initialized Hippo at', hippoRoot);
  console.log('   Directories: buffer/ episodic/ semantic/ conflicts/');
  console.log('   Files: index.json stats.json');
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

  const entry = createMemory(text, {
    layer: Layer.Episodic,
    tags: rawTags,
    pinned: Boolean(flags['pin']),
    source: useGlobal ? 'cli-global' : 'cli',
  });

  writeEntry(targetRoot, entry);
  updateStats(targetRoot, { remembered: 1 });

  const prefix = useGlobal ? '[global] ' : '';
  console.log(`${prefix}Remembered [${entry.id}]`);
  console.log(`   Layer: ${entry.layer} | Strength: ${fmt(entry.strength)} | Half-life: ${entry.half_life_days}d`);
  if (entry.tags.length > 0) console.log(`   Tags: ${entry.tags.join(', ')}`);
  if (entry.pinned) console.log('   Pinned (no decay)');

  // Auto-embed if available
  if (isEmbeddingAvailable()) {
    embedMemory(targetRoot, entry).catch(() => {
      // Silently ignore embedding errors
    });
  }
}

function cmdRecall(
  hippoRoot: string,
  query: string,
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const budget = parseInt(String(flags['budget'] ?? '4000'), 10);
  const asJson = Boolean(flags['json']);
  const globalRoot = getGlobalRoot();

  const localEntries = loadAllEntries(hippoRoot);
  const globalEntries = isInitialized(globalRoot) ? loadAllEntries(globalRoot) : [];

  const hasGlobal = globalEntries.length > 0;

  let results;
  if (hasGlobal) {
    // Use searchBoth for merged results
    const merged = searchBoth(query, hippoRoot, globalRoot, { budget });
    results = merged;
  } else {
    results = search(query, localEntries, { budget });
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
  for (const u of updated) {
    // Determine which store this entry belongs to
    const localIndex = loadIndex(hippoRoot);
    const targetRoot = localIndex.entries[u.id] ? hippoRoot : (isInitialized(globalRoot) ? globalRoot : hippoRoot);
    writeEntry(targetRoot, u);
  }

  // Track last retrieval IDs for outcome command
  const index = loadIndex(hippoRoot);
  index.last_retrieval_ids = updated.map((u) => u.id);
  saveIndex(hippoRoot, index);

  updateStats(hippoRoot, { recalled: results.length });

  if (asJson) {
    const output = results.map((r) => ({
      id: r.entry.id,
      score: r.score,
      strength: r.entry.strength,
      tokens: r.tokens,
      tags: r.entry.tags,
      content: r.entry.content,
    }));
    console.log(JSON.stringify({ query, budget, results: output, total: output.length }));
    return;
  }

  const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
  console.log(`Found ${results.length} memories (${totalTokens} tokens) for: "${query}"\n`);

  for (const r of results) {
    const e = r.entry;
    const strengthBar = '\u2588'.repeat(Math.round(e.strength * 10)) + '\u2591'.repeat(10 - Math.round(e.strength * 10));
    const globalMark = (isInitialized(globalRoot) && !loadIndex(hippoRoot).entries[e.id]) ? ' [global]' : '';
    console.log(`--- ${e.id} [${e.layer}]${globalMark} score=${fmt(r.score, 3)} strength=${fmt(e.strength)}`);
    console.log(`    [${strengthBar}] tags: ${e.tags.join(', ') || 'none'} | retrieved: ${e.retrieval_count}x`);
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

  let totalStrength = 0;
  let pinned = 0;
  let atRisk = 0; // strength < 0.2

  for (const e of entries) {
    const s = calculateStrength(e, now);
    byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1;
    totalStrength += s;
    if (e.pinned) pinned++;
    if (s < 0.2) atRisk++;
  }

  const avgStrength = entries.length > 0 ? totalStrength / entries.length : 0;

  console.log('Hippo Status');
  console.log('---------------------------');
  console.log(`Total memories:    ${entries.length}`);
  console.log(`  Buffer:          ${byLayer[Layer.Buffer]}`);
  console.log(`  Episodic:        ${byLayer[Layer.Episodic]}`);
  console.log(`  Semantic:        ${byLayer[Layer.Semantic]}`);
  console.log(`Pinned:            ${pinned}`);
  console.log(`At risk (<0.2):    ${atRisk}`);
  console.log(`Avg strength:      ${fmt(avgStrength)}`);
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
    const embCount = Object.keys(embIndex).length;
    console.log(`Embedded:          ${embCount}/${entries.length} memories`);
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

  console.log(`Memory: ${entry.id}`);
  console.log('---------------------------');
  console.log(`Layer:            ${entry.layer}`);
  console.log(`Created:          ${entry.created} (${fmt(ageDays, 1)}d ago)`);
  console.log(`Last retrieved:   ${entry.last_retrieved} (${fmt(daysSince, 1)}d ago)`);
  console.log(`Retrieval count:  ${entry.retrieval_count}`);
  console.log(`Strength (live):  ${fmt(currentStrength)} (stored: ${fmt(entry.strength)})`);
  console.log(`Half-life:        ${entry.half_life_days}d`);
  console.log(`Emotional:        ${entry.emotional_valence}`);
  console.log(`Schema fit:       ${entry.schema_fit}`);
  console.log(`Pinned:           ${entry.pinned}`);
  console.log(`Tags:             ${entry.tags.join(', ') || 'none'}`);
  console.log(`Outcome score:    ${entry.outcome_score ?? 'none'}`);
  if (entry.conflicts_with.length > 0) {
    console.log(`Conflicts with:   ${entry.conflicts_with.join(', ')}`);
  }
  console.log('');
  console.log('Content:');
  console.log('-'.repeat(40));
  console.log(entry.content);
}

function cmdContext(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const budget = parseInt(String(flags['budget'] ?? '1500'), 10);

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
      const merged = searchBoth(query, hippoRoot, globalRoot, { budget });
      const localIndex = loadIndex(hippoRoot);
      results = merged.map((r) => ({
        entry: r.entry,
        score: r.score,
        tokens: r.tokens,
        isGlobal: !localIndex.entries[r.entry.id],
      }));
    } else {
      results = search(query, localEntries, { budget }).map((r) => ({
        entry: r.entry,
        score: r.score,
        tokens: r.tokens,
        isGlobal: false,
      }));
    }

    selectedItems = results;
    totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
  }

  if (selectedItems.length === 0) return;

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

  if (format === 'json') {
    const output = selectedItems.map((r) => ({
      id: r.entry.id,
      score: r.score,
      strength: r.entry.strength,
      tags: r.entry.tags,
      content: r.entry.content,
      global: r.isGlobal ?? false,
    }));
    console.log(JSON.stringify({ query, memories: output, tokens: totalTokens }));
  } else {
    printContextMarkdown(
      selectedItems.map((r) => ({
        entry: updatedEntries.find((u) => u.id === r.entry.id) ?? r.entry,
        score: r.score,
        tokens: r.tokens,
        isGlobal: r.isGlobal ?? false,
      })),
      totalTokens
    );
  }
}

function printContextMarkdown(
  items: Array<{ entry: MemoryEntry; score: number; tokens: number; isGlobal: boolean }>,
  totalTokens: number
): void {
  console.log(`## Project Memory (${items.length} entries, ${totalTokens} tokens)\n`);
  for (const item of items) {
    const e = item.entry;
    const tagStr = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : '';
    const strengthPct = Math.round(calculateStrength(e) * 100);
    const globalPrefix = item.isGlobal ? '[global] ' : '';
    console.log(`- **${globalPrefix}${e.content}**${tagStr} (${strengthPct}%)`);
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

  if (flags['status']) {
    const entries = loadAllEntries(hippoRoot);
    const embIndex = loadEmbeddingIndex(hippoRoot);
    const embCount = Object.keys(embIndex).length;
    console.log(`Embedding status: ${embCount}/${entries.length} memories embedded`);
    const missing = entries.filter((e) => !embIndex[e.id]);
    if (missing.length > 0) {
      console.log(`  ${missing.length} memories need embedding (run \`hippo embed\` to embed them)`);
    }
    return;
  }

  console.log('Embedding all memories (this may take a moment on first run to download model)...');
  const count = await embedAll(hippoRoot);
  const entries = loadAllEntries(hippoRoot);
  const embIndex = loadEmbeddingIndex(hippoRoot);
  console.log(`Done. ${count} new embeddings created. ${Object.keys(embIndex).length}/${entries.length} total.`);
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

function cmdLearn(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  if (!flags['git']) {
    console.error('Usage: hippo learn --git [--days <n>]');
    process.exit(1);
  }

  const days = parseInt(String(flags['days'] ?? '7'), 10);
  const cwd = process.cwd();

  console.log(`Scanning git log for the last ${days} days...`);

  const gitLog = fetchGitLog(cwd, days);
  if (!gitLog.trim()) {
    console.log('No git history found (or not a git repository).');
    return;
  }

  const lessons = extractLessons(gitLog);
  if (lessons.length === 0) {
    console.log('No fix/revert/bug commits found in the specified period.');
    return;
  }

  let added = 0;
  let skipped = 0;

  for (const lesson of lessons) {
    if (deduplicateLesson(hippoRoot, lesson)) {
      skipped++;
      continue;
    }

    const entry = createMemory(lesson, {
      layer: Layer.Episodic,
      tags: ['error', 'git-learned'],
      source: 'git-learn',
    });

    writeEntry(hippoRoot, entry);
    updateStats(hippoRoot, { remembered: 1 });

    if (isEmbeddingAvailable()) {
      embedMemory(hippoRoot, entry).catch(() => {});
    }

    added++;
  }

  console.log(`Git learn complete: ${added} new lessons added, ${skipped} duplicates skipped.`);
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
    file: '.openclaw/skills/hippo/SKILL.md',
    description: 'OpenClaw',
    content: `
# Hippo Memory Skill

On session start, inject project memory:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`

When an error occurs:
\`\`\`bash
hippo remember "<error>" --error
\`\`\`

On session end:
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
    return;
  }

  console.error('Usage: hippo hook <install|uninstall|list> [target]');
  process.exit(1);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function printUsage(): void {
  console.log(`
Hippo - biologically-inspired memory system for AI agents

Usage: hippo <command> [options]

Commands:
  init                     Create .hippo/ structure in current directory
    --global               Init the global store at ~/.hippo/
  remember <text>          Store a memory
    --tag <tag>            Add a tag (repeatable)
    --error                Tag as error (boosts retention)
    --pin                  Pin memory (never decays)
    --global               Store in global ~/.hippo/ store
  recall <query>           Search and retrieve memories (local + global)
    --budget <n>           Token budget (default: 4000)
    --json                 Output as JSON
  context                  Smart context injection for AI agents
    --auto                 Auto-detect task from git state
    --budget <n>           Token budget (default: 1500)
    --format <fmt>         Output format: markdown (default) or json
  sleep                    Run consolidation pass
    --dry-run              Preview without writing
  status                   Show memory health stats
  outcome                  Apply feedback to last recall
    --good                 Memories were helpful
    --bad                  Memories were irrelevant
    --id <id>              Target a specific memory
  forget <id>              Force remove a memory
  inspect <id>             Show full memory detail
  embed                    Embed all memories for semantic search
    --status               Show embedding coverage
  watch "<command>"        Run command, auto-learn from failures
  learn                    Learn lessons from repository history
    --git                  Scan recent git commits for lessons
    --days <n>             Scan this many days back (default: 7)
  promote <id>             Copy a local memory to the global store
  sync                     Pull global memories into local project
  hook <sub> [target]      Manage framework integrations
    hook list              Show available hooks
    hook install <target>  Install hook (claude-code|codex|cursor|openclaw)
    hook uninstall <target> Remove hook

Examples:
  hippo init
  hippo remember "FRED cache can silently drop series" --tag error
  hippo recall "data pipeline issues" --budget 2000
  hippo context --auto --budget 1500
  hippo embed --status
  hippo watch "npm run build"
  hippo learn --git --days 30
  hippo promote mem_abc123
  hippo sync
  hippo hook install claude-code
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
      cmdRecall(hippoRoot, query, flags);
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
      cmdContext(hippoRoot, args, flags);
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
