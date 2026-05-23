import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Each test gets its own fake $HOME so we never touch the real
 * ~/.claude/settings.json, ~/.config/opencode/opencode.json, or
 * ~/.config/opencode/plugins/ on the machine running the tests.
 *
 * Sets HOME on POSIX and USERPROFILE on Windows; restores both on cleanup.
 * Extracted from tests/hooks.test.ts 2026-05-23 so the new opencode plugin
 * install tests use the same isolation pattern.
 */
export function withFakeHome(prefix = 'hippo-test-'): { cleanup: () => void; home: string } {
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HOME = fake;
  process.env.USERPROFILE = fake;
  return {
    home: fake,
    cleanup: () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      fs.rmSync(fake, { recursive: true, force: true });
    },
  };
}
