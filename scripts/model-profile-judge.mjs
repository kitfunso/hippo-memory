#!/usr/bin/env node
/**
 * Judge helper for the model-profile benchmark. Uses the Claude Code CLI
 * (`claude -p --model ...`) so no API key is needed — the user's subscription
 * handles billing.
 */
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';

const JUDGE_MODEL = 'claude-sonnet-4-6';
const CLAUDE_BIN = process.platform === 'win32' ? 'claude.cmd' : 'claude';

function prompt(caseDef, response) {
  return `You are evaluating whether a model response passes a rubric. Be strict and literal.

Rubric PASS criteria: ${caseDef.rubric.pass}
Rubric FAIL criteria: ${caseDef.rubric.fail}

Model response to judge:
<<<
${response}
>>>

Return ONLY one word: PASS, FAIL, or UNCLEAR. No prose, no explanation.`;
}

function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDECODE') || k.startsWith('CLAUDE_CODE')) delete env[k];
  }
  return env;
}

export function judge(caseDef, response) {
  const text = prompt(caseDef, response);
  let out;
  try {
    out = execFileSync(
      CLAUDE_BIN,
      [
        '-p',
        '--model', JUDGE_MODEL,
        '--output-format', 'json',
        '--no-session-persistence',
        '--disallowed-tools', 'Bash,Edit,Write,Read,Glob,Grep,Task,WebFetch,WebSearch,NotebookEdit,TodoWrite,BashOutput,KillBash,ExitPlanMode,SlashCommand', // judge is pure text classification
      ],
      { input: text, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000, shell: process.platform === 'win32', env: childEnv(), cwd: os.tmpdir() }
    );
  } catch (err) {
    return { verdict: 'ERROR', raw: err.message };
  }
  let data;
  try {
    data = JSON.parse(out);
  } catch (err) {
    return { verdict: 'ERROR', raw: `parse: ${err.message}: ${out.slice(0, 200)}` };
  }
  if (data.is_error) {
    return { verdict: 'ERROR', raw: data.result ?? 'api error' };
  }
  const raw = (data.result ?? '').trim().toUpperCase();
  let verdict = 'UNCLEAR';
  if (raw.startsWith('PASS')) verdict = 'PASS';
  else if (raw.startsWith('FAIL')) verdict = 'FAIL';
  return { verdict, raw: data.result ?? '' };
}

// Allow direct invocation for quick tests:
//   echo '{"case": {...}, "response": "..."}' | node scripts/model-profile-judge.mjs
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    const { case: caseDef, response } = JSON.parse(input);
    const result = judge(caseDef, response);
    console.log(JSON.stringify(result, null, 2));
  });
}
