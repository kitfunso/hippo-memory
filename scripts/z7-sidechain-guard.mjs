// The scored run's lock: repo state, frozen inputs, prereg pins and the create-once marker. Impure on purpose (git and fs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as L from './z7-sidechain-lib.mjs';

export const LOCK_NAME = 'z7-sidechain-gap.json';
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const pinHashes = (dir, names) => Object.fromEntries(names.map((n) => [n, fs.existsSync(path.join(dir, n)) ? hash(fs.readFileSync(path.join(dir, n))) : null]));

export function refuseApiKey(env) {
  if (env.ANTHROPIC_API_KEY !== undefined) throw new Error('ANTHROPIC_API_KEY is set; refusing every command that calls claude');
}

export function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function checkRepoState(cfg) {
  const status = /\*\*Status:\*\*\s*([A-Za-z-]+)/.exec(fs.readFileSync(cfg.prereg, 'utf8'))?.[1];
  if (status !== 'PRE-REG-LOCKED') throw new Error('prereg Status is not PRE-REG-LOCKED');
  const prompts = fs.readdirSync(cfg.promptDir).sort();
  if (!prompts.length) throw new Error('no prompt files');
  for (const f of [cfg.prereg, ...cfg.scriptFiles]) {
    if (git(cfg.repo, ['ls-files', '--error-unmatch', '--', f]).status !== 0) throw new Error(`not tracked: ${path.basename(f)}`);
  }
  const tracked = git(cfg.repo, ['ls-files', '--', cfg.promptDir]).stdout.split('\n').filter(Boolean).map((p) => path.basename(p)).sort();
  if (tracked.join('|') !== prompts.join('|')) throw new Error('a prompt file is not tracked');
  if (git(cfg.repo, ['status', '--porcelain', '--', cfg.prereg, ...cfg.scriptFiles, cfg.promptDir]).stdout.trim()) throw new Error('prereg, scripts or prompts are not clean at HEAD');
  const lockCommit = git(cfg.repo, ['log', '-1', '--format=%H', '--', cfg.prereg]).stdout.trim();
  if (!git(cfg.repo, ['branch', '-r', '--contains', lockCommit]).stdout.trim()) throw new Error('the lock commit is not on a remote branch');
  return lockCommit;
}

// Nothing the run executes may differ from the lock commit, and every input the prereg pins must match its pin.
function checkFrozen(cfg, lockCommit) {
  if (git(cfg.repo, ['diff', '--quiet', lockCommit, 'HEAD', '--', ...cfg.scriptFiles, cfg.promptDir]).status !== 0) {
    throw new Error('a script or prompt changed after the lock commit');
  }
  const pins = L.parsePins(fs.readFileSync(cfg.prereg, 'utf8'));
  const bad = L.checkPins(pins, { dist: pinHashes(cfg.distDir, L.PIN_DIST), prompts: pinHashes(cfg.promptDir, L.PIN_PROMPTS), claude: cfg.claudeVersion() });
  if (bad.length) throw new Error(`pin mismatch: ${bad.join(', ')}`);
  return pins;
}

export function guardScored(cfg, resume = false) {
  const lockCommit = checkRepoState(cfg);
  const pins = checkFrozen(cfg, lockCommit);
  const marker = path.join(cfg.lockDir, LOCK_NAME);
  if (resume && !fs.existsSync(marker)) throw new Error('no lock marker to resume from');
  if (!resume && fs.existsSync(marker)) throw new Error('the lock marker exists; the scored run happens once (use --resume to continue it)');
  const pin = (files) => Object.fromEntries(files.map((f) => [path.basename(f), hash(fs.readFileSync(f))]));
  const prompts = fs.readdirSync(cfg.promptDir).sort().map((p) => path.join(cfg.promptDir, p));
  return { lockCommit, marker, pins, scripts: pin(cfg.scriptFiles), prompts: pin(prompts) };
}

export function createMarker(lock, itemListSha256) {
  fs.mkdirSync(path.dirname(lock.marker), { recursive: true });
  const body = { lockCommit: lock.lockCommit, scoredItemListSha256: itemListSha256, createdAt: new Date().toISOString(), scripts: lock.scripts, prompts: lock.prompts };
  fs.writeFileSync(lock.marker, JSON.stringify(body, null, 1), { flag: 'wx' });
}

export const appendLine = (file, obj) => fs.appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...obj })}\n`);
export const resumesLog = (lock) => `${lock.marker.slice(0, -5)}.resumes.jsonl`;
export const countResumes = (lock) => (fs.existsSync(resumesLog(lock)) ? fs.readFileSync(resumesLog(lock), 'utf8').split('\n').filter(Boolean).length : 0);

// A resume continues the same lock and the same item list, and only before a result exists.
export function startResume(lock, itemListSha256, dir) {
  const m = JSON.parse(fs.readFileSync(lock.marker, 'utf8'));
  if (m.lockCommit !== lock.lockCommit) throw new Error('the marker belongs to a different lock commit');
  if (m.scoredItemListSha256 !== itemListSha256) throw new Error('the marker belongs to a different scored item list');
  if (fs.existsSync(path.join(dir, 'result.json'))) throw new Error('result.json exists; the scored run is finished');
  appendLine(resumesLog(lock), { lockCommit: lock.lockCommit });
}
