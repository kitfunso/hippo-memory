import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleMcpRequest } from '../../src/surface/mcp/server.js';

describe('README MCP tool list', () => {
  it('names exactly the tools the MCP server lists', async () => {
    const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, undefined);
    // SAFETY: tools/list returns { result: { tools: [{ name }] } } per the MCP protocol.
    const served = (res as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name).sort();
    const readme = readFileSync(resolve(__dirname, '..', '..', 'README.md'), 'utf8');
    const line = readme.split('\n').find((l) => l.startsWith('Exposes ') && l.includes('tools:'));
    expect(line).toMatch(/^Exposes \d+ tools:/);
    const listed = [...line!.matchAll(/`(hippo_[a-z_]+)`/g)].map((m) => m[1]).sort();
    expect(listed).toEqual(served);
    expect(line).toContain(`Exposes ${served.length} tools`);
  });
});
