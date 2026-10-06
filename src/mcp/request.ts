// Transport-agnostic request handling: tool dispatch table, tool execution and the JSON-RPC method switch.

import { log } from '../log.js';
import { STORE_NOT_PORTED_MESSAGE } from '../http-util.js';
import { getGlobalRoot, initGlobal } from '../shared.js';
import { loadConfig } from '../config.js';
import { resolveTenantId } from '../tenant.js';
import { rethrowIfSqliteBlocked } from '../db.js';
import { storeFor } from '../store-port.js';
import { estimateTokens, type TokenSurface } from '../token-ledger.js';
import { PACKAGE_VERSION } from '../version.js';
import { validateToolArgs } from './tool-args.js';
import { findHippoRoot, isJsonObjectRecord, type McpContext, type McpRequest, type McpResponse, type ToolHandler } from './protocol.js';
import { TOOLS, TOOLS_BY_NAME, ARGS_CHECKED_BY_API } from './tools.js';
import { runRecallTool, runAssembleTool, runDrillTool, runContextTool } from './recall-tools.js';
import { runRememberTool, runOutcomeTool, runLearnTool } from './memory-tools.js';
import { runPredictBaserateTool, runStatusTool, runConflictsTool, runResolveTool, runShareTool, runPeersTool } from './admin-tools.js';
import { type JsonValue, isJsonString } from '../json.js';

/**
 * Zero-install first run (`npx -y hippo-memory mcp` with no store anywhere):
 * create the global store instead of failing every tool call, and say so on
 * stderr (stdout carries the protocol). `hippo init` in a project later adds
 * a project store, which then takes precedence.
 */
function createGlobalStoreOnFirstRun(): string {
  initGlobal();
  const root = getGlobalRoot();
  log.warn(`no memory store found; created the global store at ${root}. Run \`hippo init\` in a project for a project store.`);
  return root;
}

// ── Token ledger ──

const MCP_TOKEN_SURFACES = new Map<string, TokenSurface>([
  ['hippo_recall', 'mcp_recall'],
  ['hippo_context', 'mcp_context'],
]);

/**
 * Record the memory text a recall or context tool returned. Best-effort: a
 * ledger failure never fails the tool call. Other tools are not recorded.
 */
export async function recordMcpTokens(toolName: string, output: string, ctx?: McpContext): Promise<void> {
  const surface = MCP_TOKEN_SURFACES.get(toolName);
  if (!surface || !output) return;
  try {
    const hippoRoot = ctx?.hippoRoot ?? findHippoRoot();
    if (!hippoRoot) return;
    await storeFor({ hippoRoot, store: ctx?.store }).recordTokens({
      tenantId: ctx?.tenantId ?? resolveTenantId({}),
      surface,
      event: 'inject',
      items: 0,
      tokens: estimateTokens(output),
    });
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.warnThenDebug('mcp-token-ledger', `token ledger write failed; the tool reply is unaffected: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Tool execution ──

interface ToolEntry {
  readonly handler: ToolHandler;
  /** Reaches its store only through the port, so it runs under a store other than hippo.db. */
  readonly storeReady?: true;
}

const TOOL_HANDLERS: ReadonlyMap<string, ToolEntry> = new Map<string, ToolEntry>([
  ['hippo_recall', { handler: runRecallTool, storeReady: true }],
  ['hippo_assemble', { handler: runAssembleTool }],
  ['hippo_drill', { handler: runDrillTool }],
  ['hippo_predict_baserate', { handler: runPredictBaserateTool }],
  ['hippo_remember', { handler: runRememberTool }],
  ['hippo_outcome', { handler: runOutcomeTool }],
  ['hippo_context', { handler: runContextTool }],
  ['hippo_status', { handler: runStatusTool }],
  ['hippo_learn', { handler: runLearnTool }],
  ['hippo_conflicts', { handler: runConflictsTool }],
  ['hippo_resolve', { handler: runResolveTool }],
  ['hippo_share', { handler: runShareTool }],
  ['hippo_peers', { handler: runPeersTool }],
]);

/** The tools listed and run under a store other than hippo.db. */
export const STORE_READY_TOOLS: ReadonlySet<string> = new Set(
  [...TOOL_HANDLERS].filter(([, entry]) => entry.storeReady).map(([name]) => name),
);

/** The served store's kind when it is not hippo.db, else null. */
function otherStoreKind(ctx?: McpContext): string | null {
  const kind = ctx?.store?.kind;
  return kind !== undefined && kind !== 'sqlite' ? kind : null;
}

async function executeTool(
  name: string,
  args: Record<string, JsonValue>,
  ctx?: McpContext,
): Promise<string> {
  // When a transport hands us a context (HTTP path), trust it: the HTTP
  // server already resolved hippoRoot from its bound opts and tenantId
  // from the Bearer token (or the loopback fallback). The stdio path
  // continues to walk from cwd / fall back to the global root, and to
  // resolve tenant from HIPPO_TENANT.
  const hippoRoot = ctx?.hippoRoot ?? findHippoRoot() ?? createGlobalStoreOnFirstRun();

  const config = loadConfig(hippoRoot);
  // Every store read in this server returns to the caller and is
  // tenant-isolated. Resolved once per tool call: prefer the transport's
  // ctx.tenantId so an HTTP Bearer for tenant B doesn't drop to HIPPO_TENANT.
  const tenantId = ctx?.tenantId ?? resolveTenantId({});

  const handler = TOOL_HANDLERS.get(name)?.handler;
  // handleMcpRequest rejects names missing from TOOLS, so reaching here means TOOLS and this table drifted apart.
  if (!handler) throw new Error(`hippo-mcp: tool ${name} is declared but has no handler`);
  return handler({ args, ctx, hippoRoot, config, tenantId });
}

// ── Request handling ──

/**
 * Transport-agnostic MCP dispatcher. Both the stdio loop (below) and the
 * HTTP/SSE transport in src/server.ts route every incoming JSON-RPC message
 * through this single function. Returns null for notifications (no response
 * expected) and a McpResponse otherwise. Errors thrown by `executeTool` are
 * the caller's problem — wrap with try/catch on the transport side.
 */
export async function handleMcpRequest(
  req: McpRequest,
  ctx?: McpContext,
): Promise<McpResponse | null> {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'hippo-memory', version: PACKAGE_VERSION },
        },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: otherStoreKind(ctx) ? TOOLS.filter((t) => STORE_READY_TOOLS.has(t.name)) : TOOLS } };

    case 'tools/call': {
      const nameValue = params?.name;
      const toolName = isJsonString(nameValue) ? nameValue : '';
      const tool = TOOLS_BY_NAME.get(toolName);
      if (!tool) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${toolName.slice(0, 128)}` } };
      }
      // The same refusal a ported tool gives when it reaches hippo.db, so a client handles one shape.
      if (otherStoreKind(ctx) && !STORE_READY_TOOLS.has(toolName)) {
        return { jsonrpc: '2.0', id, error: { code: -32603, message: STORE_NOT_PORTED_MESSAGE } };
      }
      const argumentsValue = params?.arguments;
      if (argumentsValue !== undefined && argumentsValue !== null && !isJsonObjectRecord(argumentsValue)) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `${toolName}: arguments must be an object` } };
      }
      const toolArgs = isJsonObjectRecord(argumentsValue) ? argumentsValue : {};
      // The MCP spec reports input validation as a tool result with isError, so the model can read it and retry.
      const problems = validateToolArgs(tool.inputSchema, toolArgs, ARGS_CHECKED_BY_API.get(toolName));
      if (problems.length > 0) {
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Invalid arguments for ${toolName}: ${problems.join('; ')}` }], isError: true },
        };
      }
      const output = await executeTool(toolName, toolArgs, ctx);
      await recordMcpTokens(toolName, output, ctx);
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
