#!/usr/bin/env node
// Fails when src/ gains a process.exit call outside the list below: a CLI verb stops its command by throwing CliExit
// (src/cli/exit.ts), so runCli stays the one place that picks the exit code and every caller's cleanup still runs.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripComments } from './lib/source-text.mjs';

const OTHER_PR = 'owned by an open pull request';

/** Files under src/ that may call process.exit, each with how many calls and why. A count may fall, never rise. */
export const ALLOWED = {
  'cli.ts': { count: 2, reason: 'the entry: one exit for a thrown CliExit, one for any other error' },
  'util/crash-handlers.ts': { count: 1, reason: 'ends the process after a crash or a signal, where no command is left to unwind' },
  'server/sleep-child.ts': { count: 1, reason: 'ends the forked sleep child once its reply is sent' },
  'cli/session-hooks.ts': { count: 3, reason: 'child-process event callbacks of the Codex wrapper, where a throw has no caller' },
  'cli/slack.ts': { count: 1, reason: 'catch callback of a promise chain nothing awaits, where a throw has no caller' },
  'cli/shared.ts': { count: 2, reason: OTHER_PR },
  'capture/command.ts': { count: 4, reason: OTHER_PR },
  'capture/compact.ts': { count: 1, reason: OTHER_PR },
};

const CALL = /\bprocess\s*(?:\?\.|\.)\s*exit\s*\(|\bprocess\s*\[\s*['"`]exit['"`]\s*\]\s*\(/g;

/**
 * Returns the 1-based line number of every process.exit call in a source text, one entry per call.
 * @param {string} text
 * @returns {number[]}
 */
export function processExitLines(text) {
  return stripComments(text)
    .split('\n')
    .flatMap((line, i) => Array.from(line.matchAll(CALL), () => i + 1));
}

function listSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSourceFiles(p));
    else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Finds every process.exit call in srcDir that the list does not cover: all calls of an unlisted file, and all
 * calls of a listed file that holds more than its count (the script cannot tell which one is new).
 * @param {string} srcDir
 * @param {Record<string, { count: number, reason: string }>} [allowed]
 * @returns {{ file: string, line: number, found: number, allowed: number }[]}
 */
export function findProcessExits(srcDir, allowed = ALLOWED) {
  const root = resolve(srcDir);
  return listSourceFiles(root)
    .map((p) => [relative(root, p).replace(/\\/g, '/'), p])
    .flatMap(([file, p]) => {
      const lines = processExitLines(readFileSync(p, 'utf8'));
      const limit = Object.hasOwn(allowed, file) ? allowed[file].count : 0;
      return lines.length > limit ? lines.map((line) => ({ file, line, found: lines.length, allowed: limit })) : [];
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcDir = process.argv[2] ?? 'src';
  const hits = findProcessExits(srcDir);
  if (hits.length > 0) {
    console.error(`\nprocess.exit calls in ${srcDir}/ beyond the allowed list:`);
    for (const h of hits) console.error(`  ${srcDir}/${h.file}:${h.line} (${h.found} in this file, ${h.allowed} allowed)`);
    console.error('\nFix: print the message, then `throw new CliExit(code)` from src/cli/exit.ts; runCli exits with that code.');
    console.error('A call that must end the process itself goes in ALLOWED in this script, with its count and reason.\n');
    process.exit(1);
  }
  const total = Object.values(ALLOWED).reduce((sum, entry) => sum + entry.count, 0);
  console.log(`process.exit in ${srcDir}/ stays within the ${Object.keys(ALLOWED).length} listed files (${total} calls allowed). OK.`);
}
