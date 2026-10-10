// Pure checks and parsers for what the hippo CLI printed or wrote during a Z6 run; none of them spawns or touches disk.
import path from 'node:path';
import { esc } from './fixture.mjs';

// Pure predicate so the guard is selftest-able without creating any directory (R11, R18).
function rootBaseOk(rel) {
  return rel !== '' && !path.isAbsolute(rel) && !rel.startsWith('..');
}

// Exit 0 alone proves nothing: a failed child is caught and counted, and a workspace without .hippo is skipped silently.
function dailyRunnerOk(lastLine) {
  const m = /^Daily maintenance complete: (\d+) workspaces? processed, (\d+) command failures?\.$/.exec(lastLine ?? '');
  return Boolean(m) && Number(m[1]) === 1 && Number(m[2]) === 0;
}

// Pure so R18's log-shape cases run in --selftest with no spawn; the poll regex only proves the run ended, not that it ended well.
function parseWorkerLog(txt) {
  if (/skip capture: no transcript|No transcript found|had no user\/assistant messages|skip: no session_id/.test(txt)) return { ok: false, reason: 'misfed' };
  if (!txt.includes('[hippo] sleep complete') || !txt.includes('[hippo] capture complete')) return { ok: false, reason: 'incomplete' };
  const outcomeMatches = txt.match(/No actionable items found in the input\.|Captured \d+ items \(/g) ?? [];
  if (outcomeMatches.length !== 1) return { ok: false, reason: 'outcome-count' };
  if (txt.includes('No actionable items found in the input.')) return { ok: true, outcome: { type: 'no-cue' } };
  const m = /Captured (\d+) items \((\d+) skipped as duplicates(?:, (\d+) rejected)?\)/.exec(txt);
  if (!m) return { ok: false, reason: 'unrecognized' };
  return { ok: true, outcome: { type: 'captured', n: Number(m[1]), m: Number(m[2]), r: m[3] === undefined ? 0 : Number(m[3]) } };
}

// The exact seven commands hook install claude-code writes (src/hooks.ts:765-879); any other command voids the run.
function checkHooks(settings) {
  const got = Object.entries(settings.hooks ?? {}).flatMap(([ev, list]) =>
    (Array.isArray(list) ? list : []).flatMap((m) => (m.hooks ?? []).map((h) => ({ ev, matcher: m.matcher ?? '', command: h.command }))));
  const one = (ev, matcher, re) => {
    const hits = got.filter((h) => h.ev === ev && h.matcher === matcher && re.test(h.command ?? ''));
    if (hits.length !== 1) throw new Error(`hook mismatch: ${ev}${matcher ? ` (${matcher})` : ''} command not as expected`);
    return re.exec(hits[0].command);
  };
  const logPath = one('SessionEnd', '', /^hippo session-end --log-file "(.+)"$/)[1];
  one('SessionStart', '', new RegExp(`^hippo last-sleep --path "${esc(logPath)}"$`));
  one('SessionStart', 'compact', /^hippo compact-resume$/);
  one('UserPromptSubmit', '', /^hippo context --pinned-only --include-recent 5 --format additional-context$/);
  const compactLog = one('PreCompact', '', /^hippo pre-compact --log-file "(.+)"$/)[1];
  one('PostCompact', '', new RegExp(`^hippo post-compact --log-file "${esc(compactLog)}"$`));
  one('PostToolUseFailure', '.*', /^hippo capture-error$/);
  if (got.length !== 7) throw new Error(`hook mismatch: ${got.length} commands installed, want 7`);
  return { logPath };
}

// --- recall output parsing ---

// matchAll (not match) so every "--- id [" line counts; match() alone silently keeps only the first (R19).
function parseRankedIds(stdout) {
  return [...stdout.matchAll(/^--- (\S+) \[/gm)].map((m) => m[1]);
}

// --- explain parsing ---

function parseExplainBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\[(\d+)\] (\S+)\s/.exec(line);
    if (m) { if (cur) blocks.push(cur); cur = { id: m[2], lines: [line] }; continue; }
    if (line.startsWith('Note:')) { if (cur) blocks.push(cur); cur = null; continue; }
    if (cur) cur.lines.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks.map((b) => ({ id: b.id, text: b.lines.join('\n') }));
}

export { rootBaseOk, dailyRunnerOk, parseWorkerLog, checkHooks, parseRankedIds, parseExplainBlocks };
