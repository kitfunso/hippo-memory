// The hippo block each agent's instruction file carries, and how init recognises one it wrote earlier.
import { createHash } from 'node:crypto';

export const HOOK_MARKERS = {
  start: '<!-- hippo:start -->',
  end: '<!-- hippo:end -->',
};

export const HOOKS: Record<string, { file: string; content: string; description: string }> = {
  'claude-code': {
    file: 'CLAUDE.md',
    description: 'Claude Code',
    content: `
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
`.trim(),
  },
  'codex': {
    file: 'AGENTS.md',
    description: 'OpenAI Codex',
    content: `
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

When you learn something that should outlive this session (a decision and
its reason, a user preference, a lesson), record it right then, while you
work, never as a closing step. Leave out secrets and personal details:
\`\`\`bash
hippo remember "<what you learned and why>"
\`\`\`

When Hippo's Codex wrapper is installed, session-end capture runs automatically.
If the wrapper is not installed, capture a brief summary manually:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons: 2-5 bullets>'
\`\`\`
`.trim(),
  },
  'cursor': {
    file: 'AGENTS.md',
    description: 'Cursor',
    content: `
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

When you learn something that should outlive this session (a decision and
its reason, a user preference, a lesson), record it right then, while you
work, never as a closing step. Leave out secrets and personal details:
\`\`\`bash
hippo remember "<what you learned and why>"
\`\`\`

When ending a session, capture a brief summary:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons: 2-5 bullets>'
\`\`\`
`.trim(),
  },
  'openclaw': {
    file: 'AGENTS.md',
    description: 'OpenClaw',
    content: `
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

When you learn something that should outlive this session (a decision and
its reason, a user preference, a lesson), record it right then, while you
work, never as a closing step. Leave out secrets and personal details:
\`\`\`bash
hippo remember "<what you learned and why>"
\`\`\`

When ending a session, capture a brief summary:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons: 2-5 bullets>'
\`\`\`
`.trim(),
  },
  'opencode': {
    file: 'AGENTS.md',
    description: 'OpenCode',
    content: `
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

When you learn something that should outlive this session (a decision and
its reason, a user preference, a lesson), record it right then, while you
work, never as a closing step. Leave out secrets and personal details:
\`\`\`bash
hippo remember "<what you learned and why>"
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
  },
  'pi': {
    file: 'AGENTS.md',
    description: 'Pi',
    content: `
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

When you learn something that should outlive this session (a decision and
its reason, a user preference, a lesson), record it right then, while you
work, never as a closing step. Leave out secrets and personal details:
\`\`\`bash
hippo remember "<what you learned and why>"
\`\`\`

When ending a session, capture a brief summary:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons: 2-5 bullets>'
\`\`\`

For full integration, copy the hippo-memory Pi extension to \`~/.pi/agent/extensions/hippo-memory/\`.
`.trim(),
  },
};

// sha256 of each trimmed block an earlier hippo wrote, so init refreshes only blocks nobody edited. Add the old hash when a block changes.
const SHIPPED_HOOK_HASHES = new Map([
  ['c04e48f2896a4fee9ae98f8f832e2d26a3910269df3beb5bcd6baee3cd9db68e', 'claude-code'],
  ['e6b12bd8983c032e5ca8e95a97aeff4178a5a05026d10acad5b2e1b25d5656dd', 'claude-code'],
  ['4c64e11d3e5be68fa547c9248d7553feb645a02f7cf13ba02f7275e1854baf44', 'claude-code'],
  ['293bd319bbc86225a0ee027490a3322a0336257f5832f7fade65e4ffb2530654', 'claude-code'],
  ['15abcece9712279fb4721f7a8f0ba117457400278977beb5cf5b5d7ba49f7b1a', 'codex'],
  ['0c81a6b2c21473313001f624b80ea870e661aecbfda9bfe8503febc0d5f34533', 'codex'],
  ['88e45358aba4f17912f113221c991dc758275991335d1daa4aa1974a69c46769', 'codex'],
  ['e61632fe177450a06541c148a9a4f9182530d8df667806927a99792825903298', 'codex'],
  ['a1415ecda9b2f8f317c233738e4a5ac16e6b2cc385a017c0c8ecfbfacbcab6a3', 'cursor'],
  ['a38c428bbdfc14ec50f6f7b9183785170a4eae1ce9cde60257cca6efc7206b3a', 'cursor'],
  ['0ec9f556abfd55e94f9e6fb47ece0fc5acb841977d144b35a2371e03645d8636', 'cursor'],
  ['40524c3bd5a2eb04036567cc761451961d950995768bccd93a9900b0f75eafea', 'openclaw'],
  ['7b3518e8c0feaa7b8b454cde7743f7598ad14cd9979e1680d0954484e2464aae', 'openclaw'],
  ['1137dcf04568caf011e41db77bc55324faee88bc29c3a5fcc98ab687cd952a16', 'openclaw'],
  ['4601c67c31f41cd5b1324cfccdb1afc66872b7fb0bc1e7c5789ecabb1f6bd942', 'opencode'],
  ['90d9e21d8d1ecbe99a0fc7b7f2d9f8af7b5315a6b4b0203df4f7a9bdc0699b98', 'opencode'],
  ['ca4e00284f1397ed2f2fcc53210c27f63b90edf6b37fd66dad5ee58b94ea3eee', 'opencode'],
  ['8b8f5986d7f7ed15f06e68720d8913c3cab23d94366b411935ca2bbaa334553b', 'pi'],
  ['37767b355e18beac726b05b9e2b898dab8c6135fd7b98f3aa52edc734d5dd283', 'pi'],
  ['6e85a5cccb3cfeaa9a080713754936db730f96376f94cc9a9888a746149c7268', 'pi'],
]);

/** The first hippo block in `text` and the agent whose current or shipped text it is; `owner` is undefined for an edited block. */
export function hippoBlock(text: string): { start: number; end: number; eol: string; inner: string; owner?: string } | null {
  const at = text.indexOf(HOOK_MARKERS.start);
  const start = at + HOOK_MARKERS.start.length;
  const end = text.indexOf(HOOK_MARKERS.end, start);
  if (at < 0 || end < 0) return null;
  // git autocrlf checks these files out with CRLF: match as LF, write back in the file's own ending.
  const raw = text.slice(start, end);
  const inner = raw.replace(/\r\n/g, '\n').trim();
  const owner = Object.keys(HOOKS).find((k) => HOOKS[k].content === inner) ?? SHIPPED_HOOK_HASHES.get(createHash('sha256').update(inner).digest('hex'));
  return { start, end, eol: raw.includes('\r\n') ? '\r\n' : '\n', inner, owner };
}
