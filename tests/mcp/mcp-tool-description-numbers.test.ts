// A tool description that states a default must state the value the code reads, and hippo_outcome states no fixed half-life delta.
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/mcp/tools.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { DEFAULT_SEARCH_CANDIDATE_LIMIT } from '../../src/store/rows.js';

function descriptions(toolName: string): string {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error(`no tool ${toolName}`);
  return [
    tool.description,
    ...Object.values(tool.inputSchema.properties ?? {}).map((p) => String(p.description ?? '')),
  ].join('\n');
}

describe('MCP tool description numbers', () => {
  it('scorer_window default is the store candidate limit', () => {
    expect(descriptions('hippo_recall')).toContain(`Default ${DEFAULT_SEARCH_CANDIDATE_LIMIT}.`);
  });

  it('context budget default is the config default', () => {
    expect(descriptions('hippo_context')).toContain(
      `config.defaultContextBudget, ${DEFAULT_CONFIG.defaultContextBudget};`,
    );
  });

  it('hippo_outcome states no fixed half-life delta', () => {
    const text = descriptions('hippo_outcome');
    expect(text).not.toContain('+5 days');
    expect(text).not.toContain('-3 days');
  });

  it('the OpenClaw plugin states no fixed half-life delta either', async () => {
    const { default: register } = await import('../../extensions/openclaw-plugin/index.js');
    type ToolCtx = { readonly workspaceDir?: string };
    type Tool = { readonly name: string; readonly execute: unknown };
    const registrations: Array<Tool | ((ctx: ToolCtx) => Tool)> = [];
    register({
      config: {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      registerTool: (tool: Tool | ((ctx: ToolCtx) => Tool)) => registrations.push(tool),
      on() {},
    });
    const tools = registrations.map((r) => ('execute' in r ? r : r({})));
    expect(tools.map((t) => t.name)).toContain('hippo_outcome');
    const text = JSON.stringify(tools);
    expect(text).not.toContain('+5 days');
    expect(text).not.toContain('-3 days');
  });
});
