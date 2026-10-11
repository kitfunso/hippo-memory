#!/usr/bin/env node
// A blind Z0 author (stage 2 plan D3): one claude -p session with a fresh config, no hooks, no MCP and no hippo, logged through the request proxy.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { armEnv } from './arms.mjs';
import { spawnTree } from './exec.mjs';
import { startLogProxy, requestBodies } from './proxy.mjs';

// What a blind author must never see; the hippo-repository author passes a narrower list, since hippo's name is its subject (D3).
export const DEFAULT_FORBID = '(?<![a-z])hippo(?![a-z])|(?<![a-z0-9])z0(?![0-9])|token-eval';
const AUTHOR_UNSET = ['HIPPO_HOME', 'HIPPO_AGENT_MEMORY_TOOLS', 'CODEX_HOME', 'EVAL_SEED'];
const USAGE ='usage: node scripts/token-eval/z0-author.mjs --work DIR --prompt-file FILE --out DIR [--model M] [--claude-bin PATH] [--forbid REGEX] [--timeout-min N]';

/** Each match of `forbid` in `texts` as `{where, match, near}`; one hit discards the author's output, and `near` lets the operator judge it. */
export function leakHits(texts, forbid) {
  const re = new RegExp(forbid, 'gi');
  return texts.flatMap(({ where, text }) => [...String(text).matchAll(re)].map((m) => ({ where, match: m[0], near: String(text).slice(Math.max(0, m.index - 30), m.index + m[0].length + 30) })));
}

/**
 * Run one author session in `work` and write `session.json` and `verdict.json` to `out`.
 * @param {{work: string, prompt: string, out: string, model?: string | null, claudeBin?: string, forbid?: string, timeoutMs?: number, baseEnv?: Record<string, string | undefined>, upstream?: string}} opts
 */
export async function runAuthor({ work, prompt, out, model = null, claudeBin = 'claude', forbid = DEFAULT_FORBID, timeoutMs = 60 * 60_000, baseEnv = process.env, upstream }) {
  // Claude Code puts its working directory in the system prompt, so a forbidden path would void every author.
  const named = leakHits([{ where: 'work', text: path.resolve(work) }, { where: 'out', text: path.resolve(out) }], forbid);
  if (named.length) throw new Error(`the author's own paths hold a forbidden term: ${named.map((h) => `${h.where} has "${h.match}"`).join('; ')}`);
  const dirs = { claudeConfig: path.join(out, 'claude-config'), codexHome: '', hippoHome: '', bin: path.join(out, 'bin'), seed: 0 };
  if (fs.existsSync(dirs.claudeConfig)) throw new Error(`${dirs.claudeConfig} exists; an author starts from an empty config`);
  for (const dir of [work, dirs.claudeConfig]) fs.mkdirSync(dir, { recursive: true });
  const settings = path.join(out, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ autoMemoryEnabled: false }));
  // A0's env (no provider keys but the plan login, no hippo on PATH, auto memory off) minus the arm keys an author has no use for, which name hippo.
  const env = Object.fromEntries(Object.entries(armEnv('A0', dirs, baseEnv)).filter(([k]) => !AUTHOR_UNSET.includes(k)));
  const log = path.join(out, 'requests.jsonl');
  const args = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', '--settings', `"${settings}"`, '--permission-mode', 'bypassPermissions', ...(model ? ['--model', model] : [])];
  const proxy = await startLogProxy(log, { upstream });
  let cc;
  try {
    cc = await spawnTree(`${claudeBin} ${args.join(' ')}`, work, { ...env, ANTHROPIC_BASE_URL: proxy.url }, timeoutMs, prompt);
  } finally {
    await proxy.close();
  }
  fs.writeFileSync(path.join(out, 'session.json'), cc.stdout);
  const hits = leakHits([...requestBodies(log).map((text) => ({ where: 'request', text })), { where: 'output', text: cc.stdout }], forbid);
  const verdict = { status: cc.status, timedOut: cc.timedOut, forbid, requests: requestBodies(log).length, discarded: hits.length > 0, hits };
  fs.writeFileSync(path.join(out, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
  return verdict;
}

async function main(argv) {
  const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const work = flag('--work', null);
  const promptFile = flag('--prompt-file', null);
  const out = flag('--out', null);
  if (!work || !promptFile || !out) throw new Error(USAGE);
  const verdict = await runAuthor({
    work, out, prompt: fs.readFileSync(promptFile, 'utf8'), model: flag('--model', null), claudeBin: flag('--claude-bin', 'claude'),
    forbid: flag('--forbid', DEFAULT_FORBID), timeoutMs: Number(flag('--timeout-min', '60')) * 60_000,
  });
  console.log(JSON.stringify({ ...verdict, hits: verdict.hits.length }));
  process.exitCode = verdict.discarded || verdict.status !== 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exitCode = 2;
});
