/**
 * Hippo Memory - OpenClaw Plugin
 *
 * Auto-injects relevant memory context at session start,
 * captures errors during sessions, and runs consolidation.
 *
 * Config lives under plugins.entries.hippo-memory.config
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { basename, dirname, join } from 'path';

interface HippoConfig {
  budget?: number;
  autoContext?: boolean;
  autoLearn?: boolean;
  autoSleep?: boolean;
  framing?: 'observe' | 'suggest' | 'assert';
  root?: string;
}

type HippoRuntimeContext = {
  workspaceDir?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
};

const AUTO_SLEEP_SESSION_THRESHOLD = 10;
const sessionMemoryCounts = new Map<string, number>();
const injectedSessions = new Set<string>();

function getConfig(api: any): HippoConfig {
  try {
    const entries = api.config?.plugins?.entries?.['hippo-memory'];
    return entries?.config ?? {};
  } catch {
    return {};
  }
}

function findHippoRoot(workspace?: string, configRoot?: string): string | null {
  if (configRoot && existsSync(configRoot)) return configRoot;

  const candidates = [
    workspace ? join(workspace, '.hippo') : null,
    process.env.HIPPO_ROOT,
    join(process.env.USERPROFILE || process.env.HOME || '', '.hippo'),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function getAgentWorkspace(api: any, agentId?: string): string | undefined {
  try {
    const agents = api.config?.agents;
    const list = Array.isArray(agents?.list) ? agents.list : [];

    if (agentId) {
      const match = list.find((agent: any) => agent?.id === agentId);
      if (typeof match?.workspace === 'string' && match.workspace) return match.workspace;
    }

    const defaultAgent = list.find((agent: any) => agent?.default);
    if (typeof defaultAgent?.workspace === 'string' && defaultAgent.workspace) {
      return defaultAgent.workspace;
    }

    const fallback = agents?.defaults?.workspace;
    return typeof fallback === 'string' && fallback ? fallback : undefined;
  } catch {
    return undefined;
  }
}

function resolveHippoCwd(workspace?: string, configRoot?: string): string {
  const hippoRoot = findHippoRoot(workspace, configRoot);
  if (!hippoRoot) return workspace || process.cwd();
  return basename(hippoRoot).toLowerCase() === '.hippo' ? dirname(hippoRoot) : hippoRoot;
}

function resolveHippoCwdFromContext(api: any, ctx: HippoRuntimeContext, configRoot?: string): string {
  const workspace = ctx.workspaceDir ?? getAgentWorkspace(api, ctx.agentId);
  return resolveHippoCwd(workspace, configRoot);
}

function getSessionIdentity(ctx: Pick<HippoRuntimeContext, 'sessionId' | 'sessionKey' | 'agentId'>): string | undefined {
  return ctx.sessionId ?? ctx.sessionKey ?? ctx.agentId;
}

function recordSessionMemory(ctx: Pick<HippoRuntimeContext, 'sessionId' | 'sessionKey' | 'agentId'>): void {
  const key = getSessionIdentity(ctx);
  if (!key) return;
  sessionMemoryCounts.set(key, (sessionMemoryCounts.get(key) ?? 0) + 1);
}

function consumeSessionMemoryCount(
  ctx: Pick<HippoRuntimeContext, 'sessionId' | 'sessionKey' | 'agentId'>,
): number {
  const key = getSessionIdentity(ctx);
  if (!key) return 0;
  const count = sessionMemoryCounts.get(key) ?? 0;
  sessionMemoryCounts.delete(key);
  return count;
}

function sanitizeTag(tag?: string): string | undefined {
  if (!tag) return undefined;
  const normalized = tag
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return normalized || undefined;
}

function formatToolErrorMemory(toolName: string, error: string): string {
  const normalized = error.replace(/\s+/g, ' ').trim();
  const truncated = normalized.slice(0, 500);
  const suffix = normalized.length > truncated.length ? ' [truncated]' : '';
  return `Tool '${toolName}' failed: ${truncated}${suffix}`;
}

function hippoRememberSucceeded(result: string): boolean {
  return result.includes('Remembered [');
}

function runHippo(args: string, cwd?: string): string {
  try {
    const result = execSync(`hippo ${args}`, {
      cwd: cwd || process.cwd(),
      timeout: 30000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (err: any) {
    return err.stdout?.trim() || err.message || 'hippo command failed';
  }
}

export default function register(api: any) {
  const logger = api.logger ?? console;

  // --- Tool: hippo_recall ---
  api.registerTool((ctx: HippoRuntimeContext) => ({
    name: 'hippo_recall',
    description:
      'Retrieve relevant memories from the project memory store. Returns memories ranked by relevance, strength, and recency within the token budget. Use at session start or when you need context about a topic.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for in memory (natural language)',
        },
        budget: {
          type: 'number',
          description: 'Max tokens to return (default: 1500)',
        },
      },
      required: ['query'],
    },
    async execute(_id: string, params: { query: string; budget?: number }) {
      const cfg = getConfig(api);
      const budget = params.budget ?? cfg.budget ?? 1500;
      const framing = cfg.framing ?? 'observe';
      const hippoCwd = resolveHippoCwdFromContext(api, ctx, cfg.root);
      const result = runHippo(
        `recall "${params.query.replace(/"/g, '\\"')}" --budget ${budget} --framing ${framing}`,
        hippoCwd,
      );
      return { content: [{ type: 'text', text: result || 'No relevant memories found.' }] };
    },
  }));

  // --- Tool: hippo_remember ---
  api.registerTool((ctx: HippoRuntimeContext) => ({
    name: 'hippo_remember',
    description:
      'Store a new memory. Use when you learn something non-obvious, hit an error, or discover a useful pattern. Memories decay over time unless retrieved. Errors get 2x half-life.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The memory to store (1-2 sentences, specific and concrete)',
        },
        error: {
          type: 'boolean',
          description: 'Mark as error memory (doubles half-life)',
        },
        pin: {
          type: 'boolean',
          description: 'Pin memory (never decays)',
        },
        tag: {
          type: 'string',
          description: 'Optional tag for categorization',
        },
      },
      required: ['text'],
    },
    async execute(
      _id: string,
      params: { text: string; error?: boolean; pin?: boolean; tag?: string },
    ) {
      const cfg = getConfig(api);
      const hippoCwd = resolveHippoCwdFromContext(api, ctx, cfg.root);
      let args = `remember "${params.text.replace(/"/g, '\\"')}"`;
      if (params.error) args += ' --error';
      if (params.pin) args += ' --pin';
      if (params.tag) args += ` --tag ${params.tag}`;
      const result = runHippo(args, hippoCwd);
      if (hippoRememberSucceeded(result)) {
        recordSessionMemory(ctx);
      }
      return { content: [{ type: 'text', text: result || 'Memory stored.' }] };
    },
  }));

  // --- Tool: hippo_outcome ---
  api.registerTool((ctx: HippoRuntimeContext) => ({
    name: 'hippo_outcome',
    description:
      'Report whether recalled memories were useful. Strengthens good memories (+5 days half-life) and weakens bad ones (-3 days). Call after completing work.',
    parameters: {
      type: 'object',
      properties: {
        good: {
          type: 'boolean',
          description: 'true = memories helped, false = memories were irrelevant',
        },
      },
      required: ['good'],
    },
    async execute(_id: string, params: { good: boolean }) {
      const cfg = getConfig(api);
      const hippoCwd = resolveHippoCwdFromContext(api, ctx, cfg.root);
      const flag = params.good ? '--good' : '--bad';
      const result = runHippo(`outcome ${flag}`, hippoCwd);
      return { content: [{ type: 'text', text: result || 'Outcome recorded.' }] };
    },
  }));

  // --- Tool: hippo_status ---
  api.registerTool(
    (ctx: HippoRuntimeContext) => ({
      name: 'hippo_status',
      description:
        'Check memory health: counts, strengths, at-risk memories, last consolidation time.',
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute() {
        const cfg = getConfig(api);
        const hippoCwd = resolveHippoCwdFromContext(api, ctx, cfg.root);
        const result = runHippo('status', hippoCwd);
        return { content: [{ type: 'text', text: result || 'No hippo store found.' }] };
      },
    }),
    { optional: true },
  );

  // --- Tool: hippo_context ---
  api.registerTool(
    (ctx: HippoRuntimeContext) => ({
      name: 'hippo_context',
      description:
        'Smart context injection: auto-detects current task from git state and returns relevant memories. Use at the start of any session.',
      parameters: {
        type: 'object',
        properties: {
          budget: {
            type: 'number',
            description: 'Max tokens (default: 1500)',
          },
        },
      },
      async execute(_id: string, params: { budget?: number }) {
        const cfg = getConfig(api);
        const budget = params.budget ?? cfg.budget ?? 1500;
        const framing = cfg.framing ?? 'observe';
        const hippoCwd = resolveHippoCwdFromContext(api, ctx, cfg.root);
        const result = runHippo(
          `context --auto --budget ${budget} --framing ${framing}`,
          hippoCwd,
        );
        return { content: [{ type: 'text', text: result || 'No context available.' }] };
      },
    }),
    { optional: true },
  );

  // --- Tool: hippo_conflicts ---
  api.registerTool(
    (ctx: HippoRuntimeContext) => ({
      name: 'hippo_conflicts',
      description:
        'List open memory conflicts — contradictory memories that need resolution.',
      parameters: {
        type: 'object',
        properties: {
          json: {
            type: 'boolean',
            description: 'Output as JSON (default: false)',
          },
        },
      },
      async execute(_id: string, params: { json?: boolean }) {
        const cfg = getConfig(api);
        const hippoCwd = resolveHippoCwdFromContext(api, ctx, cfg.root);
        const args = params.json ? 'conflicts --json' : 'conflicts';
        const result = runHippo(args, hippoCwd);
        return { content: [{ type: 'text', text: result || 'No conflicts found.' }] };
      },
    }),
    { optional: true },
  );

  // --- Tool: hippo_resolve ---
  api.registerTool(
    (ctx: HippoRuntimeContext) => ({
      name: 'hippo_resolve',
      description:
        'Resolve a memory conflict by keeping one memory and weakening or deleting the other.',
      parameters: {
        type: 'object',
        properties: {
          conflict_id: {
            type: 'number',
            description: 'The conflict ID to resolve',
          },
          keep: {
            type: 'string',
            description: 'ID of the memory to keep',
          },
          forget: {
            type: 'boolean',
            description: 'Delete the losing memory instead of weakening it (default: false)',
          },
        },
        required: ['conflict_id', 'keep'],
      },
      async execute(
        _id: string,
        params: { conflict_id: number; keep: string; forget?: boolean },
      ) {
        const cfg = getConfig(api);
        const hippoCwd = resolveHippoCwdFromContext(api, ctx, cfg.root);
        let args = `resolve ${params.conflict_id} --keep ${params.keep}`;
        if (params.forget) args += ' --forget';
        const result = runHippo(args, hippoCwd);
        return { content: [{ type: 'text', text: result || 'Conflict resolved.' }] };
      },
    }),
    { optional: true },
  );

  // --- Tool: hippo_share ---
  api.registerTool(
    (ctx: HippoRuntimeContext) => ({
      name: 'hippo_share',
      description:
        'Share a memory to the global store for cross-project use. Memories with universal lessons (errors, platform gotchas) transfer well; project-specific ones are filtered.',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Memory ID to share (or "auto" to auto-share all high-scoring memories)',
          },
          force: {
            type: 'boolean',
            description: 'Share even if transfer score is low (default: false)',
          },
        },
        required: ['id'],
      },
      async execute(
        _id: string,
        params: { id: string; force?: boolean },
      ) {
        const cfg = getConfig(api);
        const hippoCwd = resolveHippoCwdFromContext(api, ctx, cfg.root);
        let args: string;
        if (params.id === 'auto') {
          args = 'share --auto';
        } else {
          args = `share ${params.id}`;
          if (params.force) args += ' --force';
        }
        const result = runHippo(args, hippoCwd);
        return { content: [{ type: 'text', text: result || 'Share complete.' }] };
      },
    }),
    { optional: true },
  );

  // --- Tool: hippo_peers ---
  api.registerTool(
    (ctx: HippoRuntimeContext) => ({
      name: 'hippo_peers',
      description:
        'List all projects that have contributed memories to the global shared store.',
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute() {
        const cfg = getConfig(api);
        const hippoCwd = resolveHippoCwdFromContext(api, ctx, cfg.root);
        const result = runHippo('peers', hippoCwd);
        return { content: [{ type: 'text', text: result || 'No peers found.' }] };
      },
    }),
    { optional: true },
  );

  // --- Tool: hippo_wm_push ---
  api.registerTool(
    (ctx: HippoRuntimeContext) => ({
      name: 'hippo_wm_push',
      description:
        'Push a note into working memory — a bounded buffer for current-state context. Entries are scoped, importance-ranked, and auto-evicted when the buffer is full (max 20 per scope).',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Working memory note',
          },
          scope: {
            type: 'string',
            description: 'Scope (default: repo)',
          },
          importance: {
            type: 'number',
            description: 'Priority 0-1 (default: 0.5)',
          },
        },
        required: ['content'],
      },
      async execute(
        _id: string,
        params: { content: string; scope?: string; importance?: number },
      ) {
        const cfg = getConfig(api);
        const hippoCwd = resolveHippoCwdFromContext(api, ctx, cfg.root);
        const scope = params.scope ?? 'repo';
        const importance = params.importance ?? 0.5;
        const escapedContent = params.content.replace(/"/g, '\\"');
        const result = runHippo(
          `wm push --scope ${scope} --content "${escapedContent}" --importance ${importance}`,
          hippoCwd,
        );
        return { content: [{ type: 'text', text: result || 'Working memory entry pushed.' }] };
      },
    }),
    { optional: true },
  );

  // --- Hook: auto-inject context at session start ---
  api.on(
    'before_prompt_build',
    (_event: any, ctx: HippoRuntimeContext) => {
      const cfg = getConfig(api);
      if (cfg.autoContext === false) return {};

      // Dedup guard: skip if this session already got context injected
      const sessionKey = getSessionIdentity(ctx);
      if (sessionKey && injectedSessions.has(sessionKey)) {
        logger.debug?.(`[hippo] skipping duplicate context injection for session ${sessionKey}`);
        return {};
      }

      const budget = cfg.budget ?? 1500;
      const framing = cfg.framing ?? 'observe';
      const hippoCwd = resolveHippoCwdFromContext(api, ctx, cfg.root);

      try {
        const context = runHippo(
          `context --auto --budget ${budget} --framing ${framing}`,
          hippoCwd,
        );
        if (context && context.length > 10 && !context.includes('No hippo store')) {
          if (sessionKey) injectedSessions.add(sessionKey);
          return {
            appendSystemContext: `\n\n## Project Memory (Hippo)\n${context}`,
          };
        }
      } catch (err) {
        logger.debug?.('[hippo] context injection skipped:', err);
      }
      return {};
    },
    { priority: 5 },
  );

  api.on(
    'after_tool_call',
    (event: { toolName: string; error?: string }, ctx: HippoRuntimeContext) => {
      const cfg = getConfig(api);
      if (cfg.autoLearn === false) return;
      if (!event.error?.trim()) return;
      if (event.toolName.startsWith('hippo_')) return;

      const hippoCwd = resolveHippoCwdFromContext(api, ctx, cfg.root);
      const toolTag = sanitizeTag(event.toolName);
      let args =
        `remember "${formatToolErrorMemory(event.toolName, event.error).replace(/"/g, '\\"')}"` +
        ' --error --observed --tag openclaw';
      if (toolTag) args += ` --tag ${toolTag}`;

      const result = runHippo(args, hippoCwd);
      if (hippoRememberSucceeded(result)) {
        recordSessionMemory(ctx);
      } else {
        logger.debug?.(`[hippo] autoLearn skipped storing tool error: ${result}`);
      }
    },
  );

  api.on(
    'session_end',
    (_event: { sessionId: string; messageCount: number }, ctx: HippoRuntimeContext) => {
      // Clear dedup guard so a new session can inject fresh context
      const sessionKey = getSessionIdentity(ctx);
      if (sessionKey) injectedSessions.delete(sessionKey);

      const cfg = getConfig(api);
      const newMemories = consumeSessionMemoryCount(ctx);
      if (!cfg.autoSleep || newMemories < AUTO_SLEEP_SESSION_THRESHOLD) return;

      const hippoCwd = resolveHippoCwdFromContext(api, ctx, cfg.root);
      const result = runHippo('sleep', hippoCwd);
      logger.info?.(
        `[hippo] autoSleep ran for session ${ctx.sessionId ?? ctx.sessionKey ?? 'unknown'} ` +
          `after ${newMemories} new memories`,
      );
      logger.debug?.(`[hippo] autoSleep result: ${result}`);
    },
  );

  logger.info?.('[hippo] Memory plugin registered (tools: hippo_recall, hippo_remember, hippo_outcome, hippo_status, hippo_context, hippo_conflicts, hippo_resolve, hippo_share, hippo_peers, hippo_wm_push)');
}
