// Transport-agnostic request handling: tool dispatch table, tool execution and the JSON-RPC method
// switch.

import { STORE_NOT_PORTED_MESSAGE } from '../../base/errors/http-errors.js';
import {
  hasGroup,
  hasGroups,
  type HippoStore,
  type OptionalGroup,
  type RequiredStore,
  type StoreGroups,
  type StoreWith,
} from '../../base/ports/store.js';
import { estimateTokens } from '../../base/util/token-text.js';
import { PACKAGE_VERSION } from '../../base/util/version.js';
import { validateToolArgs } from './tool-args.js';
import { RecallRequestError } from '../../api/recall/request.js';
import { globalTargetOf } from '../../api/infra.js';
import { recordTokens } from '../../api/tokens.js';
import { hasHippoDb, type HippoDbContext } from '../../api/hippo-db-context.js';
import {
  mcpApiContext,
  type GroupToolHandler,
  type HippoDbToolHandler,
  type LocalToolHandler,
  type McpCaller,
  type McpContext,
  type McpTools,
  type StoreTool,
  type ToolRun,
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
import {
  errorReply,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  resultReply,
} from './json-rpc.js';
import { type JsonValue, isJsonString, isJsonObject } from '../../base/util/json.js';

// ── Token ledger ──

/** Records the memory text hippo_context returned; best-effort (a ledger failure never fails the
 * call). hippo_recall's row is booked by the api with the rest of the recall, and other tools
 * are not recorded. */
async function recordMcpTokens(toolName: string, output: string, ctx: McpCaller): Promise<void> {
  if (toolName !== 'hippo_context' || !output) return;
  await recordTokens(mcpApiContext(ctx), 'mcp_context', {
    items: 0,
    tokens: estimateTokens(output),
  });
}

// ── Tool execution ──

/** A store whose type holds every optional group and hippo.db's local tier, as the stdio host's
 * cliStore does. */
type AllGroupsStore = HippoStore & StoreGroups & Pick<HippoDbContext, 'hippoDb'>;

/** One tool: its run on a store a host proved once, checked here, and its run on a store whose
 * type holds every group, checked nowhere. */
interface ToolRow {
  readonly bind: (proved: HippoStore) => StoreTool<RequiredStore> | undefined;
  readonly onAll: StoreTool<AllGroupsStore>;
}

/** A tool that runs under any store. */
function anyStore(run: ToolHandler): ToolRow {
  const tool: StoreTool<RequiredStore> = (ctx) => (args) => run({ ...toolCall(ctx), args });
  return { bind: () => tool, onAll: tool };
}

/** A tool that runs only on a store with every group `needs` names, handed that store and an api
 * Context on it. */
function needing<G extends OptionalGroup>(needs: readonly G[], run: GroupToolHandler<G>): ToolRow {
  const on =
    (ctx: McpCaller, store: StoreWith<G>): ToolRun =>
    (args) =>
      run({ ...toolCall(ctx), args, store, api: { ...mcpApiContext(ctx), store } });
  return {
    bind: (proved) =>
      hasGroups(proved, needs) ? (ctx) => on(ctx, ctx.storeFor(proved)) : undefined,
    onAll: (ctx) => on(ctx, ctx.store),
  };
}

/** A tool that runs only on hippo.db's store, handed its local tier and every group `needs`
 * names. */
function onHippoDb<G extends OptionalGroup>(
  needs: readonly G[],
  run: HippoDbToolHandler<G>,
): ToolRow {
  const on =
    (ctx: McpCaller, store: StoreWith<G> & Pick<HippoDbContext, 'hippoDb'>): ToolRun =>
    (args) => {
      const api = { ...mcpApiContext(ctx), store, hippoDb: store.hippoDb };
      return run({ ...toolCall(ctx), args, store, api });
    };
  return {
    bind: (proved) =>
      hasHippoDb(proved) && hasGroups(proved, needs)
        ? (ctx) => on(ctx, ctx.storeFor(proved))
        : undefined,
    onAll: (ctx) => on(ctx, ctx.store),
  };
}

/** A tool that runs only under a folder store with a global store in its reach. */
function localTool(run: LocalToolHandler): ToolRow {
  const on = (ctx: McpCaller, store: StoreWith<'folderFiles'>): ToolRun | undefined => {
    const globalTarget = globalTargetOf(ctx);
    return globalTarget === undefined
      ? undefined
      : (args) => run({ ...toolCall(ctx), args, store, globalTarget });
  };
  return {
    bind: (proved) =>
      hasGroup(proved, 'folderFiles') ? (ctx) => on(ctx, ctx.storeFor(proved)) : undefined,
    onAll: (ctx) => on(ctx, ctx.store),
  };
}

const TOOL_ROWS: ReadonlyMap<string, ToolRow> = new Map<string, ToolRow>([
  ['hippo_recall', anyStore(runRecallTool)],
  ['hippo_assemble', needing(['dagReads'], runAssembleTool)],
  ['hippo_drill', needing(['dagReads'], runDrillTool)],
  ['hippo_predict_baserate', needing(['objects'], runPredictBaserateTool)],
  ['hippo_remember', anyStore(runRememberTool)],
  ['hippo_outcome', anyStore(runOutcomeTool)],
  ['hippo_context', anyStore(runContextTool)],
  ['hippo_status', needing(['reports'], runStatusTool)],
  ['hippo_learn', onHippoDb(['lessonWrites'], runLearnTool)],
  ['hippo_conflicts', needing(['conflicts'], runConflictsTool)],
  ['hippo_resolve', needing(['conflicts'], runResolveTool)],
  ['hippo_share', localTool(runShareTool)],
  ['hippo_peers', localTool(runPeersTool)],
]);

/** The tools a host serves on `proved`, each need checked here once and each call run on
 * `ctx.storeFor(proved)`; a tool left out is hidden from a list and answers not ported. */
export function bindMcpTools(proved: HippoStore): McpTools<RequiredStore> {
  const tools = new Map<string, StoreTool<RequiredStore>>();
  for (const [name, row] of TOOL_ROWS) {
    const bound = row.bind(proved);
    if (bound !== undefined) tools.set(name, bound);
  }
  return tools;
}

/** Every tool, each run on the call's own store, whose type proves every group. */
export function allMcpTools(): McpTools<AllGroupsStore> {
  return new Map([...TOOL_ROWS].map(([name, row]) => [name, row.onAll]));
}

/** The transport's context is trusted: its hippoRoot, store and tenantId were bound by the host
 * (the HTTP server's Bearer, or the stdio host's folder walk and HIPPO_TENANT). */
function toolCall(ctx: McpCaller): Omit<ToolCall, 'args'> {
  const { hippoRoot, tenantId, config, store } = ctx;
  return { ctx, hippoRoot, store, config, tenantId };
}

/** The tool bound to `ctx`'s host, or undefined when its store does not serve it. */
function toolRun<S extends RequiredStore>(name: string, ctx: McpContext<S>): ToolRun | undefined {
  // handleMcpRequest rejects names missing from TOOLS, so reaching here means TOOLS and this table
  // drifted apart.
  if (!TOOL_ROWS.has(name)) {
    throw new Error(`hippo-mcp: tool ${name} is declared but has no handler`);
  }
  return ctx.tools.get(name)?.(ctx);
}

// ── Request handling ──

// The MCP spec reports input validation as a tool result with isError, so the model can read it and
// retry.
function invalidArgs(
  id: McpResponse['id'],
  toolName: string,
  problems: readonly string[],
): McpResponse {
  return resultReply(id, {
    content: [{ type: 'text', text: `Invalid arguments for ${toolName}: ${problems.join('; ')}` }],
    isError: true,
  });
}

/** The tool and its ledger row run on the stores of the caller's context, which the host (server
 * or stdio) builds; the context's signal reaches store calls, embeddings, rerankers and LLM
 * fetches through the api Context. */
async function runTool(
  toolName: string,
  run: ToolRun,
  args: Record<string, JsonValue>,
  ctx: McpCaller,
): Promise<string> {
  ctx.signal?.throwIfAborted();
  const text = await run(args);
  ctx.signal?.throwIfAborted();
  await recordMcpTokens(toolName, text, ctx);
  return text;
}

async function callTool<S extends RequiredStore>(
  id: McpRequest['id'],
  params: McpRequest['params'],
  ctx: McpContext<S>,
): Promise<McpResponse> {
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

/** Transport-agnostic MCP dispatcher: the stdio loop and the HTTP/SSE transport route every
 * JSON-RPC message through it. Returns null for notifications. A tool's errors are the caller's
 * problem: wrap with try/catch in the transport. Only `tools/call` needs the context, so stdio
 * builds one for that method alone. */
export async function handleMcpRequest<S extends RequiredStore>(
  req: McpRequest,
  ctx: McpContext<S> | undefined,
): Promise<McpResponse | null> {
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
      return resultReply(id, {
        tools: TOOLS.filter((t) => ctx === undefined || ctx.tools.has(t.name)),
      });
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
