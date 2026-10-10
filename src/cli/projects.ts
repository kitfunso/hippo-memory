// The `hippo projects` verb: list a store's project names, fold an old worktree name into its repo, repair old tags in one pass.

import * as path from 'path';
import { execFileSync } from 'child_process';
import * as api from '../api/index.js';
import { cliApiContext } from './api-context.js';
import { type CliFlags, flagIsTrue, type CommandContext } from './flag-values.js';
import { resolveAuthRoot } from './shared.js';
import { printError } from './output.js';
import { errorMessage } from '../util/log.js';
import { DATE_PREFIX_CHARS } from '../util/token-text.js';


/** Old per-worktree project names of the repo at cwd, mapped to the repo's main checkout name; empty outside git. */
function worktreeNames(): Map<string, string> {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const paths = out.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => path.basename(l.slice('worktree '.length)));
    return new Map(paths.slice(1).map((name) => [name, paths[0]]));
  } catch {
    // Outside a git checkout, or no git on PATH: the list just has no worktree hints.
    return new Map();
  }
}

function label(origin: string | null): string {
  return origin === null ? '(unknown)' : origin === '' ? '(user-global)' : origin;
}

function hint(p: api.ProjectSummary, worktrees: Map<string, string>): string {
  const main = p.origin ? worktrees.get(p.origin) : undefined;
  if (main) return `\n    a worktree of ${main}: hippo projects merge ${p.origin} ${main}`;
  return p.copiesElsewhere > 0 ? `\n    ${p.copiesElsewhere} of its imported notes are copies also held under another name` : '';
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function projectsList(ctx: api.Context, flags: CliFlags): void {
  const root = ctx.hippoRoot;
  const projects = api.listProjectNames(ctx);
  if (flags['json']) {
    console.log(JSON.stringify({ store: root, projects }, null, 2));
    return;
  }
  const worktrees = worktreeNames();
  console.log(`${count(projects.length, 'project name')} in ${root} (newest write first):\n`);
  for (const p of projects) {
    console.log(`${label(p.origin)}  ${count(p.live, 'memory', 'memories')}, ${p.imported} imported from agent notes, newest ${p.newest.slice(0, DATE_PREFIX_CHARS)}${hint(p, worktrees)}`);
  }
}

function projectsMerge(ctx: api.Context, args: string[], flags: CliFlags): void {
  const apply = flagIsTrue(flags, 'apply');
  const [from, into] = [args[1] ?? '', args[2] ?? ''];
  const r = api.mergeProjectNames(ctx, { from, into, dryRun: !apply });
  if (flags['json']) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`${apply ? 'Merged' : 'Dry run: would merge'} ${from} into ${into}:`);
  console.log(`  ${count(r.setAside.length, 'imported note ' +
    'copy', 'imported note copies')} set aside (${into} already holds the same note; the rest move under ${into} on the next sync)`);
  console.log(`  ${count(r.restamped.length, 'memory', 'memories')} re-tagged, plus ${r.dormantRestamped.length} dormant and ${count(r.compactions, 'compaction record')}`);
  console.log(apply ? `Backup: ${r.backup}\nEvery id is in the audit log: hippo audit list --op project_merge` : 'Nothing written. Add --apply to run it.');
}

function projectsRepair(ctx: api.Context, flags: CliFlags): void {
  const root = ctx.hippoRoot;
  const apply = flagIsTrue(flags, 'apply');
  const r = api.repairProjectNames(ctx, { dryRun: !apply });
  if (flags['json']) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`${apply ? 'Repaired' : 'Dry run: would repair'} ${root}:`);
  console.log(`  ${count(r.copies.length, 'imported note ' +
    'copy', 'imported note copies')} under the wrong project set aside (the note stays under its own, or user-global)`);
  for (const f of r.folds) console.log(`  ${f.from} folded into ${f.into} (its sessions' folders resolve there now)`);
  for (const c of r.collisions) console.log(`  ${c.name} left as it is: its folders now resolve to ${c.ids.join(', ')}; fold it by hand with hippo projects merge`);
  console.log(`  sleep's user-global merged rows: ${r.toProject.length} re-tagged to their parents' project`);
  console.log(`  ${r.setAside.length} set aside (parents in two projects; sleep re-merges them per project)`);
  console.log(`  ${r.untraced.length} left as they are (no parent left to show which project; check them with hippo inspect <id>)`);
  console.log(apply ? `Backup: ${r.backup}\nEvery id is in the audit log: hippo audit list --op project_repair` : 'Nothing written. Add --apply to run it.');
}

export function handleProjects({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  const ctx = cliApiContext(resolveAuthRoot(hippoRoot, flags), tenantId);
  const sub = args[0] ?? 'list';
  try {
    if (sub === 'list') return projectsList(ctx, flags);
    if (sub === 'merge') return projectsMerge(ctx, args, flags);
    if (sub === 'repair') return projectsRepair(ctx, flags);
    printError('Usage: hippo projects [list] [--json] | merge <from> <into> [--apply] | repair [--apply]  [--global]');
    process.exitCode = 1;
  } catch (err) {
    printError(errorMessage(err));
    process.exitCode = 1;
  }
}
