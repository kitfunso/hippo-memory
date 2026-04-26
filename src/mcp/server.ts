#!/usr/bin/env node
/**
 * Hippo Memory MCP Server
 *
 * Exposes hippo memory as MCP tools over stdio transport.
 * Uses the programmatic API directly (no child process spawning).
 *
 * Usage: hippo mcp (or npx hippo-memory mcp)
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  createMemory,
  computeSchemaFit,
  Layer,
  applyOutcome,
  calculateStrength,
} from '../memory.js';
import { search, hybridSearch, physicsSearch, markRetrieved, estimateTokens } from '../search.js';
import { loadAllEntries, writeEntry, readEntry, initStore, loadActiveTaskSnapshot, listMemoryConflicts, resolveConflict } from '../store.js';
import { shareMemory, listPeers, getGlobalRoot } from '../shared.js';
import { consolidate } from '../consolidate.js';
import { execSync } from 'child_process';
import { fetchGitLog, extractLessons, deduplicateLesson, isGitRepo } from '../autolearn.js';
import { loadConfig } from '../config.js';
import { resolveConfidence } from '../memory.js';

// ── Find hippo root ──

function findHippoRoot(): string | null {
  // Walk up from cwd
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.hippo');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Global fallback (respects $HIPPO_HOME / $XDG_DATA_HOME)
  const global = getGlobalRoot();
  if (fs.existsSync(global)) return global;
  return null;
}

// ── MCP protocol types ──

interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// MCP stdio transport spec: messages are newline-delimited JSON-RPC, no embedded newlines.
// https://modelcontextprotocol.io/specification/.../basic/transports#stdio
function send(msg: McpResponse): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ── Format helpers ──

function formatMemories(results: ReturnType<typeof search>, hippoRoot: string): string {
  if (results.length === 0) return 'No relevant memories found.';

  const config = loadConfig(hippoRoot);
  const lines: string[] = [`Found ${results.length} memories:\n`];

  for (const r of results) {
    const conf = resolveConfidence(r.entry);
    const tags = r.entry.tags.length > 0 ? ` tags: ${r.entry.tags.join(', ')}` : '';
    lines.push(`[${conf}]${tags} (strength=${r.entry.strength.toFixed(2)})`);
    lines.push(r.entry.content);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Tool definitions ──

const TOOLS = [
  {
    name: 'hippo_recall',
    description:
      'Retrieve relevant memories from the project memory store. Returns memories ranked by relevance, strength, and recency within the token budget. Use at session start or when you need context about a topic.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to search for in memory (natural language)' },
        budget: { type: 'number', description: 'Max tokens to return (default: 1500)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'hippo_remember',
    description:
      'Store a new memory. Use when you learn something non-obvious, hit an error, or discover a useful pattern. Memories decay over time unless retrieved. Errors get 2x half-life.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string',
          description: 'The memory to store (1-2 sentences, specific and concrete)',
        },
        error: { type: 'boolean', description: 'Mark as error memory (doubles half-life)' },
        pin: { type: 'boolean', description: 'Pin memory (never decays)' },
        tag: { type: 'string', description: 'Optional tag for categorization' },
      },
      required: ['text'],
    },
  },
  {
    name: 'hippo_outcome',
    description:
      'Report whether recalled memories were useful. Strengthens good memories (+5 days half-life) and weakens bad ones (-3 days). Call after completing work.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        good: {
          type: 'boolean',
          description: 'true = memories helped, false = memories were irrelevant',
        },
      },
      required: ['good'],
    },
  },
  {
    name: 'hippo_context',
    description:
      'Smart context injection: auto-detects current task from git state and returns relevant memories. Use at the start of any session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        budget: { type: 'number', description: 'Max tokens (default: 1500)' },
      },
    },
  },
  {
    name: 'hippo_status',
    description:
      'Check memory health: counts, strengths, at-risk memories, last consolidation time.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'hippo_learn',
    description:
      'Scan recent git commits for lessons from fix/revert/bug/refactor/perf patterns. Run after coding sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number', description: 'Days to scan back (default: 7)' },
      },
    },
  },
  {
    name: 'hippo_conflicts',
    description:
      'List open memory conflicts — contradictory memories that need resolution.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'hippo_resolve',
    description:
      'Resolve a memory conflict by keeping one memory and weakening or deleting the other.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        conflict_id: { type: 'number', description: 'The conflict ID to resolve' },
        keep: { type: 'string', description: 'ID of the memory to keep' },
        forget: { type: 'boolean', description: 'Delete the loser instead of weakening (default: false)' },
      },
      required: ['conflict_id', 'keep'],
    },
  },
  {
    name: 'hippo_share',
    description:
      'Share a memory to the global store for cross-project use with transfer scoring.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Memory ID to share' },
        force: { type: 'boolean', description: 'Share even if transfer score is low' },
      },
      required: ['id'],
    },
  },
  {
    name: 'hippo_peers',
    description:
      'List all projects that have contributed memories to the global shared store.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

// ── Track last recalled IDs for outcome feedback ──
let lastRecalledIds: string[] = [];

// ── Tool execution ──

async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const hippoRoot = findHippoRoot();
  if (!hippoRoot) return 'No .hippo/ store found. Run: hippo init';

  const config = loadConfig(hippoRoot);

  switch (name) {
    case 'hippo_recall': {
      const query = String(args.query || '');
      const budget = Number(args.budget) || config.defaultBudget;
      const entries = loadAllEntries(hippoRoot);
      const usePhysics = config.physics?.enabled !== false;
      const results = usePhysics
        ? await physicsSearch(query, entries, { budget, hippoRoot, physicsConfig: config.physics })
        : await hybridSearch(query, entries, { budget, hippoRoot });

      // Mark retrieved and persist
      const retrieved = markRetrieved(results.map((r) => r.entry));
      for (const entry of retrieved) writeEntry(hippoRoot, entry);
      lastRecalledIds = retrieved.map((e) => e.id);

      return formatMemories(results, hippoRoot);
    }

    case 'hippo_remember': {
      const text = String(args.text || '');
      if (!text) return 'No text provided.';
      const tags: string[] = [];
      if (args.error) tags.push('error');
      if (args.tag) tags.push(String(args.tag));
      const existing = loadAllEntries(hippoRoot);
      const schemaFit = computeSchemaFit(text, tags, existing);
      const entry = createMemory(text, {
        layer: Layer.Episodic,
        tags,
        pinned: Boolean(args.pin),
        source: 'mcp',
        confidence: 'verified',
        baseHalfLifeDays: config.defaultHalfLifeDays,
        schema_fit: schemaFit,
      });
      writeEntry(hippoRoot, entry);

      // Auto-sleep check
      if (config.autoSleep.enabled) {
        const allEntries = loadAllEntries(hippoRoot);
        const recentCount = allEntries.filter((e) => {
          const age = (Date.now() - new Date(e.created).getTime()) / (1000 * 60 * 60);
          return age < 24; // created in last 24 hours
        }).length;
        if (recentCount >= config.autoSleep.threshold) {
          consolidate(hippoRoot);
        }
      }

      return `Remembered [${entry.id}] (half-life: ${entry.half_life_days}d, tags: ${entry.tags.join(', ') || 'none'})`;
    }

    case 'hippo_outcome': {
      const good = Boolean(args.good);
      if (lastRecalledIds.length === 0) return 'No recent recalls to apply outcome to.';

      let count = 0;
      for (const id of lastRecalledIds) {
        const entry = readEntry(hippoRoot, id);
        if (entry) {
          const updated = applyOutcome(entry, good);
          writeEntry(hippoRoot, updated);
          count++;
        }
      }
      return `Applied ${good ? 'positive' : 'negative'} outcome to ${count} memories`;
    }

    case 'hippo_context': {
      const budget = Number(args.budget) || config.defaultContextBudget;
      // Auto-detect query from git
      let query = '';
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', { encoding: 'utf-8' }).trim();
        const diff = execSync('git diff --cached --stat 2>/dev/null', { encoding: 'utf-8' }).trim();
        const log = execSync('git log -1 --pretty=format:"%s" 2>/dev/null', { encoding: 'utf-8' }).trim();
        query = [branch, log, diff].filter(Boolean).join(' ');
      } catch { /* not a git repo */ }

      if (!query) query = 'project context general';

      const entries = loadAllEntries(hippoRoot);
      const usePhysicsCtx = config.physics?.enabled !== false;
      const results = usePhysicsCtx
        ? await physicsSearch(query, entries, { budget, hippoRoot, physicsConfig: config.physics })
        : await hybridSearch(query, entries, { budget, hippoRoot });
      const retrieved = markRetrieved(results.map((r) => r.entry));
      for (const entry of retrieved) writeEntry(hippoRoot, entry);
      lastRecalledIds = retrieved.map((e) => e.id);

      const snapshot = loadActiveTaskSnapshot(hippoRoot);
      const snapshotText = snapshot
        ? [
            '## Active Task Snapshot',
            `- Task: ${snapshot.task}`,
            `- Status: ${snapshot.status}`,
            `- Updated: ${snapshot.updated_at}`,
            '',
            '### Summary',
            snapshot.summary,
            '',
            '### Next step',
            snapshot.next_step,
            '',
          ].join('\n')
        : '';

      const memoryText = formatMemories(results, hippoRoot);
      return snapshotText ? `${snapshotText}\n${memoryText}` : memoryText;
    }

    case 'hippo_status': {
      const entries = loadAllEntries(hippoRoot);
      const now = new Date();
      let atRisk = 0;
      let totalStrength = 0;
      for (const e of entries) {
        const s = calculateStrength(e, now);
        totalStrength += s;
        if (s < 0.1 && !e.pinned) atRisk++;
      }
      const avgStrength = entries.length > 0 ? (totalStrength / entries.length).toFixed(2) : '0';
      const pinned = entries.filter((e) => e.pinned).length;
      const errors = entries.filter((e) => e.tags.includes('error')).length;
      const conflicts = listMemoryConflicts(hippoRoot).length;
      return [
        `Memories: ${entries.length} (${pinned} pinned, ${errors} errors)`,
        `Avg strength: ${avgStrength}`,
        `At risk (<0.1): ${atRisk}`,
        `Open conflicts: ${conflicts}`,
        `Half-life default: ${config.defaultHalfLifeDays}d`,
      ].join('\n');
    }

    case 'hippo_learn': {
      const days = Number(args.days) || 7;
      if (!isGitRepo(process.cwd())) return 'No git history found.';
      const gitLog = fetchGitLog(process.cwd(), days);
      if (!gitLog.trim()) return 'No fix/revert/bug commits found in the specified period.';
      const lessons = extractLessons(gitLog, config.gitLearnPatterns);
      let added = 0;
      let skipped = 0;
      for (const lesson of lessons) {
        if (deduplicateLesson(hippoRoot, lesson)) { skipped++; continue; }
        const entry = createMemory(lesson, {
          layer: Layer.Episodic,
          tags: ['git-learned'],
          source: 'git',
          confidence: 'observed',
          baseHalfLifeDays: config.defaultHalfLifeDays,
        });
        writeEntry(hippoRoot, entry);
        added++;
      }
      return `Git learn: ${added} new, ${skipped} duplicates skipped (scanned ${days} days)`;
    }

    case 'hippo_conflicts': {
      const conflicts = listMemoryConflicts(hippoRoot, 'open');
      if (conflicts.length === 0) return 'No open conflicts.';
      return conflicts.map((c) =>
        `conflict_${c.id}: ${c.memory_a_id} <-> ${c.memory_b_id} (score=${c.score.toFixed(2)}) — ${c.reason}`
      ).join('\n');
    }

    case 'hippo_resolve': {
      const conflictId = Number(args.conflict_id);
      const keepId = String(args.keep || '');
      const forget = Boolean(args.forget);
      if (isNaN(conflictId) || !keepId) return 'Required: conflict_id and keep.';
      const result = resolveConflict(hippoRoot, conflictId, keepId, forget);
      if (!result) return 'Could not resolve. Check the conflict ID and --keep value.';
      const action = forget ? 'deleted' : 'weakened';
      return `Resolved conflict ${conflictId}: kept ${keepId}, ${action} ${result.loserId}`;
    }

    case 'hippo_share': {
      const shareId = String(args.id || '');
      if (!shareId) return 'Required: id (memory ID to share).';
      const force = Boolean(args.force);
      const shared = shareMemory(hippoRoot, shareId, { force });
      if (!shared) return 'Transfer score too low. Use force=true to override.';
      return `Shared [${shared.id}] to global store. Source: ${shared.source}`;
    }

    case 'hippo_peers': {
      const peers = listPeers();
      if (peers.length === 0) return 'No peers found.';
      return peers.map((p) => `${p.project}: ${p.count} memories (latest: ${p.latest.slice(0, 10)})`).join('\n');
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Request handling ──

async function handleRequest(req: McpRequest): Promise<McpResponse | null> {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'hippo-memory', version: '0.19.1' },
        },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'tools/call': {
      const toolName = (params as any)?.name;
      const toolArgs = (params as any)?.arguments ?? {};
      const output = await executeTool(toolName, toolArgs);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: output || 'Done.' }],
        },
      };
    }

    default:
      // Notifications (no id) must not receive a response
      if (method.startsWith('notifications/')) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ── Stdio transport ──

import { parseFrame } from './framing.js';

let buffer: Buffer = Buffer.alloc(0);

function dispatch(body: string): void {
  let req: McpRequest;
  try {
    req = JSON.parse(body) as McpRequest;
  } catch {
    return; // skip malformed
  }
  if (!req.method) return;
  if (req.method.startsWith('notifications/')) {
    handleRequest(req).catch(() => {});
    return;
  }
  handleRequest(req).then((resp) => { if (resp) send(resp); }).catch((err) => {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: err?.message ?? 'Internal error' } });
  });
}

process.stdin.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const result = parseFrame(buffer);
    if (result.kind === 'incomplete') break;
    buffer = result.rest;
    if (result.kind === 'message') dispatch(result.body);
  }
});

process.stdin.on('end', () => process.exit(0));

process.on('uncaughtException', (err) => {
  process.stderr.write(`hippo-mcp uncaught: ${err?.message ?? err}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`hippo-mcp unhandled: ${err instanceof Error ? err.message : String(err)}\n`);
});
