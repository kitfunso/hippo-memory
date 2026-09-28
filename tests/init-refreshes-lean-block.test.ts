// The instruction block asks for nothing a hook already does, and `hippo init` swaps it in for an old block nobody edited.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');
const START = '<!-- hippo:start -->';
const END = '<!-- hippo:end -->';
// Old blocks used an em dash; spelling it as a code point keeps this source free of them.
const EM_DASH = String.fromCodePoint(0x2014);

// The CLAUDE.md block hippo 1.24.0 to 1.52.6 wrote.
const OLD_CLAUDE = `
## Project Memory (Hippo)

Pinned rules and recent writes auto-inject at every prompt via the installed
UserPromptSubmit hook; never re-run that part manually. At the START of a
task (not per prompt), additionally load task-specific context: git-aware
recall over the full store that per-prompt injection does not cover. Also
run it if the hook is not installed:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`

When you learn something important:
\`\`\`bash
hippo remember "<lesson>"
\`\`\`

When you hit an error or discover a gotcha:
\`\`\`bash
hippo remember "<what went wrong and why>" --error
\`\`\`

After completing work successfully:
\`\`\`bash
hippo outcome --good
\`\`\`

When the user ends the session, capture a brief summary:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons ${EM_DASH} 2-5 bullets>'
\`\`\`
`.trim();

// The AGENTS.md block hippo 0.24.0 to 1.52.6 wrote for Codex.
const OLD_CODEX = `
## Project Memory (Hippo)

At the start of every task, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

On errors or unexpected behaviour:
\`\`\`bash
hippo remember "<description of what went wrong>" --error
\`\`\`

On task completion:
\`\`\`bash
hippo outcome --good
\`\`\`

When Hippo's Codex wrapper is installed, session-end capture runs automatically.
If the wrapper is not installed, capture a brief summary manually:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons ${EM_DASH} 2-5 bullets>'
\`\`\`
`.trim();

let home: string;
let proj: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-leanblock-'));
  proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function hippo(cwd: string, ...args: string[]): string {
  const r = spawnSync(process.execPath, [HIPPO_JS, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, HIPPO_HOME: path.join(home, 'global') },
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}
// Without --no-schedule init would register a real OS task, without --no-learn it would run git.
const init = (cwd = proj) => hippo(cwd, 'init', '--no-schedule', '--no-learn');
const write = (f: string, text: string) => fs.writeFileSync(path.join(proj, f), text);
const read = (f: string, dir = proj) => fs.readFileSync(path.join(dir, f), 'utf8');
const inner = (text: string) => text.slice(text.indexOf(START) + START.length, text.indexOf(END)).trim();
const outside = (text: string) => [text.slice(0, text.indexOf(START) + START.length), text.slice(text.indexOf(END))];

describe('the instruction block', () => {
  it('asks Claude Code only for task context and error causes, since its hooks capture the session', () => {
    write('CLAUDE.md', '# Rules\n');
    write('AGENTS.md', '# Agents\n');
    init();
    const claude = inner(read('CLAUDE.md'));
    expect(claude).toContain('hippo context --auto --budget 1500');
    expect(claude).toContain('hippo remember "<what went wrong and why>" --error');
    expect(claude).not.toContain('hippo remember "<lesson>"');
    expect(claude).not.toContain('hippo outcome');
    expect(claude).not.toContain('hippo capture');
    const codex = inner(read('AGENTS.md'));
    expect(codex).toContain('hippo context --auto --budget 1500');
    expect(codex).not.toContain('hippo outcome');
    expect(codex).toContain('hippo capture --stdin');
  });

  it.each(['cursor', 'openclaw', 'opencode', 'pi'])('keeps context, errors and capture and drops the outcome mark for %s, which has no capture hook', (agent) => {
    write('AGENTS.md', '# Agents\n');
    hippo(proj, 'hook', 'install', agent);
    const text = inner(read('AGENTS.md'));
    expect(text).toContain('hippo context --auto --budget 1500');
    expect(text).toContain('--error');
    expect(text).not.toContain('hippo outcome');
    expect(text).toContain('hippo capture --stdin');
  });
});

describe('hippo init on a file that already has a hippo block', () => {
  it('swaps an unedited old block for the current one and keeps every byte outside the markers', () => {
    const claudeBefore = `# Rules\n\nKeep this line.\n\n${START}\n${OLD_CLAUDE}\n${END}\n\nAnd this one.\n`;
    write('CLAUDE.md', claudeBefore);
    write('AGENTS.md', `# Agents\n\n${START}\n\n${OLD_CODEX}\n  \n${END}\n`);
    const out = init();

    const fresh = path.join(home, 'fresh');
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(fresh, 'CLAUDE.md'), '# Rules\n');
    init(fresh);

    const claudeAfter = read('CLAUDE.md');
    expect(outside(claudeAfter)).toEqual(outside(claudeBefore));
    expect(inner(claudeAfter)).toBe(inner(read('CLAUDE.md', fresh)));
    expect(inner(read('AGENTS.md'))).not.toContain('hippo outcome');
    // AGENTS.md serves both Codex and OpenClaw here, and still gets one line.
    expect(out.match(/Refreshed/g)).toHaveLength(2);
  });

  it('leaves an edited old block alone and prints a hint', () => {
    const edited = `# Rules\n\n${START}\n${OLD_CLAUDE}\nAlso run the linter.\n${END}\n`;
    write('CLAUDE.md', edited);
    const out = init();
    expect(read('CLAUDE.md')).toBe(edited);
    expect(out).toContain('Left the edited hippo block in CLAUDE.md as is');
    expect(out).not.toContain('Refreshed');
  });

  it('refreshes an unedited old block in a CRLF file and keeps its line endings', () => {
    const before = `# Rules\n\nKeep this line.\n\n${START}\n${OLD_CLAUDE}\n${END}\n\nAnd this one.\n`.replace(/\n/g, '\r\n');
    write('CLAUDE.md', before);
    expect(init()).toContain('Refreshed the claude-code hippo block in CLAUDE.md');

    const fresh = path.join(home, 'fresh');
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(fresh, 'CLAUDE.md'), '# Rules\n');
    init(fresh);

    const after = read('CLAUDE.md');
    expect(outside(after)).toEqual(outside(before));
    expect(inner(after).replace(/\r\n/g, '\n')).toBe(inner(read('CLAUDE.md', fresh)));
    expect(after).not.toMatch(/(^|[^\r])\n/);
    const out = init();
    expect(read('CLAUDE.md')).toBe(after);
    expect(out).not.toMatch(/Refreshed|Left the edited/);
  });

  it('changes nothing on a second run', () => {
    write('CLAUDE.md', `# Rules\n\n${START}\n${OLD_CLAUDE}\n${END}\n`);
    expect(init()).toContain('Refreshed the claude-code hippo block in CLAUDE.md');
    const once = read('CLAUDE.md');
    const out = init();
    expect(read('CLAUDE.md')).toBe(once);
    expect(out).not.toMatch(/Refreshed|Left the edited/);
  });
});
