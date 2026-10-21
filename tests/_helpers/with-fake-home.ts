import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';

/**
 * Each test gets its own fake $HOME so we never touch the real
 * ~/.claude/settings.json, ~/.config/opencode/opencode.json, or
 * ~/.config/opencode/plugins/ on the machine running the tests.
 *
 * Sets HOME on POSIX and USERPROFILE on Windows; the caller's afterEach vi.unstubAllEnvs restores both.
 * Extracted from tests/hooks/hooks.test.ts 2026-05-23 so the new opencode plugin
 * install tests use the same isolation pattern.
 */
export interface FakeHomeHandle {
  cleanup: () => void;
  home: string;
}

export function withFakeHome(prefix = 'hippo-test-'): FakeHomeHandle {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  vi.stubEnv('HOME', fake);
  vi.stubEnv('USERPROFILE', fake);
  return {
    home: fake,
    cleanup: () => {
      fs.rmSync(fake, { recursive: true, force: true });
    },
  };
}
