// The agents whose own memories hippo imports. A leaf module: the keep rule, merge and share lists are built from it.

export const AGENT_MEMORY_TOOLS = [
  { id: 'claude-code', tag: 'claude-code-memory', label: 'Claude Code' },
  { id: 'codex', tag: 'codex-memory', label: 'Codex' },
  { id: 'gemini', tag: 'gemini-memory', label: 'Gemini CLI' },
  { id: 'copilot', tag: 'copilot-memory', label: 'Copilot' },
  { id: 'openclaw', tag: 'openclaw-memory', label: 'OpenClaw' },
  { id: 'qwen-code', tag: 'qwen-code-memory', label: 'Qwen Code' },
] as const;

export type AgentMemoryTool = (typeof AGENT_MEMORY_TOOLS)[number];
export type ToolId = AgentMemoryTool['id'];

export const AGENT_MEMORY_SOURCE_PREFIX = 'agent-memory:';

/** The actor on every row and audit event the agent-memories import writes. */
export const SYNC_ACTOR = 'agent-memories';

/** Every imported row of a tool has a source starting with this. */
export function toolSourcePrefix(id: ToolId): string {
  return `${AGENT_MEMORY_SOURCE_PREFIX}${id}:`;
}

export const AGENT_MEMORY_TAGS: readonly string[] = AGENT_MEMORY_TOOLS.map((t) => t.tag);

export function isToolId(value: string): value is ToolId {
  return AGENT_MEMORY_TOOLS.some((t) => t.id === value);
}

/** Whether a row with this source came in from an agent's own memory. */
export function isImport(source: string): boolean {
  return source.startsWith(AGENT_MEMORY_SOURCE_PREFIX);
}

/** The tag the tool of an imported row's source files it under, or null for no known tool. */
export function toolTag(source: string): string | null {
  const id = source.slice(AGENT_MEMORY_SOURCE_PREFIX.length).split(':')[0];
  return AGENT_MEMORY_TOOLS.find((t) => t.id === id)?.tag ?? null;
}

/** Tool, note key and hash of an import, without the container, whose id hashes the project name. */
export function noteKey(source: string): string {
  const rest = source.slice(AGENT_MEMORY_SOURCE_PREFIX.length);
  return `${rest.split(':')[0]}:${rest.slice(rest.indexOf('/') + 1)}`;
}
