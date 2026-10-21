// Transport-agnostic request handling: tool dispatch table, tool execution and the JSON-RPC method switch.

import { currentSignal } from '../../base/util/request-scope.js';
import { STORE_NOT_PORTED_MESSAGE } from '../../base/util/http-util.js';
import type { HippoStore } from '../../store/index.js';
import { hasGroup } from '../../store/index.js';
import type { TokenSurface } from '../../store/port/ledger.js';
import { estimateTokens } from '../../base/util/token-text.js';
import { PACKAGE_VERSION } from '../../base/util/version.js';
import { validateToolArgs } from './tool-args.js';
import { RecallRequestError } from '../../api/recall/request.js';
import { globalTargetOf } from '../../api/infra.js';
import { recordTokens } from '../../api/tokens.js';
import {
  mcpApiContext,
  type LocalToolHandler,
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
import { errorReply, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND, resultReply } from './json-rpc.js';
import { type JsonValue, isJsonString, isJsonObject } from '../../base/util/json.js';

// ── Token ledger ──

const MCP_TOKEN_SURFACES = new Map<string, TokenSurface>([
  ['hippo_recall', 'mcp_recall'],
  ['hippo_context', 'mcp_context'],
]);

/** Records the memory text a recall or context tool returned; best-effort (a ledger failure never fails the call),
 * other tools are not recorded. */
async function recordMcpTokens(toolName: string, output: string, ctx: McpContext): Promise<void> {
  const surface = MCP_TOKEN_SURFACES.get(toolName);
  if (!surface || !output) return;
  await recordTokens(mcpApiContext(ctx), surface, { items: 0, tokens: estimateTokens(output) });
}

// ── Tool execution ──

/** A tool, and the optional group it needs; unset, it runs under any store. */
type ToolEntry =
  | { readonly needs?: undefined; readonly run: ToolHandler }
  | { readonly needs: 'folderFiles'; readonly run: LocalToolHandler };

/** A tool that runs only under a folder store with a global store in its reach. */
function localTool(run: LocalToolHandler): ToolEntry {
  return { needs: 'folderFiles', run };
}

type ToolRun = (args: Record<string, JsonValue>) => string | Promise<string>;

/** A tool bound to one store: its run for a call, or undefined when the call's reach has no global store for it. */
type StoreTool = (ctx: McpContext) => ToolRun | undefined;

const TOOL_HANDLERS: ReadonlyMap<string, ToolEntry> = new Map<string, ToolEntry>([
  ['hippo_recall', { run: runRecallTool }],
  ['hippo_assemble', { run: runAssembleTool }],
  ['hippo_drill', { run: runDrillTool }],
  ['hippo_predict_baserate', { run: runPredictBaserateTool }],
  ['hippo_remember', { run: runRememberTool }],
  ['hippo_outcome', { run: runOutcomeTool }],
  ['hippo_context', { run: runContextTool }],
  ['hippo_status', { run: runStatusTool }],
  ['hippo_learn', { run: runLearnTool }],
  ['hippo_conflicts', { run: runConflictsTool }],
  ['hippo_resolve', { run: runResolveTool }],
  ['hippo_share', localTool(runShareTool)],
  ['hippo_peers', localTool(runPeersTool)],
]);

// A store's groups are fixed for its life, so each tool's need is proven once per store, not on each call.
const toolsByStore = new WeakMap<HippoStore, ReadonlyMap<string, StoreTool>>();

/** The tools `store` serves, bound to it the first time a transport hands it in; a tool it lacks the group for is left
 * out, so a list hides it and a call answers not ported. */
function toolsOn(store: HippoStore): ReadonlyMap<string, StoreTool> {
  const known = toolsByStore.get(store);
  if (known !== undefined) return known;
  const tools = new Map<string, StoreTool>();
  for (const [name, entry] of TOOL_HANDLERS) {
    const bound = boundTool(entry, store);
    if (bound !== undefined) tools.set(name, bound);
  }
  toolsByStore.set(store, tools);
  return tools;
}

function boundTool(entry: ToolEntry, store: HippoStore): StoreTool | undefined {
  if (entry.needs === undefined) {
    const { run } = entry;
    return (ctx) => (args) => run({ ...toolCall(ctx), args });
  }
  if (!hasGroup(store, entry.needs)) return undefined;
  const { run } = entry;
  return (ctx) => {
    const globalTarget = globalTargetOf(ctx);
    return globalTarget === undefined ? undefined : (args) => run({ ...toolCall(ctx), args, store, globalTarget });
  };
}

/** The transport's context is trusted: its hippoRoot, store and tenantId were bound by the host (the HTTP server's
 * Bearer, or the stdio host's folder walk and HIPPO_TENANT). */
function toolCall(ctx: McpContext): Omit<ToolCall, 'args'> {
  const { hippoRoot, tenantId, config, store } = ctx;
  return { ctx, hippoRoot, store, config, tenantId };
}

/** A call with no context yet (tools/list on stdio) lists every tool. */
function runsOn(store: HippoStore | undefined, toolName: string): boolean {
  return store === undefined || toolsOn(store).has(toolName);
}

/** The tool bound to `ctx`, or undefined when its store does not serve it. */
function toolRun(name: string, ctx: McpContext): ToolRun | undefined {
  // handleMcpRequest rejects names missing from TOOLS, so reaching here means TOOLS and this table drifted apart.
  if (!TOOL_HANDLERS.has(name)) throw new Error(`hippo-mcp: tool ${name} is declared but has no handler`);
  return toolsOn(ctx.store).get(name)?.(ctx);
}

// ── Request handling ──

// The MCP spec reports input validation as a tool result with isError, so the model can read it and retry.
function invalidArgs(id: McpResponse['id'], toolName: string, problems: readonly string[]): McpResponse {
  return resultReply(id, {
    content: [{ type: 'text', text: `Invalid arguments for ${toolName}: ${problems.join('; ')}` }],
    isError: true,
  });
}

/** The tool and its ledger row run in the caller's request scope, which the host (server or stdio) opens.
 * SHORTCUT: the deadline stops a call only between these steps, not a running store read or fetch; thread the signal */
async function runTool(
  toolName: string,
  run: ToolRun,
  args: Record<string, JsonValue>,
  ctx: McpContext,
): Promise<string> {
  currentSignal()?.throwIfAborted();
  const text = await run(args);
  currentSignal()?.throwIfAborted();
  await recordMcpTokens(toolName, text, ctx);
  return text;
}

async function callTool(id: McpRequest['id'], params: McpRequest['params'], ctx: McpContext): Promise<McpResponse> {
  const nameValue = params?.name;
  const toolName = isJsonString(nameValue) ? nameValue : '';
  const tool = TOOLS_BY_NAME.get(toolName);
  if (!tool) {
    return errorReply(id, INVALID_PARAMS, `Unknown tool: ${toolName.slice(0, 128)}`);
  }
  // The same refusal a ported tool gives when it reaches hippo.db, so a client handles one shape.
  const run = toolRun(toolName, ctx);
  if (run === undefined) return errorReply(id, INTERNAL_ERROR, STORE_NOT_PORTED_MESSAGE);
  const refusal = sharedStoreRefusal(toolName, ctx);
  if (refusal !== undefined) {
    return resultReply(id, { content: [{ type: 'text', text: refusal }], isError: true });
  }
  const argumentsValue = params?.arguments;
  if (argumentsValue !== undefined && argumentsValue !== null && !isJsonObject(argumentsValue)) {
    return errorReply(id, INVALID_PARAMS, `${toolName}: arguments must be an object`);
  }
  const toolArgs = isJsonObject(argumentsValue) ? argumentsValue : {};
  const problems = validateToolArgs(tool.inputSchema, toolArgs, ARGS_CHECKED_BY_API.get(toolName));
  if (problems.length > 0) return invalidArgs(id, toolName, problems);
  let output: string;
  try {
    output = await runTool(toolName, run, toolArgs, ctx);
  } catch (err) {
    if (!(err instanceof RecallRequestError)) throw err;
    return invalidArgs(id, toolName, [err.message]);
  }
  return resultReply(id, { content: [{ type: 'text', text: output || 'Done.' }] });
}

/** Transport-agnostic MCP dispatcher: the stdio loop and the HTTP/SSE transport route every JSON-RPC message through
 * it. Returns null for notifications. A tool's errors are the caller's problem: wrap with try/catch in the transport.
 * Only `tools/call` needs the context, so stdio builds one for that method alone. */
export async function handleMcpRequest(req: McpRequest, ctx: McpContext | undefined): Promise<McpResponse | null> {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      return resultReply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'hippo-memory', version: PACKAGE_VERSION },
      });

    case 'notifications/initialized':
      return null;

    case 'tools/list': {
      return resultReply(id, { tools: TOOLS.filter((t) => runsOn(ctx?.store, t.name)) });
    }

    case 'tools/call':
      if (ctx === undefined) throw new Error('hippo-mcp: tools/call needs a context');
      return callTool(id, params, ctx);

    default:
      // Notifications (no id) must not receive a response
      if (method.startsWith('notifications/')) return null;
      return errorReply(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}
