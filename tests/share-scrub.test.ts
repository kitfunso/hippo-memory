// scrubForSharing: transcript text bound for another machine loses secrets, emails and the user name in home paths.
import { describe, expect, it } from 'vitest';
import { maskHomePaths, USER_SEGMENT } from '../src/home-path.js';
import { scrubForSharing } from '../src/share-scrub.js';
import { ASSIGNED_SECRET, ASSIGNED_SECRET_LINES, ORDINARY_CONFIG_LINES } from './_helpers/secret-shapes.js';

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
    ['Windows, a user folder with a space', 'open C:\\Users\\Alice Smith\\Documents\\notes.md now', 'open [home]\\Documents\\notes.md now'],
    ['Windows, a quoted user folder with a space', 'cd "C:\\Users\\Alice Smith" now', 'cd "[home]" now'],
    ['Git Bash mount, a user folder with a space', 'open /c/Users/Alice Smith/repo now', 'open [home]/repo now'],
    ['two quoted Windows paths in one JSON line', '{"cwd":"C:\\\\Users\\\\alice","file":"C:\\\\Users\\\\bob\\\\x.ts"}', '{"cwd":"[home]","file":"[home]\\\\x.ts"}'],
    ['a VS Code file link', 'see [x.ts](file:///c%3A/Users/alice/dev/x.ts) now', 'see [x.ts](file:///[home]/dev/x.ts) now'],
    ['a URL-encoded backslash path', 'cwd c%3A%5CUsers%5Calice%5Cdev now', 'cwd [home]%5Cdev now'],
    ['a UNC home share', 'open \\\\fileserver\\home$\\alice\\proj now', 'open [home]\\proj now'],
    ['a UNC roaming profiles share', 'open \\\\corp-fs01\\profiles$\\kit.sofun\\Desktop', 'open [home]\\Desktop'],
    ['Windows, a spaced user folder in backticks', 'my home folder is `C:\\Users\\Kit Sofun`', 'my home folder is `[home]`'],
    ['Windows, a spaced user folder in brackets', '(C:\\Users\\Kit Sofun)', '([home])'],
    ['Windows, a spaced user folder before a full stop', 'open C:\\Users\\Kit Sofun.', 'open [home].'],
    ['Windows, a spaced user folder at the end of the text', 'open C:\\Users\\Kit Sofun', 'open [home]'],
    ['Windows, a spaced user folder at the end of a line', 'open C:\\Users\\Kit Sofun\nthen build', 'open [home]\nthen build'],
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

  // Built at runtime, so no secret-shaped literal sits in source.
  const PASSWORD = 'Hunter2' + 'Hunter2';
  const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/' + 'bPxRfiCYEXAMPLEKEY';
  it.each([
    ['a prefixed password', `DB_PASSWORD=${PASSWORD}`, 'DB_[REDACTED]'],
    ['a prefixed token', `set MY_API_TOKEN=${'abc123' + 'def456ghi789'}`, 'set MY_API_[REDACTED]'],
    ['a prefixed secret after a colon', `CLIENT_SECRET: ${'4f9a8b7c6d' + '5e4f3a2b1c'}`, 'CLIENT_[REDACTED]'],
    ['a name that runs on past the keyword', `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, 'AWS_SECRET_[REDACTED]'],
    ['a database URL password', `DATABASE_URL=postgres://admin:${'S3cret' + 'Pw9'}@localhost:5432/app`, 'DATABASE_URL=postgres://[REDACTED]@localhost:5432/app'],
    ['a git remote password', `https://user:${'ghsecret' + 'pw99'}@internal-host/repo.git`, 'https://[REDACTED]@internal-host/repo.git'],
    ['a mongodb+srv password', `mongodb+srv://svc:${'pa55' + 'word123'}@cluster0.abcde.mongodb.net/db`, 'mongodb+srv://[REDACTED]@cluster0.abcde.mongodb.net/db'],
    ['a URL password with no digit', `https://user:${'correct' + 'horse'}@internal-host/repo.git`, 'https://[REDACTED]@internal-host/repo.git'],
    ['a URL password before a path', `https://user:${'p4ss' + 'w0rd'}@host/x`, 'https://[REDACTED]@host/x'],
  ])('redacts %s', (_name, text, scrubbed) => {
    expect(scrubForSharing(text)).toBe(scrubbed);
  });

  it.each(ASSIGNED_SECRET_LINES)('redacts the assigned secret in %s', (text) => {
    const out = scrubForSharing(text);
    expect(out).not.toContain(ASSIGNED_SECRET);
    expect(out).toContain('[REDACTED]');
  });

  // Two of these hold a home path, so the home mask is the one change allowed.
  it.each(ORDINARY_CONFIG_LINES)('masks no secret in the ordinary config %s', (text) => {
    expect(scrubForSharing(text)).toBe(maskHomePaths(text));
  });

  it('reads no URL password from an @ in the query, so only the email is masked', () => {
    expect(scrubForSharing('http://localhost:8080?next=a@b.co')).toBe('http://localhost:8080?next=[email]');
  });
});

describe('scrubForSharing on hostile input', () => {
  const SIZE = 256 * 1024;
  const fill = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  // Each run sits on the hot path of at least one pattern, so a super-linear pattern shows here before it reaches the server.
  const UNITS = [
    'a.', 'a-', 'a@a.a.', '%2', '%3A%5C', 'c%3A%5CUsers%5C', 'c%3A/Users/',
    'AKIA', 'ghp_', 'github_pat_', 'xoxb-', 'xoxb--', 'sk_live_', 'AIza', 'hk_', 'npm_', 'hf_', 'glpat-', 'ya29.',
    'hooks.slack.com/services/', '-----BEGIN ', '-----BEGIN PRIVATE KEY-----', 'sk-', 'sk--', 'sk_a', 'sk_',
    'token=', 'token=a', '_token_', '_token_aaaaaaaa', 'password: a', 'secret-', 'x://', 'a://a:', 'a://a:a/', 'a://',
    'bearer ', 'bearer a', 'authorization: basic ', 'eyJ-', 'eyJa.', 'eyJaaaaaaaaa.eyJ', 'eyJaaaaaaaaa.eyJaaaaaaaaa.',
    'C:\\Users\\', 'C:\\Users\\a ', 'C:\\Users\\a b', 'C:\\Users\\a b)', 'C:/', '/mnt/c/Users/', '/c/Users/a ', '/home/', '/var/home/', '/root', '/Users/',
    'A~1', 'AAAAAA~1', '\\A~1', 'A~1.AB', '\\\\?\\', '\\\\a\\home$\\', '\\\\a\\home$\\a b ', '\\\\a\\profiles$\\', '\\\\a',
  ];
  it.each([
    ...UNITS.map((unit) => [JSON.stringify(unit), fill(unit)] as const),
    ['a@ then a long a. run', `a@${fill('a.')}`.slice(0, SIZE)] as const,
    ['long names that end in a keyword', fill(`${'a_'.repeat(1024)}password=`)] as const,
  ])('scrubs 256 KiB of %s in under 50 ms', (_name, text) => {
    const started = performance.now();
    scrubForSharing(text);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
