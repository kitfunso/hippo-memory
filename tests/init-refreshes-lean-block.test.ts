// The instruction block asks for nothing a hook already does, and `hippo init` swaps it in for an old block nobody edited.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hippoRun } from './_helpers/spawn-hippo.js';
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

// The Claude Code block as it stands: Claude Code's own auto memory saves what it learns, so it has no plain remember line.
const CLAUDE_CURRENT = `
## Project Memory (Hippo)

Pinned rules and recent writes auto-inject at every prompt via the installed
UserPromptSubmit hook; never re-run that part manually. At the START of a
task (not per prompt), additionally load task-specific context: git-aware
recall over the full store that per-prompt injection does not cover. Also
run it if the hook is not installed:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`

When you find out why something failed, record it right then, while you
work, never as a closing step:
\`\`\`bash
hippo remember "<what went wrong and why>" --error
\`\`\`

The installed hooks store failed tool calls and capture the session when it
ends, so there is nothing to run before you finish.
`.trim();

// The AGENTS.md blocks written for these five agents before the plain remember line came back.
const PREVIOUS_AGENTS_BLOCKS = {
  codex: `
## Project Memory (Hippo)

At the start of every task, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

On errors or unexpected behaviour, record it right then, while you work,
never as a closing step:
\`\`\`bash
hippo remember "<description of what went wrong>" --error
\`\`\`

When Hippo's Codex wrapper is installed, session-end capture runs automatically.
If the wrapper is not installed, capture a brief summary manually:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons: 2-5 bullets>'
\`\`\`
`.trim(),
  cursor: `
## Project Memory (Hippo)

At the start of every task, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

On errors or unexpected behaviour, record it right then, while you work,
never as a closing step:
\`\`\`bash
hippo remember "<description of what went wrong>" --error
\`\`\`

When ending a session, capture a brief summary:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons: 2-5 bullets>'
\`\`\`
`.trim(),
  openclaw: `
## Project Memory (Hippo)

At the start of every session, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

On errors or unexpected behaviour, record it right then, while you work,
never as a closing step:
\`\`\`bash
hippo remember "<description of what went wrong>" --error
\`\`\`

When ending a session, capture a brief summary:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons: 2-5 bullets>'
\`\`\`
`.trim(),
  opencode: `
## Project Memory (Hippo)

At the start of every task, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

When you learn a non-obvious lesson or hit an error, record it right then,
while you work, never as a closing step:
\`\`\`bash
hippo remember "<lesson>" --error
\`\`\`

When stuck or repeating yourself, check if this happened before:
\`\`\`bash
hippo recall "<what's going wrong>" --budget 2000
\`\`\`

When ending a session, capture a brief summary:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons: 2-5 bullets>'
\`\`\`
`.trim(),
  pi: `
## Project Memory (Hippo)

At the start of every session, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

On errors or unexpected behaviour, record it right then, while you work,
never as a closing step:
\`\`\`bash
hippo remember "<description of what went wrong>" --error
\`\`\`

When ending a session, capture a brief summary:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons: 2-5 bullets>'
\`\`\`

For full integration, copy the hippo-memory Pi extension to \`~/.pi/agent/extensions/hippo-memory/\`.
`.trim(),
};
const REMEMBER_LINE = 'hippo remember "<what you learned and why>"\n';
const NO_SECRETS = 'Leave out secrets and personal details:';

let home: string;
let proj: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-leanblock-'));
  proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function hippo(cwd: string, ...args: string[]): string {
  const r = hippoRun(args, { cwd, env: { ...process.env, HOME: home, USERPROFILE: home, HIPPO_HOME: path.join(home, 'global') } });
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
    expect(claude).not.toContain(REMEMBER_LINE);
    expect(claude).not.toContain('hippo outcome');
    expect(claude).not.toContain('hippo capture');
    const codex = inner(read('AGENTS.md'));
    expect(codex).toContain('hippo context --auto --budget 1500');
    expect(codex).not.toContain('hippo outcome');
    expect(codex).toContain('hippo capture --stdin');
    expect(codex).toContain(REMEMBER_LINE);
    expect(codex).toContain(NO_SECRETS);
  });

  it.each(['cursor', 'openclaw', 'opencode', 'pi'])('keeps context, errors and capture, drops the outcome mark and asks for a plain remember for %s, which has no capture hook', (agent) => {
    write('AGENTS.md', '# Agents\n');
    hippo(proj, 'hook', 'install', agent);
    const text = inner(read('AGENTS.md'));
    expect(text).toContain('hippo context --auto --budget 1500');
    expect(text).toContain('hippo remember "<description of what went wrong>" --error');
    expect(text).toContain(REMEMBER_LINE);
    expect(text).toContain(NO_SECRETS);
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

  it.each(Object.entries(PREVIOUS_AGENTS_BLOCKS))('refreshes the previous %s block to the one that asks for a plain remember', (agent, previous) => {
    const before = `# Agents\n\nKeep this line.\n\n${START}\n${previous}\n${END}\n\nAnd this one.\n`;
    write('AGENTS.md', before);
    expect(init()).toContain(`Refreshed the ${agent} hippo block in AGENTS.md`);

    // `hook install codex` swaps the Codex launcher, so the expected Codex block comes from init in a fresh project.
    const fresh = path.join(home, 'fresh');
    fs.mkdirSync(fresh);
    fs.writeFileSync(path.join(fresh, 'AGENTS.md'), '# Agents\n');
    if (agent === 'codex') init(fresh);
    else hippo(fresh, 'hook', 'install', agent);

    const after = read('AGENTS.md');
    expect(outside(after)).toEqual(outside(before));
    expect(inner(after)).toBe(inner(read('AGENTS.md', fresh)));
    expect(inner(after)).toContain(REMEMBER_LINE);
    expect(inner(after)).not.toContain('<lesson>');
    const out = init();
    expect(read('AGENTS.md')).toBe(after);
    expect(out).not.toMatch(/Refreshed|Left the edited/);
  });

  it('leaves the current Claude Code block as it is, since its own auto memory saves what it learns', () => {
    const before = `# Rules\n\n${START}\n${CLAUDE_CURRENT}\n${END}\n`;
    write('CLAUDE.md', before);
    const out = init();
    expect(read('CLAUDE.md')).toBe(before);
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
