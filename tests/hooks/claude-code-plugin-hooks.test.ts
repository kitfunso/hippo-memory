import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly { readonly command: string; readonly args?: readonly string[]; readonly if?: string }[];
}

const PLUGIN = path.join(fileURLToPath(new URL('../..', import.meta.url)), 'extensions', 'claude-code-plugin');
const HOOK_SCRIPT = '${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs';

// SAFETY: the plugin's hooks.json is a checked-in file; the tests below fail if its shape differs.
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')) as {
  hooks: Record<string, HookGroup[]>;
};

/** The hippo command line a hook runs: scripts/hook.mjs starts `hippo` with the args after the script. */
const hippoLine = (hook: HookGroup['hooks'][number]): string => ['hippo', ...(hook.args ?? []).slice(1)].join(' ');

const commands = (event: string, matcher?: string): string[] =>
  (manifest.hooks[event] ?? [])
    .filter((g) => matcher === undefined || g.matcher === matcher)
    .flatMap((g) => g.hooks.map(hippoLine));

describe('Claude Code plugin hook manifest', () => {
  it('delivers memories through the per-prompt hook, and only the user rules at session start', () => {
    expect(commands('SessionStart').filter((c) => c.startsWith('hippo context'))).toEqual([]);
    expect(commands('SessionStart').some((c) => c.startsWith('hippo session-rules'))).toBe(true);
    expect(commands('SessionStart').some((c) => c.startsWith('hippo last-sleep'))).toBe(true);
    expect(
      commands('UserPromptSubmit').some((c) =>
        c.startsWith('hippo context --pinned-only --include-recent 5 --format additional-context'),
      ),
    ).toBe(true);
  });

  it('saves a checkpoint before compaction with no matcher, so manual and automatic compaction both fire', () => {
    const groups = manifest.hooks.PreCompact ?? [];
    expect(
      groups.some((g) => g.matcher === undefined && g.hooks.some((h) => hippoLine(h).startsWith('hippo pre-compact'))),
    ).toBe(true);
  });

  it('extracts after compaction and resumes on the compact SessionStart', () => {
    expect(commands('PostCompact').some((c) => c.startsWith('hippo post-compact'))).toBe(true);
    expect(commands('SessionStart', 'compact').some((c) => c.startsWith('hippo compact-resume'))).toBe(true);
  });

  it('imports a memory note on a Write and on an Edit, each with its own if rule', () => {
    const group = (manifest.hooks.PostToolUse ?? []).find((g) => g.matcher === 'Edit|Write|MultiEdit');
    expect(group?.hooks.map((h) => hippoLine(h).startsWith('hippo note-written'))).toEqual([true, true]);
    expect(group?.hooks.map((h) => h.if)).toEqual([
      'Write(//**/projects/*/memory/*.md)',
      'Edit(//**/projects/*/memory/*.md)',
    ]);
  });

  // Anthropic's plugin directory refuses shell text and any variable but CLAUDE_PLUGIN_ROOT in a command it runs.
  it('starts every hook and the MCP server as node on a script inside the plugin, with no shell text', () => {
    const hooks = Object.values(manifest.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));
    expect(hooks.length).toBeGreaterThan(0);
    for (const hook of hooks) {
      expect(hook.command).toBe('node');
      expect(hook.args?.[0]).toBe(HOOK_SCRIPT);
      expect((hook.args ?? []).slice(1).filter((arg) => /[$`|&<>;*?{}%]/.test(arg))).toEqual([]);
    }
    expect(JSON.parse(fs.readFileSync(path.join(PLUGIN, '.mcp.json'), 'utf8'))).toEqual({
      mcpServers: { 'hippo-memory': { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs'] } },
    });
    for (const script of ['hook.mjs', 'mcp.mjs', 'spawn-hippo.mjs']) {
      expect(fs.existsSync(path.join(PLUGIN, 'scripts', script))).toBe(true);
    }
  });

  it('gives the marketplace entry the same version as the plugin manifest', () => {
    const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
    const marketplace = path.join(PLUGIN, '..', '..', '.claude-plugin', 'marketplace.json');
    expect(JSON.parse(fs.readFileSync(marketplace, 'utf8'))).toMatchObject({
      plugins: [{ source: './extensions/claude-code-plugin', version: plugin.version }],
    });
  });
});
