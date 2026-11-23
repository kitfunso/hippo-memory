import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACKAGE_VERSION } from '../../src/base/util/version.js';
import { TOOLS_BY_NAME } from '../../src/surface/mcp/tools.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGIN = path.join(ROOT, 'extensions', 'cursor-plugin');
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const rule = fs.readFileSync(path.join(PLUGIN, 'rules', 'hippo-memory.mdc'), 'utf8');

describe('Cursor plugin', () => {
  it('has a manifest Cursor accepts, with a committed logo and the package version', () => {
    const manifest = readJson(path.join(PLUGIN, '.cursor-plugin', 'plugin.json'));
    expect(manifest).toMatchObject({
      name: 'hippo-memory',
      version: PACKAGE_VERSION,
      license: 'MIT',
      logo: 'assets/logo.png',
    });
    expect(fs.existsSync(path.join(PLUGIN, 'assets', 'logo.png'))).toBe(true);
  });

  it('starts the same MCP server as the Kiro power', () => {
    expect(readJson(path.join(PLUGIN, 'mcp.json'))).toEqual(
      readJson(path.join(ROOT, 'extensions', 'kiro-power', 'mcp.json')),
    );
  });

  it('always applies its rule, and every tool and argument the rule names exists', () => {
    expect(rule).toMatch(/^---\ndescription: \S.*\nalwaysApply: true\n---\n/);
    const named = [...rule.matchAll(/`(hippo_[a-z_]+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const tool of named) expect(TOOLS_BY_NAME.has(tool), tool).toBe(true);
    expect(TOOLS_BY_NAME.get('hippo_remember')?.inputSchema.properties).toHaveProperty('error');
    expect(TOOLS_BY_NAME.get('hippo_outcome')?.inputSchema.properties).toHaveProperty('good');
  });

  it('is listed by the root marketplace manifest under the same name', () => {
    expect(readJson(path.join(ROOT, '.cursor-plugin', 'marketplace.json'))).toMatchObject({
      name: 'hippo-memory',
      owner: { name: 'Keith So' },
      plugins: [{ name: 'hippo-memory', source: 'extensions/cursor-plugin' }],
    });
  });
});
