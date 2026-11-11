#!/usr/bin/env node
/** Round 4 prereg item 9 (Amendment B): the hook hold and the sensitivity drop list, for the sessions of the design's `hookHold` arms.
 * Under a design with no round 4 arm it reads Claude Code transcripts (`--run`); under round 4 it reads the records' `hookCancels` (`--runs`).
 * Exit 0 on a hold line or a file, 1 on bad input. */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { designByName, isRound4Design } from './arms.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { linesOf, parseFlags, parseOrNull, runCommand, runMain } from './free-cli.mjs';
import { findTranscript } from './records.mjs';
import { positionKey } from './z0-records.mjs';

const USAGE = 'usage: z0-hookhold.mjs --design r3|r4 (--run OUT [--run OUT ...] | --runs FILE [--runs FILE ...]) (--hold | --sensitivity FILE)';
const SPEC = { values: ['--design', '--sensitivity'], lists: ['--run', '--runs'], switches: ['--hold'], required: ['--design'] };
const EVENT = 'UserPromptSubmit';
const WINDOW = 50;
// Prereg Amendment B: the arms lost more than this share of their last sessions' prompt hooks, so the run waits.
const HOLD_ABOVE = 0.02;

const attachmentOf = (line) => parseOrNull(line)?.attachment;

/** Whether the session's first prompt-hook attachment was a cancelled one. */
function firstPromptHookCancelled(text) {
  for (const line of linesOf(text)) {
    if (!line.includes(EVENT)) continue;
    const a = attachmentOf(line);
    if (a?.hookEvent === EVENT || a?.hookName === EVENT) return a.type === 'hook_cancelled';
  }
  return false;
}

/** Whether any prompt-hook attachment of the session was cancelled. */
const anyPromptHookCancelled = (text) => linesOf(text).some((line) => {
  const a = line.includes(EVENT) ? attachmentOf(line) : undefined;
  return a?.type === 'hook_cancelled' && String(a.hookEvent || a.hookName || '').includes(EVENT);
});

/** The `hookHold` arms' records with a session id, in read order: each source in turn, each file line by line.
 * @param {{file: string, out: string | null}[]} sources `out` is the run folder whose transcripts hold the sessions, null under round 4 */
function sessionsOf(sources, design) {
  const arms = new Set(design.hookHold);
  const found = [];
  for (const { file, out } of sources) {
    const mtime = fs.statSync(file).mtimeMs;
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.trim() === '') return;
      const r = parseOrNull(line);
      if (r === null) throw new Error(`${file} line ${i + 1}: not JSON`);
      // `line` is the index within its own file, as r3-hookhold.py counts it.
      if (arms.has(r.arm) && r.sessionId) found.push({ r, out, at: r.startedAt || '', mtime: 'startedAt' in r ? 0 : mtime, line: i });
    });
  }
  return found;
}

/** The session's transcript text, null when the run folder holds none. */
function transcriptOf({ r, out }) {
  const file = findTranscript(path.join(out, 'runs', r.sequence, r.arm, `seed${r.seed}`, 'claude-config', 'projects'), r.sessionId);
  return file === null ? null : fs.readFileSync(file, 'utf8');
}

/** Whether the session lost its prompt hook; `any` reads every attachment of a transcript, otherwise its first. */
function lost(session, any) {
  if (session.out === null) return session.r.hookCancels?.[EVENT] > 0;
  const text = transcriptOf(session);
  if (text === null) return false;
  return any ? anyPromptHookCancelled(text) : firstPromptHookCancelled(text);
}

/** The hold's order: startedAt, then the file's mtime for a record with no startedAt key, then the line; the stable sort keeps argument order after that. */
const byHoldOrder = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.mtime - b.mtime || a.line - b.line);

function holdLine(sessions) {
  const last = sessions.filter((s) => s.r.kind === 'apply').sort(byHoldOrder).slice(-WINDOW);
  const cancelled = last.filter((s) => lost(s, false)).length;
  return `${cancelled / last.length > HOLD_ABOVE ? 'hold' : 'ok'} ${cancelled} of ${last.length}\n`;
}

function sensitivityFile(sessions, file) {
  const voids = new Map();
  for (const s of sessions) if (lost(s, true)) voids.set(positionKey(s.r), { sequence: s.r.sequence, seed: s.r.seed, position: s.r.position });
  writeFileAtomic(file, `${JSON.stringify({ droppedLessons: [], droppedFamilies: [], hookVoids: [...voids.values()] }, null, 2)}\n`);
  return `${sessions.length} sessions, ${voids.size} positions dropped\n`;
}

/** @param {string[]} argv @param {string} [cwd] */
export function runCli(argv, cwd = process.cwd()) {
  return runCommand(() => {
    const args = parseFlags(argv, SPEC, USAGE);
    const design = designByName(args.design);
    const [wanted, other] = isRound4Design(design) ? [args.runs, args.run] : [args.run, args.runs];
    if (wanted.length === 0 || other.length > 0) throw new Error(`design ${args.design} reads ${isRound4Design(design) ? '--runs files' : '--run folders'} only\n${USAGE}`);
    if (args.hold === (args.sensitivity !== null)) throw new Error(`give --hold or --sensitivity, not both and not neither\n${USAGE}`);
    const sources = wanted.map((w) => path.resolve(cwd, w)).map((w) => (isRound4Design(design) ? { file: w, out: null } : { file: path.join(w, 'runs.jsonl'), out: w }));
    const sessions = sessionsOf(sources, design);
    return args.hold ? holdLine(sessions) : sensitivityFile(sessions, path.resolve(cwd, args.sensitivity));
  });
}

runMain(import.meta.url, runCli);
