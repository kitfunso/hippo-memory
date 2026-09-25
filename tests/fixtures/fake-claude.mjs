#!/usr/bin/env node
// Stand-in for `claude -p --output-format json` in tests/token-eval-ab-run.test.ts.
// Reads the prompt from stdin, runs the UserPromptSubmit hooks from --settings
// with a real hook payload (so hippo's hook and ledger run for real), "fixes"
// lib.js when the prompt says FIX, remembers a lesson through the hippo CLI when the workspace has a hippo store,
// writes a transcript under FAKE_CLAUDE_PROJECTS and prints a JSON result
// shaped like Claude Code's.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('0.0.0-fake (Claude Code)');
  process.exit(0);
}
const prompt = fs.readFileSync(0, 'utf8');
const sessionId = randomUUID();
const settingsPath = argv[argv.indexOf('--settings') + 1];
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
let injected = '';
for (const group of settings.hooks?.UserPromptSubmit ?? []) {
  for (const h of group.hooks) {
    const out = execSync(h.command, { input: JSON.stringify({ session_id: sessionId, prompt }), encoding: 'utf8' });
    if (out.trim()) injected += JSON.parse(out).hookSpecificOutput.additionalContext;
  }
}
if (prompt.includes('FIX')) {
  fs.writeFileSync('lib.js', 'module.exports.add = (a, b) => a + b;\n');
  if (fs.existsSync('.hippo') && !prompt.includes('NOREMEMBER')) {
    const hippoJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'hippo.js');
    // Let a failed remember crash the run: a swallowed error here hid a Windows path bug.
    execSync(`"${process.execPath}" "${hippoJs}" remember "add() in lib.js had its operator flipped; check operators first"`, { stdio: ['ignore', 'ignore', 'inherit'] });
  }
}
const dir = path.join(process.env.FAKE_CLAUDE_PROJECTS, 'proj');
fs.mkdirSync(dir, { recursive: true });
const lines = [
  { type: 'user', message: { role: 'user', content: prompt } },
  { type: 'assistant', message: { id: 'm1', usage: {}, content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'Error: file 12 not found' }] } },
  { type: 'assistant', message: { id: 'm2', usage: {}, content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: {} }] } },
];
fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
const extra = Math.ceil(injected.length / 4);
console.log(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, session_id: sessionId, num_turns: 3, total_cost_usd: 0.01,
  usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
  modelUsage: { 'fake-model': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10000, cacheCreationInputTokens: 2000 + extra, costUSD: 0.01 } },
}));
