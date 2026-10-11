// Transport-agnostic request handling: tool dispatch table, tool execution and the JSON-RPC method switch.

import { errorMessage, log } from '../util/log.js';
import { STORE_NOT_PORTED_MESSAGE } from '../util/http-util.js';
import { getGlobalRoot, initGlobal } from '../sharing/global-store.js';
import { loadConfig } from '../core/config.js';
import { resolveTenantId } from '../store/tenant.js';
import { runWithRequestStores } from '../db/index.js';
import { rethrowIfSqliteBlocked } from '../util/sqlite-blocked.js';
import { hasGroup, storeFor, type HippoStore, type StoreGroup } from '../store/index.js';
import { type TokenSurface } from '../store/token-ledger.js';
import { estimateTokens } from '../util/token-text.js';
import { PACKAGE_VERSION } from '../util/version.js';
import { validateToolArgs } from './tool-args.js';
import { RecallRequestError } from '../api/recall-request.js';
import { findHippoRoot, type McpContext, type McpRequest, type McpResponse, type ToolHandler } from './protocol.js';
import { TOOLS, TOOLS_BY_NAME, ARGS_CHECKED_BY_API } from './tools.js';
import { runRecallTool, runAssembleTool, runDrillTool, runContextTool } from './recall-tools.js';
import { runRememberTool, runOutcomeTool, runLearnTool } from './memory-tools.js';
import { runPredictBaserateTool, runStatusTool, runConflictsTool, runResolveTool, runShareTool, runPeersTool } from './admin-tools.js';
import { sharedStoreRefusal } from './shared-gate.js';
import { type JsonValue, isJsonString, isJsonObject } from '../util/json.js';

/** Zero-install first run (`npx -y hippo-memory mcp`, no store anywhere): create the global store instead of failing every tool call, and say so on stderr
 * (stdout carries the protocol). A later `hippo init` project store takes precedence. */
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

/** Records the memory text a recall or context tool returned; best-effort (a ledger failure never fails the call), other tools are not recorded. */
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
    log.warnThenDebug('mcp-token-ledger', `token ledger write failed; the tool reply is unaffected: ${errorMessage(err)}`);
  }
}

// ── Tool execution ──

interface ToolEntry {
  readonly handler: ToolHandler;
  /** The store group it reaches its store through, so it runs under another store that has it; unset means hippo.db only. */
  readonly storeReady?: StoreGroup;
}

const TOOL_HANDLERS: ReadonlyMap<string, ToolEntry> = new Map<string, ToolEntry>([
  ['hippo_recall', { handler: runRecallTool, storeReady: 'base' }],
  ['hippo_assemble', { handler: runAssembleTool, storeReady: 'dagReads' }],
  ['hippo_drill', { handler: runDrillTool, storeReady: 'dagReads' }],
  ['hippo_predict_baserate', { handler: runPredictBaserateTool, storeReady: 'predictions' }],
  ['hippo_remember', { handler: runRememberTool, storeReady: 'entryWrites' }],
  ['hippo_outcome', { handler: runOutcomeTool, storeReady: 'entryWrites' }],
  ['hippo_context', { handler: runContextTool, storeReady: 'contextReads' }],
  ['hippo_status', { handler: runStatusTool }],
  ['hippo_learn', { handler: runLearnTool }],
  ['hippo_conflicts', { handler: runConflictsTool }],
  ['hippo_resolve', { handler: runResolveTool }],
  ['hippo_share', { handler: runShareTool }],
  ['hippo_peers', { handler: runPeersTool }],
]);

/** The served store when it is not hippo.db, else null. */
function otherStore(ctx?: McpContext): HippoStore | null {
  const store = ctx?.store;
  return store !== undefined && store.kind !== 'sqlite' ? store : null;
}

function runsOn(store: HippoStore, toolName: string): boolean {
  const group = TOOL_HANDLERS.get(toolName)?.storeReady;
  return group !== undefined && hasGroup(store, group);
}

async function executeTool(
  name: string,
  args: Record<string, JsonValue>,
  ctx?: McpContext,
): Promise<string> {
  // With a transport context (HTTP), trust it: hippoRoot comes from the server's bound opts and tenantId from the Bearer (or loopback fallback).
  // Stdio walks from cwd / the global root and resolves tenant from HIPPO_TENANT.
  const hippoRoot = ctx?.hippoRoot ?? findHippoRoot() ?? createGlobalStoreOnFirstRun();

  const config = loadConfig(hippoRoot);
  // Every store read here is tenant-isolated, resolved once per tool call; prefer the transport's ctx.tenantId so an HTTP Bearer for tenant B
  // does not drop to HIPPO_TENANT.
  const tenantId = ctx?.tenantId ?? resolveTenantId({});

  const handler = TOOL_HANDLERS.get(name)?.handler;
  // handleMcpRequest rejects names missing from TOOLS, so reaching here means TOOLS and this table drifted apart.
  if (!handler) throw new Error(`hippo-mcp: tool ${name} is declared but has no handler`);
  return handler({ args, ctx, hippoRoot, config, tenantId });
}

// ── Request handling ──

// The MCP spec reports input validation as a tool result with isError, so the model can read it and retry.
function invalidArgs(id: McpResponse['id'], toolName: string, problems: readonly string[]): McpResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: `Invalid arguments for ${toolName}: ${problems.join('; ')}` }], isError: true },
  };
}

async function callTool(id: McpRequest['id'], params: McpRequest['params'], ctx?: McpContext): Promise<McpResponse> {
  const nameValue = params?.name;
  const toolName = isJsonString(nameValue) ? nameValue : '';
  const tool = TOOLS_BY_NAME.get(toolName);
  if (!tool) {
    return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${toolName.slice(0, 128)}` } };
  }
  // The same refusal a ported tool gives when it reaches hippo.db, so a client handles one shape.
  const other = otherStore(ctx);
  if (other && !runsOn(other, toolName)) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: STORE_NOT_PORTED_MESSAGE } };
  }
  const refusal = sharedStoreRefusal(toolName, ctx);
  if (refusal !== undefined) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: refusal }], isError: true } };
  const argumentsValue = params?.arguments;
  if (argumentsValue !== undefined && argumentsValue !== null && !isJsonObject(argumentsValue)) {
    return { jsonrpc: '2.0', id, error: { code: -32602, message: `${toolName}: arguments must be an object` } };
  }
  const toolArgs = isJsonObject(argumentsValue) ? argumentsValue : {};
  const problems = validateToolArgs(tool.inputSchema, toolArgs, ARGS_CHECKED_BY_API.get(toolName));
  if (problems.length > 0) return invalidArgs(id, toolName, problems);
  let output: string;
  try {
    // One handle per store for the tool and its ledger row; stdio interleaves calls, so each gets its own scope.
    output = await runWithRequestStores(async () => {
      const text = await executeTool(toolName, toolArgs, ctx);
      await recordMcpTokens(toolName, text, ctx);
      return text;
    });
  } catch (err) {
    if (!(err instanceof RecallRequestError)) throw err;
    return invalidArgs(id, toolName, [err.message]);
  }
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: output || 'Done.' }],
    },
  };
}

/** Transport-agnostic MCP dispatcher: the stdio loop and the HTTP/SSE transport route every JSON-RPC message through it. Returns null for notifications.
 * Errors thrown by `executeTool` are the caller's problem: wrap with try/catch on the transport side. */
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

    case 'tools/list': {
      const other = otherStore(ctx);
      return { jsonrpc: '2.0', id, result: { tools: other ? TOOLS.filter((t) => runsOn(other, t.name)) : TOOLS } };
    }

    case 'tools/call':
      return callTool(id, params, ctx);

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
