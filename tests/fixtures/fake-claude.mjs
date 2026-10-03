#!/usr/bin/env node
// Stand-in for `claude -p --output-format json` in the token-eval runner tests. It reads the prompt from stdin,
// runs the UserPromptSubmit hooks from --settings with a real payload, calls `hippo` through PATH, writes a transcript
// under $CLAUDE_CONFIG_DIR/projects/ and prints a result shaped like Claude Code's, plus what it saw.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('0.0.0-fake (Claude Code)');
  process.exit(0);
}
const prompt = fs.readFileSync(0, 'utf8');
const SEEN_FILES = ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', 'docs/AGENTS.md', 'sub/CLAUDE.md', '.claude/rules/r.md', '.claude/agents/x.md', '.scratch/note.md'];
const files = Object.fromEntries(SEEN_FILES.filter((f) => fs.existsSync(f)).map((f) => [f, fs.readFileSync(f, 'utf8')]));

// FAKE_CLAUDE_LIMIT_ONCE=<marker file>: the first call leaves stray edits and hits the plan limit.
const limitMarker = process.env.FAKE_CLAUDE_LIMIT_ONCE;
if (limitMarker && !fs.existsSync(limitMarker)) {
  fs.writeFileSync(limitMarker, '');
  fs.writeFileSync('stray.txt', 'half-done edit\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1790000000' }));
  process.exit(1);
}

const sessionId = randomUUID();
const settings = JSON.parse(fs.readFileSync(argv[argv.indexOf('--settings') + 1], 'utf8'));
let injected = '';
for (const group of settings.hooks?.UserPromptSubmit ?? []) {
  for (const h of group.hooks) {
    const out = execSync(h.command, { input: JSON.stringify({ session_id: sessionId, prompt }), encoding: 'utf8' });
    if (out.trim()) injected += JSON.parse(out).hookSpecificOutput.additionalContext;
  }
}

// The agent's own shell: a bare `hippo` resolves however PATH says, or fails with the shell's own message.
const probe = spawnSync('hippo --version', { shell: true, encoding: 'utf8' });
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
const hippoDir = process.env[pathKey].split(path.delimiter).find((d) => d && ['hippo', 'hippo.cmd'].some((n) => fs.existsSync(path.join(d, n)))) ?? null;

if (prompt.includes('FIX')) {
  fs.writeFileSync('lib.js', 'module.exports.add = (a, b) => a + b;\n');
  if (fs.existsSync('.hippo') && !prompt.includes('NOREMEMBER')) {
    // Let a failed remember crash the run: a swallowed error here hid a Windows path bug.
    execSync('hippo remember "add() in lib.js had its operator flipped; check operators first"', { stdio: ['ignore', 'ignore', 'inherit'] });
  }
}

const folder = process.cwd().replace(/[^a-zA-Z0-9]/g, '-');
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', folder);
fs.mkdirSync(dir, { recursive: true });
const lines = [
  { type: 'user', message: { role: 'user', content: prompt } },
  { type: 'assistant', message: { id: 'm1', usage: {}, content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'Error: file 12 not found' }] } },
  { type: 'assistant', message: { id: 'm2', usage: {}, content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: {} }] } },
  { type: 'assistant', message: { id: 'm3', usage: {}, content: [{ type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'git status && cat lib.js' } }] } },
];
fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));

const PLAIN = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HIPPO_HOME', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'HIPPO_AGENT_MEMORY_TOOLS', 'DISABLE_AUTOUPDATER', 'EVAL_SEED', 'ANTHROPIC_BASE_URL'];
const extra = Math.ceil(injected.length / 4);
console.log(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, session_id: sessionId, num_turns: 3, total_cost_usd: 0.01,
  strayFile: fs.existsSync('stray.txt'), argv, files,
  envKeys: Object.keys(process.env).sort(),
  env: { ...Object.fromEntries(PLAIN.map((k) => [k, process.env[k] ?? null])), PATH: process.env[pathKey] },
  hasToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
  hippoProbe: { status: probe.status, stdout: probe.stdout, stderr: probe.stderr }, hippoDir,
  usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
  modelUsage: { 'fake-model': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10000, cacheCreationInputTokens: 2000 + extra, costUSD: 0.01 } },
}));
