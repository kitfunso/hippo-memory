// scrubForSharing: transcript text bound for another machine loses secrets, emails and the user name in home paths.
import { describe, expect, it } from 'vitest';
import { maskHomePaths, USER_SEGMENT } from '../src/home-path.js';
import { scrubForSharing } from '../src/share-scrub.js';

const GITHUB_TOKEN = `ghp_${'a'.repeat(36)}`;

describe('maskHomePaths', () => {
  it.each([
    ['Windows', 'open C:\\Users\\alice\\repo\\app.ts now', 'open [home]\\repo\\app.ts now'],
    ['Windows, forward slashes', 'open C:/Users/alice/repo/app.ts now', 'open [home]/repo/app.ts now'],
    ['macOS', 'open /Users/alice/code/app.ts now', 'open [home]/code/app.ts now'],
    ['Linux', 'open /home/alice/src/app.ts now', 'open [home]/src/app.ts now'],
    ['Linux root', 'edit /root/.bashrc now', 'edit [home]/.bashrc now'],
    ['WSL mount', 'open /mnt/c/Users/alice/repo now', 'open [home]/repo now'],
    ['Git Bash mount', 'open /c/Users/alice/repo now', 'open [home]/repo now'],
  ])('%s: the user segment becomes [home]', (_name, text, masked) => {
    expect(maskHomePaths(text)).toBe(masked);
  });

  it.each([
    ['extended-length', 'open \\\\?\\C:\\Users\\alice\\repo now'],
    ['8.3 short name', 'temp is under ALICE~1.DEV\\AppData\\Local\\Temp'],
    ['8.3 short name after a drive', 'temp is under C:\\Users\\ALICE~1\\AppData'],
  ])('%s: no user segment is left', (_name, text) => {
    const masked = maskHomePaths(text);
    expect(masked).toContain('[home]');
    expect(masked).not.toMatch(/alice/i);
  });

  it('masks every home path in a text, not only the first', () => {
    expect(maskHomePaths('from /home/alice/a to /home/bob/b')).toBe('from [home]/a to [home]/b');
  });

  it.each([
    ['a tilde path', 'see ~/notes/todo.md'],
    ['a repo path with a home folder', 'see src/home/page.tsx'],
    ['a repo path with a Users folder', 'see docs/Users/guide.md'],
    ['a repo path with a root folder', 'see ./root/config.json'],
  ])('leaves %s alone', (_name, text) => {
    expect(maskHomePaths(text)).toBe(text);
  });

  it('leaves the shared test patterns usable after a mask', () => {
    maskHomePaths('/home/alice/a');
    expect(USER_SEGMENT.some((re) => re.test('/home/alice/a'))).toBe(true);
  });
});

describe('scrubForSharing', () => {
  it('masks a bearer header, a JWT and an email', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIz';
    const out = scrubForSharing(`Authorization: Bearer abcdefghijklmnop1234 then ${jwt} and mail alice@example.com`);
    expect(out).toBe('Authorization: [REDACTED] then [REDACTED] and mail [email]');
  });

  it('redacts a secret inside a home path as well as the user segment', () => {
    expect(scrubForSharing(`read C:\\Users\\alice\\keys\\${GITHUB_TOKEN}.txt`)).toBe('read [home]\\keys\\[REDACTED].txt');
    expect(scrubForSharing(`read /home/alice/.config/${GITHUB_TOKEN}`)).toBe('read [home]/.config/[REDACTED]');
  });

  it('returns clean text unchanged', () => {
    const text = 'We decided to pin pnpm in packages/api because npm rewrote the lockfile.';
    expect(scrubForSharing(text)).toBe(text);
  });
});
