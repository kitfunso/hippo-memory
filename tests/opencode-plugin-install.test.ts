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
import { describe, it, expect } from 'vitest';
import {
  OPENCODE_PLUGIN_SOURCE,
  HIPPO_OPENCODE_PLUGIN_MARKER,
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
