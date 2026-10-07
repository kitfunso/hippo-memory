// Transport-agnostic request handling: tool dispatch table, tool execution and the JSON-RPC method switch.

import { log } from '../log.js';
import { getGlobalRoot, initGlobal } from '../shared.js';
import { loadConfig } from '../config.js';
import { resolveTenantId } from '../tenant.js';
import { openHippoDb, closeHippoDb, runWithRequestStores } from '../db.js';
import { estimateTokens, recordTokenUse, type TokenSurface } from '../token-ledger.js';
import { PACKAGE_VERSION } from '../version.js';
import { validateToolArgs } from './tool-args.js';
import { RecallRequestError } from '../api/recall-request.js';
import { findHippoRoot, isJsonObjectRecord, type McpContext, type McpRequest, type McpResponse, type ToolHandler } from './protocol.js';
import { TOOLS, TOOLS_BY_NAME, ARGS_CHECKED_BY_API } from './tools.js';
import { runRecallTool, runAssembleTool, runDrillTool, runContextTool } from './recall-tools.js';
import { runRememberTool, runOutcomeTool, runLearnTool } from './memory-tools.js';
import { runPredictBaserateTool, runStatusTool, runConflictsTool, runResolveTool, runShareTool, runPeersTool } from './admin-tools.js';
import { sharedStoreRefusal } from './shared-gate.js';
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
function recordMcpTokens(toolName: string, output: string, ctx?: McpContext): void {
  const surface = MCP_TOKEN_SURFACES.get(toolName);
  if (!surface || !output) return;
  try {
    const hippoRoot = ctx?.hippoRoot ?? findHippoRoot();
    if (!hippoRoot) return;
    const db = openHippoDb(hippoRoot);
    try {
      recordTokenUse(db, {
        tenantId: ctx?.tenantId ?? resolveTenantId({}),
        surface,
        event: 'inject',
        items: 0,
        tokens: estimateTokens(output),
      });
    } finally {
      closeHippoDb(db);
    }
  } catch (err) {
    log.warnThenDebug('mcp-token-ledger', `token ledger write failed; the tool reply is unaffected: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Tool execution ──

const TOOL_HANDLERS: ReadonlyMap<string, ToolHandler> = new Map<string, ToolHandler>([
  ['hippo_recall', runRecallTool],
  ['hippo_assemble', runAssembleTool],
  ['hippo_drill', runDrillTool],
  ['hippo_predict_baserate', runPredictBaserateTool],
  ['hippo_remember', runRememberTool],
  ['hippo_outcome', runOutcomeTool],
  ['hippo_context', runContextTool],
  ['hippo_status', runStatusTool],
  ['hippo_learn', runLearnTool],
  ['hippo_conflicts', runConflictsTool],
  ['hippo_resolve', runResolveTool],
  ['hippo_share', runShareTool],
  ['hippo_peers', runPeersTool],
]);

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

  const handler = TOOL_HANDLERS.get(name);
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
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

    case 'tools/call': {
      const nameValue = params?.name;
      const toolName = isJsonString(nameValue) ? nameValue : '';
      const tool = TOOLS_BY_NAME.get(toolName);
      if (!tool) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${toolName.slice(0, 128)}` } };
      }
      const refusal = sharedStoreRefusal(toolName, ctx);
      if (refusal !== undefined) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: refusal }], isError: true } };
      const argumentsValue = params?.arguments;
      if (argumentsValue !== undefined && argumentsValue !== null && !isJsonObjectRecord(argumentsValue)) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `${toolName}: arguments must be an object` } };
      }
      const toolArgs = isJsonObjectRecord(argumentsValue) ? argumentsValue : {};
      const problems = validateToolArgs(tool.inputSchema, toolArgs, ARGS_CHECKED_BY_API.get(toolName));
      if (problems.length > 0) return invalidArgs(id, toolName, problems);
      let output: string;
      try {
        // One handle per store for the tool and its ledger row; stdio interleaves calls, so each gets its own scope.
        output = await runWithRequestStores(async () => {
          const text = await executeTool(toolName, toolArgs, ctx);
          recordMcpTokens(toolName, text, ctx);
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
