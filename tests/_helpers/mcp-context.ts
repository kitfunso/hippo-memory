// An MCP context as a host builds one, for tests that call handleMcpRequest directly.
import { bindMcpTools } from '../../src/surface/mcp/request.js';
import type { McpCaller, McpContext } from '../../src/surface/mcp/protocol.js';
import type { HippoStore } from '../../src/base/ports/store.js';

/** What a test sets on an MCP context; the builder adds the host's tools and store mapping. */
export type McpCallerFields = Omit<McpCaller<HippoStore>, 'storeFor'>;

/** `caller` with the tools bound on the store it passes in, each call run on that store as is. */
export function mcpContext(caller: McpCallerFields): McpContext {
  return { ...caller, storeFor: (own) => own, tools: bindMcpTools(caller.store) };
}
