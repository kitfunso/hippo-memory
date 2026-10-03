// Pure helpers for the Z7 sub-agent lesson eval (prereg docs/evals/2026-10-03-z7-sidechain-gap-prereg.md). No fs, no child_process.
import crypto from 'node:crypto';

export const SEED_STRING = 'z7-2026-10-03';
export const DEV_SESSIONS = 12;
export const DEV_ITEMS = 24;
export const SESSION_CAP = 3;
export const CUTOFF_TS = '2026-10-02T00:00:00.000Z';
export const LIMITS = {
  A: 3000, B: 40000, errChars: 500, errMax: 20, windowEach: 8000, windowTotal: 16000,
  chunk: 150000, minAssistant: 200, evidenceWords: 6, reachPrefix: 120,
};
export const KINDS = ['error', 'correction', 'gotcha'];
export const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'];
const CUT_TEXT = '[middle of the work cut for length]';
export const CUT_MARK = `\n${CUT_TEXT}\n`;
const SENT = '\u0001';

// --- primitives ---

export const isStr = (v) => Object.prototype.toString.call(v) === '[object String]';
const isObj = (v) => v !== null && v instanceof Object;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rngFromString = (str) => mulberry32(parseInt(sha256(str).slice(0, 8), 16));

// Fisher-Yates from the top; the prereg fixes the seed and the stream, so this is the one shuffle.
export function shuffled(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Visits each parsed object line and returns how many non-blank lines were not JSON objects.
export function forEachEntry(text, visit) {
  let bad = 0, pos = 0, i = 0;
  while (pos <= text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end);
    pos = end + 1;
    i++;
    if (!line.trim()) continue;
    let e = null;
    try { e = JSON.parse(line); } catch { e = null; }
    if (isObj(e) && !Array.isArray(e)) visit(e, i); else bad++;
  }
  return bad;
}

const blocksOf = (c) => (Array.isArray(c) ? c.filter(isObj) : []);
export function contentText(c) {
  if (isStr(c)) return c;
  return blocksOf(c).filter((b) => b.type === 'text' && isStr(b.text)).map((b) => b.text).join('\n');
}
const resultsOf = (e) => blocksOf(e.message?.content).filter((b) => b.type === 'tool_result');
const resultText = (b) => contentText(b.content);

export const normText = (s) => s.toLowerCase().replace(/['"`‘’“”]/g, '').replace(/\s+/g, ' ').trim();
export const collapse = (s) => s.replace(/\s+/g, ' ').trim();
export const templateOf = (task) => collapse(task).slice(0, 120);
export const itemId = (session, file) => `${session}_${file.replace(/^agent-/, '').replace(/\.jsonl$/, '')}`;

// --- saves ---

const REMEMBER = /\bhippo\s+remember\b/i;
const MEMORY_FILES = new Set(['memory.md', 'claude.md', 'agents.md']);
export function isMemoryPath(p) {
  if (!isStr(p)) return false;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const last = (parts.pop() ?? '').toLowerCase();
  return MEMORY_FILES.has(last) || parts.some((s) => s.toLowerCase() === 'memory');
}

// Text an explicit save carries: a `hippo remember` command, or what a Write or Edit put into a memory path.
export function toolSaves(block) {
  if (block.type !== 'tool_use' || !isObj(block.input)) return [];
  const { name, input } = block;
  if (name === 'Bash' || name === 'PowerShell') return isStr(input.command) && REMEMBER.test(input.command) ? [input.command] : [];
  if (!isMemoryPath(input.file_path)) return [];
  const texts = name === 'Write' ? [input.content] : name === 'Edit' ? [input.new_string]
    : name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits.map((x) => x?.new_string) : [];
  return texts.filter((t) => isStr(t) && t.trim());
}

const SECTION_HEAD = /^[ \t>*#-]*(?:\d{1,2}\.\s*)?\**memories for hippo\b/im;
const SECTION_NEXT = /\n[ \t]{0,3}(?:#{1,4}\s|\d{1,2}\.\s+[A-Z])/;
// The "Memories for hippo" section of a compaction summary, '' when absent.
export function memoriesSection(text) {
  const m = SECTION_HEAD.exec(text);
  if (!m) return '';
  const rest = text.slice(m.index);
  const next = SECTION_NEXT.exec(rest.slice(m[0].length));
  return (next ? rest.slice(0, m[0].length + next.index) : rest).trim();
}

// --- sub-agent files ---

function startOfWork(st, e, isFork) {
  if (e.type !== 'user') return;
  if (isFork) {
    const text = contentText(e.message?.content).trimStart();
    if (!text.startsWith('<fork-boilerplate')) return;
    const close = text.indexOf('</fork-boilerplate>');
    st.task = close < 0 ? '' : text.slice(close + '</fork-boilerplate>'.length).trim();
    st.started = true;
  } else if (e.isMeta !== true && e.isCompactSummary !== true) {
    st.task = contentText(e.message?.content).trim();
    st.started = true;
  }
}

function flushRun(st) {
  if (!st.run.length) return;
  const reportId = st.reports.length;
  st.run.forEach((it) => { it.reportId = reportId; });
  st.reports.push(st.run.map((it) => it.text).join('\n'));
  st.run = [];
}

function subUser(st, e) {
  const results = resultsOf(e);
  if (results.length) {
    st.run = [];
    for (const r of results) {
      if (r.is_error !== true) continue;
      st.errorsTotal++;
      if (st.errorItems < LIMITS.errMax) { st.items.push({ kind: 'error', text: resultText(r).slice(0, LIMITS.errChars) }); st.errorItems++; }
    }
    return;
  }
  if (e.isCompactSummary === true) return;
  if (e.isMeta === true && contentText(e.message?.content).trimStart().startsWith('<system-reminder>')) return;
  flushRun(st);
}

function subAssistant(st, e) {
  const blocks = blocksOf(e.message?.content);
  const texts = blocks.filter((b) => b.type === 'text' && isStr(b.text) && b.text.trim()).map((b) => b.text.trim());
  const calls = blocks.filter((b) => b.type === 'tool_use');
  for (const c of calls) st.saves.push(...toolSaves(c));
  for (const t of texts) {
    const it = { kind: 'text', text: t };
    st.items.push(it);
    st.assistantChars += t.length;
    if (!calls.length) st.run.push(it);
  }
  if (calls.length) st.run = [];
}

// One sub-agent file: task, work items, reports (a turn's last text-only run), own saves and counts.
export function readSubAgent(text, meta) {
  const st = { started: false, task: null, items: [], run: [], reports: [], saves: [], errorsTotal: 0, errorItems: 0, assistantChars: 0, ordered: true, orderedConv: true };
  let lastTs = '', lastConv = '';
  const bad = forEachEntry(text, (e) => {
    if (isStr(e.timestamp)) {
      if (e.timestamp < lastTs) st.ordered = false;
      lastTs = e.timestamp;
      // Attachments, compaction summaries and meta lines replay old timestamps, so the conversation check skips them.
      if (e.type !== 'attachment' && !e.isCompactSummary && !e.isMeta) { if (e.timestamp < lastConv) st.orderedConv = false; lastConv = e.timestamp; }
    }
    if (!st.started) startOfWork(st, e, meta?.isFork === true);
    else if (e.type === 'user') subUser(st, e);
    else if (e.type === 'assistant') subAssistant(st, e);
  });
  flushRun(st);
  return { ...st, bad };
}

// Sub-agent JSONL after the fork boilerplate entry; the input unchanged when there is none.
export function stripForkPrefix(text) {
  let pos = 0;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end);
    if (line.includes('<fork-boilerplate')) {
      try {
        const e = JSON.parse(line);
        if (e.type === 'user' && contentText(e.message?.content).trimStart().startsWith('<fork-boilerplate')) return text.slice(end + 1);
      } catch { /* a damaged line is not the boundary */ }
    }
    pos = end + 1;
  }
  return text;
}

export function renderB(items, max = LIMITS.B) {
  const parts = [];
  const ranges = [];
  let off = 0;
  items.forEach((it, k) => {
    const head = it.kind === 'error' ? '[error]\n' : it.reportId !== undefined && it.reportId !== items[k - 1]?.reportId ? '[report]\n' : '';
    if (it.reportId !== undefined) ranges.push([off + head.length, off + head.length + it.text.length]);
    parts.push(head + it.text);
    off += head.length + it.text.length + 2;
  });
  const full = parts.join('\n\n');
  if (full.length <= max) return { B: full, ranges, cutChars: 0 };
  const head = Math.floor((max - CUT_MARK.length) / 2);
  const tail = max - CUT_MARK.length - head;
  const tailStart = full.length - tail;
  const shift = head + CUT_MARK.length - tailStart;
  const mapped = [];
  for (const [s, e] of ranges) {
    if (s < head) mapped.push([s, Math.min(e, head)]);
    if (e > tailStart) mapped.push([Math.max(s, tailStart) + shift, e + shift]);
  }
  return { B: full.slice(0, head) + CUT_MARK + full.slice(tailStart), ranges: mapped, cutChars: full.length - head - tail };
}

// --- parent files ---

function isHumanText(e, text) {
  const t = text.trimStart();
  if (!t || e.isMeta === true || e.promptSource === 'system') return false;
  return !/^<(?:task-notification|local-command-|command-name|command-message|command-args|ide_|system-reminder)/.test(t) && !t.startsWith('[Request interrupted by user');
}

function parentAssistant(m, e, i) {
  for (const b of blocksOf(e.message?.content)) {
    if (b.type === 'text' && isStr(b.text) && b.text.trim()) {
      m.texts.push({ i, text: b.text.trim() });
      m.stream.push({ i, kind: 'text', text: b.text.trim() });
    } else if (b.type === 'tool_use') {
      if (b.name === 'Agent' && isStr(b.id)) m.agentCalls.set(b.id, i);
      const brief = b.name === 'Agent' ? b.input?.prompt : b.name === 'SendMessage' ? (isStr(b.input?.message) ? b.input.message : b.input?.content) : null;
      if (isStr(brief) && brief.trim()) m.stream.push({ i, kind: 'brief', text: brief });
      for (const s of toolSaves(b)) m.stream.push({ i, kind: 'save', text: s });
    }
  }
}

function parentUser(m, e, i, pending) {
  const content = e.message?.content;
  if (e.isCompactSummary === true) {
    const sec = memoriesSection(contentText(content));
    if (sec) m.stream.push({ i, kind: 'save', text: sec });
    return;
  }
  const results = resultsOf(e);
  const text = results.length ? results.map(resultText).join('\n') : contentText(content);
  const notice = text.trimStart().startsWith('<task-notification');
  if (!results.length && isHumanText(e, text)) m.humans.push(i);
  if (!results.length && !notice) return;
  const norm = normText(text);
  for (const p of pending) {
    if (p.arrival === null && p.prefix && m.agentCalls.has(p.toolUseId) && norm.includes(p.prefix)) p.arrival = i;
  }
}

// Parent transcript: ordered parent side, assistant text, human-message positions, and the first arrival of each pending report.
export function readParent(text, pending = []) {
  const m = { stream: [], texts: [], humans: [], agentCalls: new Map(), cwds: {}, lastTs: '' };
  m.bad = forEachEntry(text, (e, i) => {
    if (isStr(e.timestamp) && e.timestamp > m.lastTs) m.lastTs = e.timestamp;
    if (isStr(e.cwd)) m.cwds[e.cwd] = (m.cwds[e.cwd] ?? 0) + 1;
    if (e.isSidechain === true) return;
    if (e.type === 'assistant') parentAssistant(m, e, i);
    else if (e.type === 'user') parentUser(m, e, i, pending);
  });
  return m;
}

export const reportPrefix = (report) => normText(report).slice(0, LIMITS.reachPrefix);

// Parent assistant text after each arrival up to the next human message; 8,000 chars each, 16,000 in all.
export function buildWindows(m, arrivals) {
  const windows = [];
  let used = 0, cut = 0;
  for (const a of [...arrivals].sort((x, y) => x - y)) {
    const next = m.humans.find((h) => h > a) ?? Infinity;
    const full = m.texts.filter((t) => t.i > a && t.i < next).map((t) => t.text).join('\n\n');
    const room = LIMITS.windowTotal - used;
    const piece = full.slice(0, Math.min(LIMITS.windowEach, Math.max(room, 0)));
    if (piece.length < full.length) cut++;
    if (piece) { windows.push(piece); used += piece.length; }
  }
  return { windows, cut };
}

// The most frequent cwd cut to the folder under home, with -wt-* and -worktree* suffixes removed.
export function workingProject(cwds, home) {
  const top = Object.entries(cwds).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]?.[0];
  if (!top) return '';
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const h = norm(home), c = norm(top);
  const segs = (c.startsWith(`${h}/`) ? c.slice(h.length + 1) : c === h ? '~' : c).split('/').filter(Boolean);
  return (segs[0] ?? '').replace(/-wt-.*$/, '').replace(/-worktree.*$/, '');
}

export const dedupeSaves = (stream) => [...new Set(stream.filter((s) => s.kind === 'save').map((s) => s.text))];

export function renderC(captureItems, windows, saves) {
  const list = (xs, f) => (xs.length ? xs.map(f).join('\n') : '(none)');
  return [
    "[Items the parent session's memory system captured]", list(captureItems, (t) => `- ${t}`),
    '', '[Parent messages after each report arrived]', list(windows, (w, k) => `(window ${k + 1})\n${w}`),
    '', '[Notes saved by hand]', list(saves, (s) => `- ${s}`),
  ].join('\n');
}

// Parent side for the recheck: session order, then the capture items and the sub-agent's own saves.
export const parentSideSegments = (stream, captureItems, ownSaves, extra = []) => [...stream.map((s) => s.text), ...captureItems, ...ownSaves, ...extra];

// --- draw ---

export function drawSplit(items, seedString = SEED_STRING) {
  const rng = rngFromString(seedString);
  const sessions = [...new Set(items.map((i) => i.session))].sort(cmp);
  const order = shuffled(sessions, rng);
  const dev = new Set(order.slice(0, DEV_SESSIONS));
  const walk = shuffled([...items].sort((a, b) => cmp(a.session, b.session) || cmp(a.file, b.file)), rng);
  const taken = new Map();
  const out = [];
  for (const it of walk) {
    const t = taken.get(it.session) ?? { n: 0, tpl: new Set() };
    if (t.n >= SESSION_CAP || t.tpl.has(it.template)) continue;
    t.n++;
    t.tpl.add(it.template);
    taken.set(it.session, t);
    out.push(it);
  }
  return {
    seedHex: sha256(seedString).slice(0, 8),
    devSessions: order.slice(0, DEV_SESSIONS),
    scoredSessions: order.slice(DEV_SESSIONS),
    dev: out.filter((i) => dev.has(i.session)).slice(0, DEV_ITEMS),
    scored: out.filter((i) => !dev.has(i.session)),
  };
}

// --- recheck: chunks and decoys ---

export function chunkSegments(segments, limit = LIMITS.chunk) {
  const chunks = [];
  let cur = '';
  const push = () => { if (cur) { chunks.push(cur); cur = ''; } };
  for (const seg of segments) {
    for (let at = 0; at < seg.length; at += limit) {
      const piece = seg.slice(at, at + limit);
      if (cur && cur.length + 2 + piece.length > limit) push();
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  push();
  return chunks.length ? chunks : [''];
}

// Inserts the sentence as one line at a seeded line of one seeded chunk.
export function plantDecoy(chunks, sentence, rng) {
  const k = Math.floor(rng() * chunks.length);
  const lines = chunks[k].split('\n');
  lines.splice(Math.floor(rng() * (lines.length + 1)), 0, sentence);
  return { chunks: chunks.map((c, j) => (j === k ? lines.join('\n') : c)), chunkIdx: k };
}

// pool: [{id, session, project, lessons:[{kind,text}]}]; prefers another project, then another kind, then another session (flagged).
export function pickDecoy(pool, subject, rng) {
  const kinds = new Set(subject.kinds);
  const otherProject = (p) => p.project !== subject.project;
  const otherSession = (p) => p.session !== subject.session;
  const tiers = [[null, otherProject, true], [null, otherProject, false], ['other-session', otherSession, true], ['other-session', otherSession, false]];
  const sorted = [...pool].sort((a, b) => cmp(a.id, b.id));
  for (const [flag, ok, kindDiffers] of tiers) {
    const cands = sorted.filter((p) => p.id !== subject.id && ok(p)).flatMap((p) => p.lessons.filter((l) => !kindDiffers || !kinds.has(l.kind)));
    if (cands.length) return { lesson: cands[Math.floor(rng() * cands.length)], flag };
  }
  return null;
}

// Real lessons plus, when given, one decoy at a seeded position: the list the recheck numbers.
export function recheckList(real, decoy, rng) {
  const list = real.map((l) => ({ ...l }));
  if (!decoy) return { list, decoyIdx: -1 };
  const decoyIdx = Math.floor(rng() * (list.length + 1));
  list.splice(decoyIdx, 0, { src: 'decoy', kind: decoy.kind, text: decoy.text });
  return { list, decoyIdx };
}

// --- judge replies ---

export function parseJsonReply(stdout) {
  const t = (stdout ?? '').replace(/```(?:json)?/gi, '').trim();
  for (const s of [t, t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) {
    try { const v = JSON.parse(s); if (isObj(v) && !Array.isArray(v)) return v; } catch { /* next candidate */ }
  }
  return null;
}

export function parseLessons(stdout) {
  const o = parseJsonReply(stdout);
  if (!o || !Array.isArray(o.lessons)) return { ok: false, lessons: [] };
  const lessons = o.lessons.filter((l) => isObj(l) && isStr(l.text) && l.text.trim()).map((l) => ({
    kind: KINDS.includes(String(l.kind).toLowerCase()) ? String(l.kind).toLowerCase() : 'other',
    text: l.text.trim(),
    evidence: isStr(l.evidence) ? l.evidence : '',
  }));
  return { ok: true, lessons };
}

export function parseKept(stdout, n) {
  const o = parseJsonReply(stdout);
  if (!o || !Array.isArray(o.kept)) return { ok: false, kept: [] };
  return { ok: true, kept: [...new Set(o.kept.filter((k) => Number.isInteger(k) && k >= 0 && k < n))] };
}

export function parseRuleLabels(stdout, n) {
  const o = parseJsonReply(stdout);
  if (!o || !Array.isArray(o.labels)) return { ok: false, labels: [] };
  const labels = Array.from({ length: n }, () => false);
  for (const l of o.labels) {
    if (isObj(l) && Number.isInteger(l.i) && l.i >= 0 && l.i < n) labels[l.i] = l.durable === true && l.unrecoverable === true && l.writable === true;
  }
  return { ok: true, labels };
}

// --- evidence ---

export const evidenceHaystack = (B) => normText(B.replaceAll('[report]', SENT).replaceAll('[error]', SENT).replaceAll(CUT_TEXT, SENT));

export function evidenceOk(evidence, normA, normB) {
  const e = normText(evidence);
  return e.split(' ').filter(Boolean).length >= LIMITS.evidenceWords && normB.includes(e) && !normA.includes(e);
}

export function verifyLessons(lessons, A, B) {
  const nA = normText(A), nB = evidenceHaystack(B);
  const kept = [], failed = [];
  for (const l of lessons) (evidenceOk(l.evidence, nA, nB) ? kept : failed).push(l);
  return { kept, failed };
}

export function inReport(evidence, B, ranges) {
  const only = ranges.map(([s, e]) => B.slice(s, e)).join(SENT);
  return normText(only).includes(normText(evidence));
}

// --- statistics and verdict ---

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))];
export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// rows: [{cluster, hit}]; resamples whole clusters and takes hits over items.
export function clusterBootstrap(rows, seed = 'z7-boot', resamples = 2000) {
  const by = new Map();
  for (const r of rows) {
    const g = by.get(r.cluster) ?? [0, 0];
    g[0] += r.hit ? 1 : 0;
    g[1] += 1;
    by.set(r.cluster, g);
  }
  const groups = [...by.entries()].sort((a, b) => cmp(a[0], b[0])).map((x) => x[1]);
  const n = rows.length;
  const p = n ? rows.filter((r) => r.hit).length / n : 0;
  if (!groups.length) return { p, lo: 0, hi: 0, n, clusters: 0, width: 0 };
  const rng = rngFromString(seed);
  const ps = [];
  for (let b = 0; b < resamples; b++) {
    let k = 0, m = 0;
    for (let g = 0; g < groups.length; g++) { const [hits, size] = groups[Math.floor(rng() * groups.length)]; k += hits; m += size; }
    ps.push(k / m);
  }
  ps.sort((a, b) => a - b);
  const lo = quantile(ps, 0.025), hi = quantile(ps, 0.975);
  return { p, lo, hi, n, clusters: groups.length, width: hi - lo };
}

export function cohenKappa(a, b) {
  const n = a.length;
  if (!n) return null;
  const share = (xs) => xs.filter(Boolean).length / n;
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pe = share(a) * share(b) + (1 - share(a)) * (1 - share(b));
  return pe === 1 ? null : (po - pe) / (1 - pe);
}

export function verdict(ci, unionCi, valid) {
  if (!valid) return 'INVALID';
  if (ci.lo >= 0.2) return 'BUILD';
  if (ci.hi < 0.1 && unionCi.hi < 0.1) return 'DROP';
  return 'INCONCLUSIVE';
}

const frac = (k, n) => (n ? k / n : null);
const test = (v, f) => (v === null ? null : f(v));

// A control call that failed to parse is no negative result: under 90% of the control items parsed by both judges fails G4.
function controlG4(c) {
  if (c.parsed < Math.ceil(c.total * 0.9)) return false;
  return test(frac(c.hits, c.parsed), (r) => r <= 0.1);
}

// ctl: {model: {id: {ok, verified}}}; G4 counts only items where both judges parsed.
export function controlFigures(ctl, ids) {
  const [m1, m2] = MODELS;
  const ok = (m, id) => ctl[m][id]?.ok === true;
  const hit = (m, id) => (ctl[m][id]?.verified ?? []).length > 0;
  const parsed = ids.filter((id) => ok(m1, id) && ok(m2, id));
  return {
    total: ids.length, parsed: parsed.length, hits: parsed.filter((id) => hit(m1, id) && hit(m2, id)).length,
    parse: { sonnet: [ids.filter((id) => ok(m1, id)).length, ids.length], opus: [ids.filter((id) => ok(m2, id)).length, ids.length] },
  };
}

// s holds [hits, total] pairs per gate; a gate with nothing to measure is null (untested), never a silent pass.
export function gateResults(s) {
  const parse = ([k, n]) => test(frac(k, n), (r) => r >= 0.95);
  const cp = s.control?.parse ?? { sonnet: [0, 0], opus: [0, 0] };
  const withControl = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const evid = ([k, n]) => test(frac(k, n), (r) => r <= 0.3);
  return {
    G1: s.isolation,
    G2: { sonnet: parse(withControl(s.parse.sonnet, cp.sonnet)), opus: parse(withControl(s.parse.opus, cp.opus)), recheck: parse(s.parse.recheck) },
    G3: { sonnet: evid(s.evidenceFail.sonnet), opus: evid(s.evidenceFail.opus) },
    G4: s.control ? controlG4(s.control) : null,
    G5: test(frac(...s.unplanted), (r) => r <= 0.15),
    G6: test(frac(...s.planted), (r) => r >= 0.85),
  };
}

export function gatesValid(g) {
  return [g.G1, ...Object.values(g.G2), ...Object.values(g.G3), g.G4, g.G5, g.G6].every((v) => v !== false);
}

export function agentClass(agentType) {
  if (agentType === 'general-purpose' || agentType === 'worker') return agentType;
  return /review/i.test(agentType ?? '') ? 'reviewer' : 'other';
}

// items: [{id, session, agentType, cut}]; judge: {model: {id: {ok, returned, failed, verified}}}; recheck: {id: {keptKeys, callsTotal, callsOk, decoy, decoyKept}}.
export function figures(items, judge, recheck) {
  const [m1, m2] = MODELS;
  const keptKeys = (id) => recheck[id]?.keptKeys ?? [];
  const surviving = (id, model) => (judge[model][id]?.verified ?? []).filter((_, k) => !keptKeys(id).includes(`${model}:${k}`));
  const rows = items.map((it) => {
    const s1 = surviving(it.id, m1), s2 = surviving(it.id, m2);
    const v1 = (judge[m1][it.id]?.verified ?? []).length > 0, v2 = (judge[m2][it.id]?.verified ?? []).length > 0;
    return { ...it, v1, v2, s1, s2, bothBefore: v1 && v2, both: s1.length > 0 && s2.length > 0, either: s1.length > 0 || s2.length > 0 };
  });
  const bearing = rows.filter((r) => r.both);
  const rc = Object.values(recheck);
  const dec = (state) => rc.filter((r) => r.decoy === state);
  const calls = (model) => Object.values(judge[model]);
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  const kindMix = {}, byClass = {};
  for (const r of rows) {
    for (const l of [...r.s1, ...r.s2]) kindMix[l.kind] = (kindMix[l.kind] ?? 0) + 1;
    const c = agentClass(r.agentType);
    byClass[c] = byClass[c] ?? [0, 0];
    byClass[c][1]++;
    if (r.both) byClass[c][0]++;
  }
  const parse = (model) => [calls(model).filter((c) => c.ok).length, calls(model).length];
  const evid = (model) => [sum(calls(model), (c) => c.failed), sum(calls(model), (c) => c.returned)];
  return {
    n: rows.length,
    rows,
    pBefore: rows.filter((r) => r.bothBefore).length,
    consensus: bearing.length,
    union: rows.filter((r) => r.either).length,
    perJudge: { [m1]: rows.filter((r) => r.s1.length).length, [m2]: rows.filter((r) => r.s2.length).length },
    overturned: sum(rc, (r) => r.keptKeys.length),
    inReport: bearing.filter((r) => [...r.s1, ...r.s2].some((l) => l.inReport)).length,
    kappa: cohenKappa(rows.map((r) => r.v1), rows.map((r) => r.v2)),
    lessonsPerItem: { [m1]: frac(sum(rows, (r) => r.s1.length), rows.length), [m2]: frac(sum(rows, (r) => r.s2.length), rows.length) },
    kindMix,
    byClass,
    cutShare: frac(rows.filter((r) => r.cut).length, rows.length),
    parse: { sonnet: parse(m1), opus: parse(m2), recheck: [sum(rc, (r) => r.callsOk), sum(rc, (r) => r.callsTotal)] },
    evidenceFail: { sonnet: evid(m1), opus: evid(m2) },
    unplanted: [dec('unplanted').filter((r) => r.decoyKept).length, dec('unplanted').length],
    planted: [dec('planted').filter((r) => r.decoyKept).length, dec('planted').length],
    decoySkipped: dec('skipped').length,
  };
}

// A BUILD stands only if at least 75% of the audited sample is confirmed; every other verdict is unchanged.
export function finalizeAudit(preliminary, n, confirmed) {
  const stands = n > 0 && confirmed * 4 >= n * 3;
  return { sampleN: n, confirmed, share: n ? confirmed / n : null, preliminary, final: preliminary === 'BUILD' && !stands ? 'INCONCLUSIVE' : preliminary };
}

export function buildDraw(eligible) {
  const d = drawSplit(eligible);
  const ids = (xs) => xs.map((it) => itemId(it.session, it.file));
  const items = {};
  for (const it of [...d.dev, ...d.scored]) items[itemId(it.session, it.file)] = { session: it.session, file: it.file, agentType: it.agentType, project: it.project };
  const scored = ids(d.scored);
  return {
    seedString: SEED_STRING, seedHex: d.seedHex, eligibleSubs: eligible.length, eligibleSessions: new Set(eligible.map((i) => i.session)).size,
    devSessions: d.devSessions, scoredSessions: d.scoredSessions, dev: ids(d.dev), scored, items, itemListSha256: sha256(scored.join('\n')),
  };
}

// Returns why a stored draw.json cannot stand against the recomputed draw and the prereg's list pin, or null.
export function drawMismatch(fresh, stored, pinSha) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(fresh.dev, stored.dev)) return 'the dev list differs from the recomputed draw';
  if (!same(fresh.scored, stored.scored)) return 'the scored list differs from the recomputed draw';
  const ids = Object.keys(fresh.items);
  const wrong = ids.find((id) => !same(fresh.items[id], stored.items?.[id]));
  if (wrong) return `the items mapping differs for ${wrong}`;
  if (ids.length !== Object.keys(stored.items ?? {}).length) return 'the items mapping has a different set of ids';
  const field = Object.keys(fresh).find((k) => !same(fresh[k], stored[k]));
  if (field) return `the ${field} field differs from the recomputed draw`;
  if (fresh.itemListSha256 !== pinSha || stored.itemListSha256 !== pinSha) return 'the scored list sha256 differs from the prereg pin';
  return null;
}

export const PIN_DIST = ['capture.js', 'same-text.js', 'secret-detect.js'];
export const PIN_PROMPTS = ['judge-prompt.txt', 'judge-system.txt', 'recheck-prompt.txt', 'rule-arm-prompt.txt'];

// Reads the prereg's "## Pins" section: hashes keyed by file name, the two list pins and the claude version.
export function parsePins(md) {
  const at = md.indexOf('\n## Pins');
  const rest = at < 0 ? '' : md.slice(at + 1);
  const end = rest.indexOf('\n## ', 3);
  const sec = end < 0 ? rest : rest.slice(0, end);
  const named = (ext) => Object.fromEntries([...sec.matchAll(/`([\w.-]+)`\s+`([0-9a-f]{64})`/g)].filter((m) => m[1].endsWith(ext)).map((m) => [m[1], m[2]]));
  const one = (re) => re.exec(sec)?.[1] ?? null;
  return {
    dist: named('.js'), prompts: named('.txt'),
    manifest: one(/Snapshot manifest SHA-256\s+`([0-9a-f]{64})`/), scoredList: one(/scored item list SHA-256\s+`([0-9a-f]{64})`/),
    claude: one(/`claude --version`:\s*(\d+(?:\.\d+)*)/),
  };
}

// The leading version token must stand alone, so 2.1.2880 and 2.1.288-dev are not 2.1.288.
export const claudeVersionToken = (out) => /^\s*(\d+(?:\.\d+)*)(?=\s|$)/.exec(String(out))?.[1] ?? null;

// Checks only the keys given in actual; a pin that is missing counts as a mismatch. Returns the mismatched names.
export function checkPins(pins, actual, promptNames = PIN_PROMPTS) {
  const bad = [];
  for (const [group, names] of [['dist', PIN_DIST], ['prompts', promptNames]]) {
    if (!actual[group]) continue;
    for (const n of names) if (!pins[group][n] || pins[group][n] !== actual[group][n]) bad.push(group === 'dist' ? `dist/${n}` : n);
  }
  for (const k of ['manifest', 'scoredList']) if (k in actual && (!pins[k] || pins[k] !== actual[k])) bad.push(k);
  if ('claude' in actual && (!pins.claude || claudeVersionToken(actual.claude) !== pins.claude)) bad.push('claude --version');
  return bad;
}
