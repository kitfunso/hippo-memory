// Transport-agnostic request handling: tool dispatch table, tool execution and the JSON-RPC method switch.

import { currentSignal } from '../util/request-scope.js';
import { STORE_NOT_PORTED_MESSAGE } from '../util/http-util.js';
import { loadConfig } from '../core/config.js';
import { hasGroup, narrowStore, type HippoStore, type StoreGroup } from '../store/index.js';
import { type TokenSurface } from '../store/token-ledger.js';
import { estimateTokens } from '../util/token-text.js';
import { PACKAGE_VERSION } from '../util/version.js';
import { validateToolArgs } from './tool-args.js';
import { RecallRequestError } from '../api/recall/request.js';
import { recordTokens } from '../api/tokens.js';
import {
  mcpActor,
  type McpContext,
  type McpRequest,
  type McpResponse,
  type ToolCall,
  type ToolHandler,
} from './protocol.js';
import { TOOLS, TOOLS_BY_NAME, ARGS_CHECKED_BY_API } from './tools.js';
import { runRecallTool, runAssembleTool, runDrillTool, runContextTool } from './recall-tools.js';
import { runRememberTool, runOutcomeTool, runLearnTool } from './memory-tools.js';
import {
  runPredictBaserateTool,
  runStatusTool,
  runConflictsTool,
  runResolveTool,
  runShareTool,
  runPeersTool,
} from './admin-tools.js';
import { sharedStoreRefusal } from './shared-gate.js';
import { type JsonValue, isJsonString, isJsonObject } from '../util/json.js';

// ── Token ledger ──

const MCP_TOKEN_SURFACES = new Map<string, TokenSurface>([
  ['hippo_recall', 'mcp_recall'],
  ['hippo_context', 'mcp_context'],
]);

/** Records the memory text a recall or context tool returned; best-effort (a ledger failure never fails the call),
 * other tools are not recorded. */
export async function recordMcpTokens(toolName: string, output: string, ctx: McpContext): Promise<void> {
  const surface = MCP_TOKEN_SURFACES.get(toolName);
  if (!surface || !output) return;
  const apiCtx = { hippoRoot: ctx.hippoRoot, tenantId: ctx.tenantId, actor: mcpActor(ctx), store: ctx.store };
  await recordTokens(apiCtx, surface, { items: 0, tokens: estimateTokens(output) });
}

// ── Tool execution ──

interface ToolEntry {
  readonly run: ToolHandler;
  /** The store group it reaches its store through, so it runs under
   * any store that has it; unset means hippo.db's local files. */
  readonly storeReady?: StoreGroup;
}

/** A tool that reaches its store through `group`: the call it gets carries the store narrowed to it. */
function toolOn<G extends StoreGroup>(group: G, handler: ToolHandler<G>): ToolEntry {
  return {
    storeReady: group,
    run: (call: ToolCall) => handler({ ...call, store: narrowStore(call.store, group) }),
  };
}

const TOOL_HANDLERS: ReadonlyMap<string, ToolEntry> = new Map<string, ToolEntry>([
  ['hippo_recall', toolOn('base', runRecallTool)],
  ['hippo_assemble', toolOn('dagReads', runAssembleTool)],
  ['hippo_drill', toolOn('dagReads', runDrillTool)],
  ['hippo_predict_baserate', toolOn('predictions', runPredictBaserateTool)],
  ['hippo_remember', toolOn('entryWrites', runRememberTool)],
  ['hippo_outcome', toolOn('entryWrites', runOutcomeTool)],
  ['hippo_context', toolOn('contextReads', runContextTool)],
  ['hippo_status', toolOn('reports', runStatusTool)],
  ['hippo_learn', toolOn('lessonWrites', runLearnTool)],
  ['hippo_conflicts', toolOn('conflicts', runConflictsTool)],
  ['hippo_resolve', toolOn('conflicts', runResolveTool)],
  ['hippo_share', { run: runShareTool }],
  ['hippo_peers', { run: runPeersTool }],
]);

/** A call with no context yet (tools/list on stdio) lists every tool. */
function runsOn(store: HippoStore | undefined, toolName: string): boolean {
  return store === undefined || hasGroup(store, TOOL_HANDLERS.get(toolName)?.storeReady ?? 'localFiles');
}

async function executeTool(name: string, args: Record<string, JsonValue>, ctx: McpContext): Promise<string> {
  // The transport's context is trusted: its hippoRoot, store and tenantId were bound by the host (the HTTP server's
  // Bearer, or the stdio host's folder walk and HIPPO_TENANT).
  const { hippoRoot, tenantId } = ctx;
  const config = loadConfig(hippoRoot);

  const run = TOOL_HANDLERS.get(name)?.run;
  // handleMcpRequest rejects names missing from TOOLS, so reaching here means TOOLS and this table drifted apart.
  if (!run) throw new Error(`hippo-mcp: tool ${name} is declared but has no handler`);
  return run({ args, ctx, hippoRoot, store: ctx.store, config, tenantId });
}

// ── Request handling ──

// The MCP spec reports input validation as a tool result with isError, so the model can read it and retry.
function invalidArgs(id: McpResponse['id'], toolName: string, problems: readonly string[]): McpResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: `Invalid arguments for ${toolName}: ${problems.join('; ')}` }],
      isError: true,
    },
  };
}

/** The tool and its ledger row run in the caller's request scope, which the host (server or stdio) opens.
 * SHORTCUT: the deadline stops a call only between these steps, not a running store read or fetch; thread the signal */
async function runTool(toolName: string, args: Record<string, JsonValue>, ctx: McpContext): Promise<string> {
  currentSignal()?.throwIfAborted();
  const text = await executeTool(toolName, args, ctx);
  currentSignal()?.throwIfAborted();
  await recordMcpTokens(toolName, text, ctx);
  return text;
}

async function callTool(
  id: McpRequest['id'],
  params: McpRequest['params'],
  ctx: McpContext,
): Promise<McpResponse> {
  const nameValue = params?.name;
  const toolName = isJsonString(nameValue) ? nameValue : '';
  const tool = TOOLS_BY_NAME.get(toolName);
  if (!tool) {
    return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${toolName.slice(0, 128)}` } };
  }
  // The same refusal a ported tool gives when it reaches hippo.db, so a client handles one shape.
  if (!runsOn(ctx.store, toolName)) {
    return { jsonrpc: '2.0', id, error: { code: -32603, message: STORE_NOT_PORTED_MESSAGE } };
  }
  const refusal = sharedStoreRefusal(toolName, ctx);
  if (refusal !== undefined) {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: refusal }], isError: true } };
  }
  const argumentsValue = params?.arguments;
  if (argumentsValue !== undefined && argumentsValue !== null && !isJsonObject(argumentsValue)) {
    return { jsonrpc: '2.0', id, error: { code: -32602, message: `${toolName}: arguments must be an object` } };
  }
  const toolArgs = isJsonObject(argumentsValue) ? argumentsValue : {};
  const problems = validateToolArgs(tool.inputSchema, toolArgs, ARGS_CHECKED_BY_API.get(toolName));
  if (problems.length > 0) return invalidArgs(id, toolName, problems);
  let output: string;
  try {
    output = await runTool(toolName, toolArgs, ctx);
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

/** Transport-agnostic MCP dispatcher: the stdio loop and the HTTP/SSE transport route every JSON-RPC message through
 * it. Returns null for notifications. `executeTool` errors are the caller's problem: wrap with try/catch in the
 * transport. Only `tools/call` needs the context, so stdio builds one for that method alone. */
export async function handleMcpRequest(req: McpRequest, ctx: McpContext | undefined): Promise<McpResponse | null> {
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
      return { jsonrpc: '2.0', id, result: { tools: TOOLS.filter((t) => runsOn(ctx?.store, t.name)) } };
    }

    case 'tools/call':
      if (ctx === undefined) throw new Error('hippo-mcp: tools/call needs a context');
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
