import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { codexAdapter } from '../src/agent-memories/codex.js';
import type { AdapterContext } from '../src/agent-memories/types.js';

const made: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-am-'));
  made.push(dir);
  return dir;
};
const lines = (...l: string[]) => l.join('\n');
const sha12 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
const ctxOf = (home: string, env: Record<string, string> = {}): AdapterContext => ({ home, env, platform: process.platform });
const summaryIn = (codexHome: string) => path.join(codexHome, 'memories', 'memory_summary.md');

function writeSummary(codexHome: string, content: string | Buffer): string {
  const file = summaryIn(codexHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
const userList = (home: string, env: Record<string, string> = {}) => codexAdapter.list(ctxOf(home, env), 'user');

const FIXTURE = lines(
  'v1',
  '',
  '## User Profile',
  '',
  'Works on a trading desk.',
  '',
  'Prefers short answers.',
  '',
  '## User preferences',
  '- Use metric units',
  '- No emojis',
  '  - not even in commit messages',
  '',
  '## General Tips',
  '- Run the tests before a commit',
  '',
  "## What's in Memory",
  '',
  '### scope',
  '',
  '#### 2026-09-01',
  '- topic: kw',
  '  - desc: first note',
  '',
);

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('codexAdapter home', () => {
  it('uses <home>/.codex by default', () => {
    const home = tmp();
    const file = writeSummary(path.join(home, '.codex'), FIXTURE);
    const listing = userList(home);
    expect(listing.tool).toBe('codex');
    expect(listing.home).toBe(path.join(home, '.codex'));
    expect(listing.containers.map((c) => c.path)).toEqual([file]);
  });

  it('uses CODEX_HOME instead when set, and ignores the default folder', () => {
    const home = tmp();
    const codexHome = path.join(tmp(), 'codex-home');
    writeSummary(path.join(home, '.codex'), FIXTURE.replace('Works on a trading desk.', 'Decoy in the default folder.'));
    const file = writeSummary(codexHome, FIXTURE);

    const listing = userList(home, { CODEX_HOME: codexHome });
    expect(listing.home).toBe(codexHome);
    expect(listing.containers.map((c) => c.path)).toEqual([file]);
    expect(listing.containers[0].items[0].text).toBe('User Profile: Works on a trading desk.');
  });

  it('lists no container, and no warning, for a missing folder or file', () => {
    const home = tmp();
    expect(userList(home)).toMatchObject({ containers: [], warnings: [] });
    fs.mkdirSync(path.join(home, '.codex', 'memories'), { recursive: true });
    expect(userList(home)).toMatchObject({ containers: [], warnings: [] });
    expect(userList(home, { CODEX_HOME: path.join(home, 'absent') })).toMatchObject({ containers: [], warnings: [] });
  });

  it('lists nothing in the project scope', () => {
    const home = tmp();
    writeSummary(path.join(home, '.codex'), FIXTURE);
    const listing = codexAdapter.list({ ...ctxOf(home), projectRoot: home }, 'project');
    expect(listing).toMatchObject({ containers: [], warnings: [], home: path.join(home, '.codex') });
  });
});

describe('codexAdapter items', () => {
  it('reads the profile paragraphs, preference bullets and tips, keyed by heading and text, at the file mtime', () => {
    const home = tmp();
    const file = writeSummary(path.join(home, '.codex'), FIXTURE);
    const mtime = new Date('2026-04-02T08:30:00Z');
    fs.utimesSync(file, mtime, mtime);

    const [container] = userList(home).containers;
    expect(container).toMatchObject({ scope: 'user', path: file, readable: true, skipped: [], warnings: [], textKeyed: true });
    const stored = (heading: string, text: string) => `${heading}: ${text}`;
    const expected = [
      ['user-profile', stored('User Profile', 'Works on a trading desk.')],
      ['user-profile', stored('User Profile', 'Prefers short answers.')],
      ['user-preferences', stored('User preferences', 'Use metric units')],
      ['user-preferences', stored('User preferences', 'No emojis\n  - not even in commit messages')],
      ['general-tips', stored('General Tips', 'Run the tests before a commit')],
    ] as const;
    expect(container.items).toEqual(
      expected.map(([slug, text]) => ({ key: `${slug}/${sha12(text)}`, text, updatedAt: mtime.getTime() })),
    );
  });

  it('skips What\'s in Memory and any other heading', () => {
    const home = tmp();
    writeSummary(path.join(home, '.codex'), lines(FIXTURE, '## Scratch', '- not a kept section', ''));
    const texts = userList(home).containers[0].items.map((i) => i.text);
    expect(texts.join('\n')).not.toContain('topic: kw');
    expect(texts.join('\n')).not.toContain('not a kept section');
    expect(texts).toHaveLength(5);
  });

  it('matches kept headings case-insensitively and stores the heading as written', () => {
    const home = tmp();
    writeSummary(path.join(home, '.codex'), lines('v1', '', '## user profile', '', 'Works alone.', '', '## GENERAL TIPS', '- Be brief', ''));
    const container = userList(home).containers[0];
    expect(container.items.map((i) => i.text)).toEqual(['user profile: Works alone.', 'GENERAL TIPS: Be brief']);
    expect(container.items.map((i) => i.key)).toEqual([
      `user-profile/${sha12('user profile: Works alone.')}`,
      `general-tips/${sha12('GENERAL TIPS: Be brief')}`,
    ]);
  });

  it('accepts blank lines before v1', () => {
    const home = tmp();
    writeSummary(path.join(home, '.codex'), lines('', '  ', 'v1', '', '## User Profile', '', 'Works alone.', ''));
    expect(userList(home).containers[0]).toMatchObject({ readable: true });
  });

  it('gives a repeated bullet under one heading a ~2 key', () => {
    const home = tmp();
    writeSummary(path.join(home, '.codex'), lines('v1', '', '## User Profile', '', 'Works alone.', '', '## User preferences', '- Be brief', '- Be brief', ''));
    const keys = userList(home).containers[0].items.map((i) => i.key);
    const base = `user-preferences/${sha12('User preferences: Be brief')}`;
    expect(keys.slice(1)).toEqual([base, `${base}~2`]);
  });

  it('gives CRLF text the same keys and texts as LF text', () => {
    const home = tmp();
    const other = tmp();
    writeSummary(path.join(home, '.codex'), FIXTURE);
    writeSummary(path.join(other, '.codex'), FIXTURE.replace(/\n/g, '\r\n'));
    const strip = (h: string) => userList(h).containers[0].items.map(({ key, text }) => ({ key, text }));
    expect(strip(other)).toEqual(strip(home));
    expect(strip(other)).toHaveLength(5);
  });
});

describe('codexAdapter broken shapes', () => {
  const unreadable = (content: string | Buffer) => {
    const home = tmp();
    const file = writeSummary(path.join(home, '.codex'), content);
    const listing = userList(home);
    expect(listing.containers).toHaveLength(1);
    expect(listing.containers[0]).toMatchObject({ path: file, readable: false, items: [], textKeyed: true });
    expect(listing.containers[0].warnings).toHaveLength(1);
    expect(listing.warnings).toEqual([]);
    return listing.containers[0];
  };

  it('reads a summary without the v1 line as unreadable', () => {
    unreadable(lines('## User Profile', '', 'Works alone.', ''));
    unreadable(lines('v2', '', '## User Profile', '', 'Works alone.', ''));
    unreadable(lines('# Notes', 'v1', '', '## User Profile', '', 'Works alone.', ''));
  });

  it('reads a summary without a ## User Profile heading as unreadable', () => {
    unreadable(lines('v1', '', '## User preferences', '- Be brief', ''));
    unreadable(lines('v1', '', '### User Profile', '', 'Works alone.', ''));
  });

  it('reads an empty file as unreadable', () => {
    unreadable('');
  });

  it('reads a file with a NUL byte or over 256 KB as unreadable', () => {
    unreadable(Buffer.from(`${FIXTURE}\0`));
    unreadable(`${FIXTURE}${'x'.repeat(256 * 1024)}`);
  });

  it('reads a summary path that is a folder as unreadable', () => {
    const home = tmp();
    fs.mkdirSync(summaryIn(path.join(home, '.codex')), { recursive: true });
    const [container] = userList(home).containers;
    expect(container).toMatchObject({ readable: false, items: [] });
    expect(container.warnings).toHaveLength(1);
  });
});
