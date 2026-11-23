import { WRITE_TOOLS } from '../../src/surface/mcp/tools.js';

/** The MCP tools that only read; WRITE_TOOLS holds the rest, and a new tool must join one set. */
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'hippo_recall',
  'hippo_assemble',
  'hippo_drill',
  'hippo_context',
  'hippo_status',
  'hippo_conflicts',
  'hippo_peers',
  'hippo_predict_baserate',
]);

/** The names in neither the read set nor WRITE_TOOLS. */
export function unclassifiedTools(names: readonly string[]): string[] {
  return names.filter((name) => !READ_TOOLS.has(name) && !WRITE_TOOLS.has(name));
}
