import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = 'C:/z0-lessons/lesson-endcheck-ab';
export const repo = fileURLToPath(new URL('../../../', import.meta.url));
export const slice = path.resolve(repo, '../wt-slice1');
export const experiments = 'C:/Users/skf_s/Documents/hippo-mechanisms-2026-11-24/experiment1';
export const scored = 'C:/z0-runs/scored';
export const binary = path.join(scored, 'bin/claude.exe');
export const study = 'lesson-endcheck-ab-2026-11-25';
export const dist = name => import(pathToFileURL(path.join(slice, 'dist', name)).href);
export const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
export const digest = x => createHash('sha256').update(x).digest('hex');
export function freeze(file, bytes) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  try { fs.writeFileSync(file, bytes, {flag: 'wx'}); }
  catch (e) {
    if (e.code !== 'EEXIST' || !fs.readFileSync(file).equals(Buffer.from(bytes))) throw e;
  }
}
export const json = (f, obj) => freeze(f, JSON.stringify(obj, null, 2) + '\n');
export const corpus = path.join(root, 'corpus');
export const loadPlan = () => read(path.join(corpus, 'plan.json'));

