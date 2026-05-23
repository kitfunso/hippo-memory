/**
 * Tests for the opencode plugin installer (fix for issue #24).
 *
 * The opencode plugin installer replaces the v1.10.x-v1.11.1 JSON-hook installer
 * which wrote a Claude Code-style `hooks` block into ~/.config/opencode/opencode.json,
 * breaking opencode's launch (opencode's schema is additionalProperties:false and
 * has no `hooks` key). The fix writes a TS plugin at ~/.config/opencode/plugins/hippo.ts
 * subscribing to opencode's `session.idle` and `session.created` events, and migrates
 * any pre-existing broken hooks block out of opencode.json.
 *
 * Convention: real FS, no mocks. HOME isolated via tests/_helpers/with-fake-home.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withFakeHome } from './_helpers/with-fake-home.js';
import {
  OPENCODE_PLUGIN_SOURCE,
  HIPPO_OPENCODE_PLUGIN_MARKER,
  installOpencodePlugin,
  uninstallOpencodePlugin,
  resolveOpencodePluginPath,
  detectInstalledTools,
} from '../src/hooks.js';

describe('OPENCODE_PLUGIN_SOURCE', () => {
  it('contains the versioned hippo marker', () => {
    expect(OPENCODE_PLUGIN_SOURCE).toContain(HIPPO_OPENCODE_PLUGIN_MARKER);
    expect(HIPPO_OPENCODE_PLUGIN_MARKER).toMatch(/^HIPPO_OPENCODE_PLUGIN_V\d+$/);
  });

  it('handles session.idle and session.created events', () => {
    expect(OPENCODE_PLUGIN_SOURCE).toContain('session.idle');
    expect(OPENCODE_PLUGIN_SOURCE).toContain('session.created');
  });

  it('guards against non-Bun runtimes (typeof $ check)', () => {
    // Critic-mandated defense: opencode runs in Bun in practice but a future
    // Node-mode deployment would have $ undefined; fail closed instead of
    // crashing the host session with the idempotence marker locking the
    // broken file in place.
    expect(OPENCODE_PLUGIN_SOURCE).toMatch(/typeof\s+\$\s*!==\s*['"]function['"]/);
  });

  it('uses no type imports (avoids unverified @opencode-ai/plugin dependency)', () => {
    // @opencode-ai/plugin's npm publication status was unverifiable from the
    // build sandbox (npmjs.com returned 403 to WebFetch). opencode infers
    // plugin shape from the returned object so the type annotation was
    // convenience-only — drop it to eliminate the runtime resolution risk.
    expect(OPENCODE_PLUGIN_SOURCE).not.toContain('import type');
    expect(OPENCODE_PLUGIN_SOURCE).not.toContain('@opencode-ai/plugin');
  });
});

describe('installOpencodePlugin (real-FS)', () => {
  let env: { cleanup: () => void; home: string };
  beforeEach(() => {
    env = withFakeHome('hippo-opencode-');
  });
  afterEach(() => {
    env.cleanup();
  });

  it('writes a TS plugin file with the hippo marker on a fresh host', () => {
    const result = installOpencodePlugin();
    expect(result.installed).toBe(true);
    expect(result.migratedLegacyHooks).toBe(false);
    expect(result.jsonRepairFailed).toBe(false);
    expect(fs.existsSync(resolveOpencodePluginPath())).toBe(true);
    expect(fs.readFileSync(resolveOpencodePluginPath(), 'utf8')).toContain(HIPPO_OPENCODE_PLUGIN_MARKER);
  });

  it('is idempotent when content matches', () => {
    installOpencodePlugin();
    const result2 = installOpencodePlugin();
    expect(result2.installed).toBe(false);
  });

  it('overwrites when marker matches but content differs (future-proof for V1-revision)', () => {
    const pluginPath = resolveOpencodePluginPath();
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, `// ${HIPPO_OPENCODE_PLUGIN_MARKER}\n// stale content from an earlier 1.11.x\n`);
    const result = installOpencodePlugin();
    expect(result.installed).toBe(true);
    expect(fs.readFileSync(pluginPath, 'utf8')).toBe(OPENCODE_PLUGIN_SOURCE);
  });

  it('migrates: removes only hippo-owned hook entries from opencode.json', () => {
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    fs.writeFileSync(opencodeJsonPath, JSON.stringify({
      theme: 'dark',
      hooks: {
        SessionEnd: [
          { hooks: [{ type: 'command', command: 'hippo session-end --log-file foo', timeout: 5 }] },
          { hooks: [{ type: 'command', command: 'echo my own hook', timeout: 5 }] },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: 'hippo last-sleep --path bar', timeout: 5 }] }],
      },
    }, null, 2));

    const result = installOpencodePlugin();
    expect(result.migratedLegacyHooks).toBe(true);

    const after = JSON.parse(fs.readFileSync(opencodeJsonPath, 'utf8'));
    expect(after.theme).toBe('dark');
    // SessionStart was 100% hippo → key removed entirely.
    expect(after.hooks.SessionStart).toBeUndefined();
    // SessionEnd had a non-hippo entry → key preserved with only that entry left.
    expect(after.hooks.SessionEnd).toHaveLength(1);
    expect(JSON.stringify(after.hooks.SessionEnd)).toContain('my own hook');
  });

  it('drops the empty hooks key entirely when nothing survives', () => {
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    fs.writeFileSync(opencodeJsonPath, JSON.stringify({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'hippo session-end --log-file x' }] }],
      },
    }, null, 2));
    installOpencodePlugin();
    const after = JSON.parse(fs.readFileSync(opencodeJsonPath, 'utf8'));
    expect(after.hooks).toBeUndefined();
  });

  it('returns jsonRepairFailed=true when opencode.json is unparseable', () => {
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    fs.writeFileSync(opencodeJsonPath, '{ "hooks": ["unterminated string ');
    const result = installOpencodePlugin();
    expect(result.installed).toBe(true);            // plugin file still written
    expect(result.migratedLegacyHooks).toBe(false); // nothing migrated
    expect(result.jsonRepairFailed).toBe(true);     // structured error surfaced
  });

  it('does NOT create opencode.json on a fresh install with no legacy block', () => {
    installOpencodePlugin();
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    expect(fs.existsSync(opencodeJsonPath)).toBe(false);
  });

  it('leaves a non-hippo hooks key alone (false-positive defense)', () => {
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    // User's coincidental substring "hippo sleep" inside an echo payload —
    // must NOT trigger hippo-owned detection.
    fs.writeFileSync(opencodeJsonPath, JSON.stringify({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'echo "remember to hippo sleep your laptop"' }] }],
      },
    }, null, 2));
    const result = installOpencodePlugin();
    expect(result.migratedLegacyHooks).toBe(false);
    const after = JSON.parse(fs.readFileSync(opencodeJsonPath, 'utf8'));
    expect(after.hooks.SessionEnd).toHaveLength(1);
  });

  it('handles non-object hooks values gracefully (string)', () => {
    // Belt-and-braces: critic Rev 1 low-sev #3.
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    fs.writeFileSync(opencodeJsonPath, JSON.stringify({ hooks: 'oops, a string' }));
    const result = installOpencodePlugin();
    expect(result.installed).toBe(true);
    expect(result.migratedLegacyHooks).toBe(false);
    expect(result.jsonRepairFailed).toBe(false);
    // File untouched.
    expect(JSON.parse(fs.readFileSync(opencodeJsonPath, 'utf8')).hooks).toBe('oops, a string');
  });

  it('handles non-object hooks values gracefully (array)', () => {
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    fs.writeFileSync(opencodeJsonPath, JSON.stringify({ hooks: ['oops'] }));
    const result = installOpencodePlugin();
    expect(result.installed).toBe(true);
    expect(result.migratedLegacyHooks).toBe(false);
  });

  it('preserves user-authored hooks in the same inner array as a hippo hook (per-hook surgery)', () => {
    // Independent-review-critic flagged this as the missed surgical case:
    // if an entry's inner `hooks` array mixes a hippo command and a user
    // command, the user command must survive.
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    fs.writeFileSync(opencodeJsonPath, JSON.stringify({
      hooks: {
        SessionEnd: [{
          hooks: [
            { type: 'command', command: 'hippo session-end --log-file foo', timeout: 5 },
            { type: 'command', command: 'echo "my custom cleanup"', timeout: 10 },
          ],
        }],
      },
    }, null, 2));

    const result = installOpencodePlugin();
    expect(result.migratedLegacyHooks).toBe(true);

    const after = JSON.parse(fs.readFileSync(opencodeJsonPath, 'utf8'));
    expect(after.hooks.SessionEnd).toHaveLength(1);
    expect(after.hooks.SessionEnd[0].hooks).toHaveLength(1);
    expect(after.hooks.SessionEnd[0].hooks[0].command).toBe('echo "my custom cleanup"');
    // timeout preserved on the surviving entry
    expect(after.hooks.SessionEnd[0].hooks[0].timeout).toBe(10);
  });

  it('does NOT match a third-party `hippo` binary that lacks a canonical hippo verb', () => {
    // entryIsHippoOwned regex now requires a known hippo verb. A user with a
    // wrapper script literally named 'hippo' that takes non-hippo args should
    // not have their entry deleted.
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    fs.writeFileSync(opencodeJsonPath, JSON.stringify({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'hippo deploy', timeout: 5 }] }],
      },
    }, null, 2));
    const result = installOpencodePlugin();
    expect(result.migratedLegacyHooks).toBe(false);
    const after = JSON.parse(fs.readFileSync(opencodeJsonPath, 'utf8'));
    expect(after.hooks.SessionEnd).toHaveLength(1);
  });
});

describe('uninstallOpencodePlugin (real-FS)', () => {
  let env: { cleanup: () => void; home: string };
  beforeEach(() => {
    env = withFakeHome('hippo-opencode-');
  });
  afterEach(() => {
    env.cleanup();
  });

  it('removes only files with the hippo marker', () => {
    installOpencodePlugin();
    expect(uninstallOpencodePlugin()).toBe(true);
    expect(fs.existsSync(resolveOpencodePluginPath())).toBe(false);
  });

  it('returns false when plugin not installed and no legacy block', () => {
    expect(uninstallOpencodePlugin()).toBe(false);
  });

  it('refuses to delete a user-written hippo.ts without the marker', () => {
    const pluginPath = resolveOpencodePluginPath();
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, '// user-written content, no marker\n');
    expect(uninstallOpencodePlugin()).toBe(false);
    expect(fs.existsSync(pluginPath)).toBe(true);
  });

  it('ALSO runs the legacy-hooks migration (downgrade path)', () => {
    const opencodeJsonPath = path.join(env.home, '.config', 'opencode', 'opencode.json');
    fs.mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
    fs.writeFileSync(opencodeJsonPath, JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'hippo session-end --log-file x' }] }] },
    }, null, 2));
    // No plugin installed; uninstall should still clean the legacy block so a
    // user running `hippo hook uninstall opencode` to remove hippo entirely
    // leaves opencode launchable.
    expect(uninstallOpencodePlugin()).toBe(true);
    const after = JSON.parse(fs.readFileSync(opencodeJsonPath, 'utf8'));
    expect(after.hooks).toBeUndefined();
  });
});

describe('detectInstalledTools opencode entry', () => {
  let env: { cleanup: () => void; home: string };
  beforeEach(() => {
    env = withFakeHome('hippo-detect-');
  });
  afterEach(() => {
    env.cleanup();
  });

  it('marks opencode as kind:"plugin" with the plugin path in notes', () => {
    fs.mkdirSync(path.join(env.home, '.config', 'opencode'), { recursive: true });
    const tool = detectInstalledTools().find((t) => t.name === 'opencode');
    expect(tool?.kind).toBe('plugin');
    expect(tool?.notes).toContain('plugins/hippo.ts');
    expect(tool?.detected).toBe(true);
  });
});
