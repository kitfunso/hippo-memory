import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installJsonHooks, uninstallJsonHooks } from '../src/hooks.js';

/**
 * Tests for the mid-session pinned-rule re-injection hook.
 *
 * Phase C of docs/plans/2026-04-21-pinned-reinject.md: `installJsonHooks`
 * must add a UserPromptSubmit entry that invokes
 * `hippo context --pinned-only --format additional-context` every turn,
 * so pinned memories survive long sessions where the model would otherwise
 * "forget" them.
 *
 * We override HOME + USERPROFILE to redirect `homeDir()` in src/hooks.ts to
 * a tmp directory — no signature change on installJsonHooks/uninstallJsonHooks.
 */
let tmpHome: string;
let savedUserProfile: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-hookinst-'));
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  savedUserProfile = process.env.USERPROFILE;
  savedHome = process.env.HOME;
  process.env.USERPROFILE = tmpHome;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
  else delete process.env.USERPROFILE;
  if (savedHome !== undefined) process.env.HOME = savedHome;
  else delete process.env.HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('installJsonHooks — UserPromptSubmit pinned-inject (claude-code)', () => {
  it('adds a UserPromptSubmit entry calling hippo context --pinned-only', () => {
    const result = installJsonHooks('claude-code');
    expect(result.installedUserPromptSubmit).toBe(true);

    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    const entries = settings.hooks.UserPromptSubmit;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
    const flat = JSON.stringify(entries);
    expect(flat).toContain('hippo context --pinned-only');
    expect(flat).toContain('--format additional-context');
  });

  it('is idempotent — second call does not add a duplicate UserPromptSubmit entry', () => {
    installJsonHooks('claude-code');
    const second = installJsonHooks('claude-code');
    expect(second.installedUserPromptSubmit).toBe(false);

    const settings = JSON.parse(fs.readFileSync(second.settingsPath, 'utf8'));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('uninstallJsonHooks removes the UserPromptSubmit pinned-inject entry', () => {
    installJsonHooks('claude-code');
    const removed = uninstallJsonHooks('claude-code');
    expect(removed).toBe(true);

    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const remaining = (settings.hooks?.UserPromptSubmit ?? []) as unknown[];
    expect(remaining).toHaveLength(0);
  });
});
