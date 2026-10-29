import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly { readonly command: string }[];
}

// SAFETY: the plugin's hooks.json is a checked-in file; the tests below fail if its shape differs.
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(fileURLToPath(new URL('..', import.meta.url)), 'extensions', 'claude-code-plugin', 'hooks', 'hooks.json'),
    'utf8',
  ),
) as { hooks: Record<string, HookGroup[]> };

const commands = (event: string, matcher?: string): string[] =>
  (manifest.hooks[event] ?? []).filter((g) => matcher === undefined || g.matcher === matcher).flatMap((g) => g.hooks.map((h) => h.command));

describe('Claude Code plugin hook manifest', () => {
  it('delivers memories through the per-prompt hook alone, with no context call at session start', () => {
    expect(commands('SessionStart').filter((c) => c.startsWith('hippo context'))).toEqual([]);
    expect(commands('SessionStart').some((c) => c.startsWith('hippo last-sleep'))).toBe(true);
    // The hint costs no tokens with a store: `hippo status` exits 0 and its output goes to /dev/null.
    expect(commands('SessionStart').filter((c) => c.includes('hippo init'))).toEqual([
      "hippo status >/dev/null 2>&1 || echo 'No hippo store found. Run: hippo init'",
    ]);
    expect(commands('UserPromptSubmit').some((c) => c.startsWith('hippo context --pinned-only --include-recent 5 --format additional-context'))).toBe(true);
  });

  it('saves a checkpoint before compaction with no matcher, so manual and automatic compaction both fire', () => {
    const groups = manifest.hooks.PreCompact ?? [];
    expect(groups.some((g) => g.matcher === undefined && g.hooks.some((h) => h.command.startsWith('hippo pre-compact')))).toBe(true);
  });

  it('extracts after compaction and resumes on the compact SessionStart', () => {
    expect(commands('PostCompact').some((c) => c.startsWith('hippo post-compact'))).toBe(true);
    expect(commands('SessionStart', 'compact').some((c) => c.startsWith('hippo compact-resume'))).toBe(true);
  });
});
