// The hippo build and tool versions every Z0 record names, and the --pins check that keeps chunked calibration runs on one build.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { REPO, git } from './exec.mjs';
import { claudeVersionToken } from '../z7-sidechain-lib.mjs';

/** sha256 over every file under dir: relative path, size and bytes, in path order. */
export function treeHash(dir) {
  const h = createHash('sha256');
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort();
  for (const f of files) {
    const bytes = fs.readFileSync(path.join(dir, f));
    h.update(`${f}\0${bytes.length}\0`).update(bytes);
  }
  return h.digest('hex');
}

/** The hippo that A2, A5 and X2 run: the runner checkout's commit, whether its tree differs from that commit, and its dist/ hash. */
export function hippoBuild(repo = REPO) {
  return {
    hippoCommit: git(['rev-parse', 'HEAD'], repo).trim(),
    hippoDirty: git(['status', '--porcelain'], repo).trim() !== '',
    hippoDistHash: treeHash(path.join(repo, 'dist')),
  };
}

/** The pins a run's start differs from, one line each; a key in `actual` that the pins file lacks counts as a difference. */
export function pinMismatches(pins, actual) {
  const bad = [];
  for (const [key, value] of Object.entries(actual)) {
    if (pins[key] === undefined) bad.push(`${key} is not pinned`);
    else if (String(pins[key]) !== String(value)) bad.push(`${key} is pinned ${pins[key]}, this run has ${value}`);
  }
  return bad;
}

/** What --pins compares before any session spends usage; Claude Code's version is its leading token, so "2.1.288 (Claude Code)" pins as 2.1.288. */
export const claudePinned = (ctx) => ({
  claudeVersion: claudeVersionToken(ctx.claudeVersion), model: ctx.model, hippoCommit: ctx.hippoBuild.hippoCommit, hippoDistHash: ctx.hippoBuild.hippoDistHash,
});

/** Checked once the Codex version is known and before its login vault opens. */
export const codexPinned = (tools) => ({ codexVersion: tools.codexVersion, codexModel: tools.codexModel });

/** Throws when a pins file is given and the run differs from it, or the hippo checkout differs from its commit. */
export function refuseOffPins(pins, actual, ctx) {
  if (!pins) return;
  const bad = pinMismatches(pins, actual);
  if (ctx.hippoBuild.hippoDirty) bad.push('the hippo checkout has changes beyond its commit, so the commit does not name the build');
  if (bad.length) throw new Error(`this run differs from --pins: ${bad.join('; ')}`);
}
