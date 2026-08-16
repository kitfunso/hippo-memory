/**
 * Hippo Memory - Pi Coding Agent Extension
 *
 * Auto-injects memory context at session start, captures tool errors,
 * and runs consolidation on shutdown. Registers hippo tools for the LLM.
 *
 * Install: copy to ~/.pi/agent/extensions/hippo-memory/
 * Or add to .pi/extensions/ in your project.
 *
 * Requires: hippo-memory CLI installed globally (npm install -g hippo-memory)
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface HippoConfig {
  budget: number;
  contextBudget: number;
  framing: 'observe' | 'suggest' | 'assert';
  autoContext: boolean;
  autoLearn: boolean;
  autoSleep: boolean;
  maxErrorsPerSession: number;
}

const DEFAULT_CONFIG: HippoConfig = {
  budget: 4000,
  contextBudget: 1500,
  framing: 'observe',
  autoContext: true,
  autoLearn: true,
  autoSleep: true,
  maxErrorsPerSession: 5,
};

// ---------------------------------------------------------------------------
// Noise filtering (matches openclaw-plugin patterns)
// ---------------------------------------------------------------------------

const NOISE_ERROR_PATTERNS: RegExp[] = [
  /Local media path is not under an allowed directory/i,
  /timed out\.?\s*Restart/i,
  /EISDIR:\s*illegal operation on a directory/i,
  /Missing required parameter:\s*path/i,
  /ENOENT:\s*no such file or directory/i,
  /EACCES:\s*permission denied/i,
  /EPERM:\s*operation not permitted/i,
  /socket hang up/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ERR_SOCKET_CONNECTION_TIMEOUT/i,
  /net::ERR_/i,
  /Navigation timeout/i,
];

function isNoiseError(error: string): boolean {
  return NOISE_ERROR_PATTERNS.some((p) => p.test(error));
}

/** True for a string value, without assuming the input's shape — used on
 * fields read off the untyped Pi extension event/plugin surface. */
function isString<T>(value: T): value is T & string {
  return typeof value === 'string';
}

function hashError(toolName: string, error: string): string {
  return `${toolName}::${error.replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

let sessionErrorCount = 0;
const sessionErrorHashes = new Set<string>();
let sessionMemoryCount = 0;

// ---------------------------------------------------------------------------
// Hippo CLI wrapper (no shell, args as array)
// ---------------------------------------------------------------------------

function runHippo(args: readonly string[], cwd?: string): string {
  try {
    const result = execFileSync('hippo', args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // `encoding: 'utf8'` above selects the ExecFileSyncOptionsWithStringEncoding
    // overload, so `result` is always a `string` here — no runtime check needed.
    return result.trim();
  } catch (err: any) {
    return err.stdout?.trim() || err.message || 'hippo command failed';
  }
}

function hippoAvailable(): boolean {
  try {
    execFileSync('hippo', ['status'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function hippoInitialized(cwd: string): boolean {
  return existsSync(join(cwd, '.hippo'));
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: any) {
  // Check hippo is available
  if (!hippoAvailable()) {
    console.error('[hippo] hippo-memory CLI not found. Install: npm install -g hippo-memory');
    return;
  }

  const config = { ...DEFAULT_CONFIG };

  // -------------------------------------------------------------------------
  // Session start: inject memory context
  // -------------------------------------------------------------------------

  pi.on('session_start', async (_event: any, ctx: any) => {
    sessionErrorCount = 0;
    sessionErrorHashes.clear();
    sessionMemoryCount = 0;

    if (!config.autoContext) return;

    const cwd = ctx.cwd || process.cwd();
    if (!hippoInitialized(cwd)) return;

    const context = runHippo(
      ['context', '--auto', '--budget', String(config.contextBudget), '--framing', config.framing],
      cwd,
    );

    if (context && context.length > 10 && !context.includes('No hippo store')) {
      return {
        systemPromptAppend: `\n\n## Project Memory (Hippo)\n\n${context}\n\nWhen you learn something important, tell the user to run: hippo remember "<lesson>"\nWhen you encounter errors, suggest: hippo remember "<error description>" --error`,
      };
    }
  });

  // -------------------------------------------------------------------------
  // Tool errors: auto-capture (with noise filtering + rate limiting + dedup)
  // -------------------------------------------------------------------------

  if (config.autoLearn) {
    pi.on('tool_result', async (event: any, ctx: any) => {
      if (!event.isError) return;

      const error = isString(event.content)
        ? event.content
        : Array.isArray(event.content)
          ? event.content.map((c: any) => c.text || '').join(' ')
          : '';

      if (!error || error.length < 10) return;

      // Filter 1: noise
      if (isNoiseError(error)) return;

      // Filter 2: rate limit
      if (sessionErrorCount >= config.maxErrorsPerSession) return;

      // Filter 3: dedup
      const hash = hashError(event.toolName || 'unknown', error);
      if (sessionErrorHashes.has(hash)) return;

      const cwd = ctx.cwd || process.cwd();
      if (!hippoInitialized(cwd)) return;

      const toolTag = (event.toolName || 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 30);

      const truncated = error.replace(/\s+/g, ' ').trim().slice(0, 500);
      const text = `Tool '${event.toolName || 'unknown'}' failed: ${truncated}`;

      const args: string[] = ['remember', text, '--error', '--observed', '--tag', 'pi-agent'];
      if (toolTag) args.push('--tag', toolTag);

      const result = runHippo(args, cwd);
      if (result.includes('Remembered [')) {
        sessionErrorHashes.add(hash);
        sessionErrorCount++;
        sessionMemoryCount++;
      }
    });
  }

  // -------------------------------------------------------------------------
  // Session shutdown: run consolidation
  // -------------------------------------------------------------------------

  pi.on('session_shutdown', async (_event: any, ctx: any) => {
    if (!config.autoSleep) return;

    const cwd = ctx.cwd || process.cwd();
    if (!hippoInitialized(cwd)) return;

    // Only sleep if we captured some memories this session
    if (sessionMemoryCount < 1) {
      // Still run sleep for the auto-learn-from-git + auto-share features
      try { runHippo(['sleep'], cwd); } catch { /* best effort */ }
      return;
    }

    try {
      runHippo(['sleep'], cwd);
    } catch {
      // Best effort — don't block shutdown
    }
  });

  // -------------------------------------------------------------------------
  // Tools: hippo_recall
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: 'hippo_recall',
    description: 'Search project memory for relevant context. Returns memories ranked by relevance and strength.',
    promptSnippet: 'hippo_recall: Search project memory by topic',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for (natural language)' },
        budget: { type: 'number', description: 'Max tokens to return (default: 4000)' },
      },
      required: ['query'],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd || process.cwd();
      const budget = params.budget || config.budget;
      const result = runHippo(
        ['recall', params.query, '--budget', String(budget), '--framing', config.framing],
        cwd,
      );
      return { content: [{ type: 'text', text: result || 'No relevant memories found.' }] };
    },
  });

  // -------------------------------------------------------------------------
  // Tools: hippo_remember
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: 'hippo_remember',
    description: 'Store a lesson, insight, or error in project memory. Memories decay over time unless retrieved.',
    promptSnippet: 'hippo_remember: Store a memory (lessons, errors, decisions)',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory content' },
        error: { type: 'boolean', description: 'Tag as error (doubles retention)' },
        tag: { type: 'string', description: 'Optional tag for categorization' },
        pin: { type: 'boolean', description: 'Pin memory (never decays)' },
      },
      required: ['text'],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd || process.cwd();
      const args: string[] = ['remember', params.text];
      if (params.error) args.push('--error');
      if (params.pin) args.push('--pin');
      if (params.tag) {
        const safe = params.tag.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
        if (safe) args.push('--tag', safe);
      }
      const result = runHippo(args, cwd);
      if (result.includes('Remembered [')) sessionMemoryCount++;
      return { content: [{ type: 'text', text: result || 'Memory stored.' }] };
    },
  });

  // -------------------------------------------------------------------------
  // Tools: hippo_outcome
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: 'hippo_outcome',
    description: 'Report whether recalled memories were helpful. Strengthens or weakens them.',
    promptSnippet: 'hippo_outcome: Rate recalled memories as good or bad',
    parameters: {
      type: 'object',
      properties: {
        good: { type: 'boolean', description: 'true = helpful, false = not helpful' },
      },
      required: ['good'],
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd || process.cwd();
      const flag = params.good ? '--good' : '--bad';
      const result = runHippo(['outcome', flag], cwd);
      return { content: [{ type: 'text', text: result || 'Outcome recorded.' }] };
    },
  });

  // -------------------------------------------------------------------------
  // Tools: hippo_status
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: 'hippo_status',
    description: 'Show memory health: counts, strength distribution, conflicts.',
    promptSnippet: 'hippo_status: Check memory store health',
    parameters: { type: 'object', properties: {} },
    async execute(_toolCallId: string, _params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd || process.cwd();
      const result = runHippo(['status'], cwd);
      return { content: [{ type: 'text', text: result || 'No hippo store found.' }] };
    },
  });

  // -------------------------------------------------------------------------
  // Tools: hippo_context
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: 'hippo_context',
    description: 'Get smart memory context based on current git state and task.',
    promptSnippet: 'hippo_context: Smart context injection from git state',
    parameters: {
      type: 'object',
      properties: {
        budget: { type: 'number', description: 'Token budget (default: 1500)' },
      },
    },
    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd = ctx.cwd || process.cwd();
      const budget = params.budget || config.contextBudget;
      const result = runHippo(
        ['context', '--auto', '--budget', String(budget), '--framing', config.framing],
        cwd,
      );
      return { content: [{ type: 'text', text: result || 'No context available.' }] };
    },
  });
}
