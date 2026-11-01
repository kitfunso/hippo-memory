// An MCP context as a host builds one, for tests that call handleMcpRequest directly.
import { bindMcpTools } from '../../src/surface/mcp/request.js';
import type { McpCaller, McpContext } from '../../src/surface/mcp/protocol.js';
import type { HippoStore } from '../../src/base/ports/store.js';
import type { JsonValue } from '../../src/base/util/json.js';

/** What a test sets on an MCP context; the builder adds the host's tools and store mapping. */
export type McpCallerFields = Omit<McpCaller<HippoStore>, 'storeFor'>;

/** `caller` with the tools bound on the store it passes in, each call run on that store as is. */
export function mcpContext(caller: McpCallerFields): McpContext {
  return { ...caller, storeFor: (own) => own, tools: bindMcpTools(caller.store) };
}

/** Tool `name` run as a tools/call request runs it, on the tools its host bound. */
export async function runMcpTool<S extends HippoStore>(
  ctx: McpContext<S>,
  name: string,
  args: Record<string, JsonValue>,
): Promise<string> {
  const run = ctx.tools.get(name)?.(ctx);
  if (run === undefined) throw new Error(`${name} is not served on this context`);
  return run(args);
}
