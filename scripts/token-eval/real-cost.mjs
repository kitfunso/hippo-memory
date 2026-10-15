// Usage: node scripts/token-eval/real-cost.mjs [--projects <dir>] [--days <n>] [--claude-md <file>]
// $0 replay of real Claude Code sessions: prices hippo's memory text against built-in MEMORY.md under a 1h cache.
// Prints counts and dollars only. Arms: hippo today (now), hippo under the cost plan (plan), built-in, built-in per char (break-even).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Opus 5.5 per token, read 2026-10-15 at platform.claude.com/docs/en/about-claude/pricing: 1h write $8/MTok, hit $0.20/MTok.
const WRITE = 8e-6;
const READ = 0.2e-6;
const TTL = 3600e3;
const PIN_REFRESH = 10;
const MARK_LIFE = 25;
const POINTER = 150;
const tok = (chars) => chars / 4;
const HIPPO_HEAD = /^## (Project Memory|Prompt-Relevant Memory|Session Handoff|Active Task Snapshot|Recent Session Trail|Restored after compaction)/;
const HIPPO_CMD = /(?:^|[\s;&|(])hippo\s+(context|recall|remember|outcome|capture|handoff|snapshot)\b/;
const ARMS = ['now', 'plan', 'builtin', 'unit'];

// The same cut as leaks.mjs loadedIndex: Claude Code loads the first 200 lines or 25 KB of MEMORY.md.
const loadedMemory = (file) => {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file).subarray(0, 25 * 1024).toString('utf8').split('\n').slice(0, 200).join('\n').length;
};

const hippoBlockChars = (claudeMd) => {
  const text = fs.readFileSync(claudeMd, 'utf8');
  const at = text.indexOf('## Project Memory (Hippo)');
  if (at < 0) return 0;
  const next = text.slice(at + 3).search(/^## /m);
  return next < 0 ? text.length - at : next + 3;
};

const sections = (text) => {
  const out = [];
  for (const part of text.split(/^(?=## )/m)) if (HIPPO_HEAD.test(part)) out.push(part);
  return out;
};

/** Cost of one session transcript per arm, with the injection and compaction counts behind it. */
export const simulate = (file, memChars, blockChars) => {
  const zero = () => Object.fromEntries(ARMS.map((a) => [a, 0]));
  const cost = zero();
  let live = zero();
  let pending = zero();
  const add = (chars) => { for (const a of ARMS) pending[a] += chars[a] ?? 0; };
  const sent = new Map();
  const hippoCalls = new Map();
  const ids = new Set();
  const s = { calls: 0, injections: 0, compactions: 0, expiries: 0, cmdChars: 0, ctxChars: 0, injChars: 0, keptChars: 0 };
  let lastAt = Number.NaN;
  const openWindow = () => {
    live = zero();
    pending = zero();
    sent.clear();
    add({ now: blockChars, plan: blockChars, builtin: memChars, unit: 1 });
  };
  openWindow();
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue;
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    if (r.isSidechain === true) continue;
    if (r.type === 'system' && r.subtype === 'compact_boundary') { s.compactions++; openWindow(); continue; }
    const at = r.attachment;
    if (at?.type === 'hook_additional_context') {
      const text = Array.isArray(at.content) ? at.content.join('\n') : String(at.content);
      const parts = sections(text);
      if (parts.length === 0) continue;
      s.injections++;
      let now = 0;
      let plan = 0;
      for (const part of parts) {
        now += part.length;
        if (part.startsWith('## Session Handoff')) { plan += Math.min(part.length, POINTER); continue; }
        const perEntry = /^## (Project|Prompt-Relevant) Memory/.test(part);
        const life = part.startsWith('## Project Memory') ? PIN_REFRESH : MARK_LIFE;
        const keys = perEntry ? part.split('\n') : [part];
        for (const key of keys) {
          const entry = !perEntry || key.startsWith('- **');
          const last = sent.get(key);
          if (entry && last !== undefined && s.injections - last < life) continue;
          if (entry) sent.set(key, s.injections);
          plan += key.length + (perEntry ? 1 : 0);
        }
      }
      s.injChars += now;
      s.keptChars += plan;
      add({ now, plan });
      continue;
    }
    const content = r.message?.content;
    if (r.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        const command = c.type === 'tool_use' ? c.input?.command : undefined;
        const m = command ? HIPPO_CMD.exec(command) : null;
        if (m) hippoCalls.set(c.id, m[1]);
      }
    }
    if (r.type === 'user' && Array.isArray(content)) {
      for (const c of content) {
        const kind = c.type === 'tool_result' ? hippoCalls.get(c.tool_use_id) : undefined;
        if (!kind) continue;
        const body = Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('\n') : (c.content ?? '');
        s.cmdChars += body.length;
        if (kind === 'context') s.ctxChars += body.length;
        add({ now: body.length, plan: body.length });
      }
    }
    const id = r.type === 'assistant' ? r.message?.id : undefined;
    if (!id || ids.has(id) || r.message?.model === '<synthetic>') continue;
    ids.add(id);
    s.calls++;
    const t = Date.parse(r.timestamp);
    const expired = !Number.isNaN(lastAt) && t - lastAt > TTL;
    if (expired) s.expiries++;
    if (!Number.isNaN(t)) lastAt = t;
    for (const a of ARMS) {
      cost[a] += (expired ? WRITE : READ) * tok(live[a]) + WRITE * tok(pending[a]);
      live[a] += pending[a];
    }
    pending = zero();
  }
  return { cost, ...s };
};

const usd = (x) => `$${x.toFixed(2)}`;
const sum = (list, k) => list.reduce((a, r) => a + (k in r.cost ? r.cost[k] : r[k]), 0);
const report = (label, list) => {
  const [now, plan, builtin] = ['now', 'plan', 'builtin'].map((k) => sum(list, k));
  console.log(`${label}: sessions ${list.length}, calls ${sum(list, 'calls')} | hippo today ${usd(now)} | hippo under plan ${usd(plan)} | built-in ${usd(builtin)} | plan/built-in ${(100 * plan / builtin).toFixed(0)}%`);
};

function main() {
  const argv = process.argv;
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const root = flag('--projects', path.join(os.homedir(), '.claude', 'projects'));
  const days = Number(flag('--days', '14'));
  const claudeMd = flag('--claude-md', path.join(os.homedir(), 'CLAUDE.md'));
  const since = Date.now() - days * 864e5;
  const blockChars = hippoBlockChars(claudeMd);

  const rows = [];
  for (const proj of fs.readdirSync(root)) {
    const dir = path.join(root, proj);
    if (!fs.statSync(dir).isDirectory()) continue;
    const memChars = loadedMemory(path.join(dir, 'memory', 'MEMORY.md'));
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      if (!f.endsWith('.jsonl') || fs.statSync(file).mtimeMs < since) continue;
      const row = simulate(file, memChars, blockChars);
      if (row.injections > 0) rows.push({ ...row, memChars });
    }
  }

  const withMem = rows.filter((r) => r.memChars > 0);
  const mem = withMem.map((r) => r.memChars).sort((a, b) => a - b);
  console.log(`hippo CLAUDE.md block ${blockChars} chars; loaded MEMORY.md chars median ${mem[mem.length >> 1]}, max ${mem.at(-1)}`);
  console.log(`compactions ${sum(rows, 'compactions')}, cache expiries ${sum(rows, 'expiries')}, injections ${sum(rows, 'injections')}`);
  console.log(`hippo text chars: injected ${sum(rows, 'injChars')}, kept under plan ${sum(rows, 'keptChars')}; command output ${sum(rows, 'cmdChars')} (context calls ${sum(rows, 'ctxChars')})`);
  report('all sessions with hippo injections', rows);
  report('sessions whose project has a MEMORY.md', withMem);
  const byCalls = [...rows].sort((a, b) => b.calls - a.calls);
  report('longest 10% of sessions by calls', byCalls.slice(0, Math.ceil(rows.length / 10)));
  report('the other 90%', byCalls.slice(Math.ceil(rows.length / 10)));
  const unit = sum(rows, 'unit');
  console.log(`break-even MEMORY.md size: hippo today = built-in at ${Math.round(sum(rows, 'now') / unit)} chars; hippo under plan = built-in at ${Math.round(sum(rows, 'plan') / unit)} chars`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
