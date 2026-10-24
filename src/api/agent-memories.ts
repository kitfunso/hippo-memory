// The agent-memory import as each command runs it: which passes a store gets, which store each pass writes to, and
// what it lists. src/domain/agent-memories runs one pass.
import path from 'node:path';
import type { Machine } from '../base/util/agent-homes.js';
import { emptyReport, mergeReports, type ImportReport } from '../base/memory/agent-memory-report.js';
import { projectNames, type ProjectIdentity } from '../base/scope/project-identity.js';
import { claudeTranscriptListing, transcriptNotesProject } from '../domain/agent-memories/claude-code.js';
import { runPass, type Pass, type SyncOptions } from '../domain/agent-memories/sync.js';
import type { AdapterContext } from '../domain/agent-memories/types.js';

export type { SyncOptions };

/**
 * init, sleep, `import --agents` and the daily runner: a local store gets its project pass then the user pass; the
 * global store the user pass only.
 */
export async function importForStore(root: string, opts: SyncOptions): Promise<ImportReport> {
  if (opts.machine.isGlobalRoot(root)) return importUserMemories(root, opts);
  const report = await importProjectMemories(root, opts);
  mergeReports(report, await importUserMemories(root, opts));
  return report;
}

/** A local store's project pass with legacy adoption; `init --scan` runs it per repository and the user pass once. */
export async function importProjectMemories(root: string, opts: SyncOptions): Promise<ImportReport> {
  const ctx = context(opts.machine, { projectRoot: path.dirname(root) });
  return runPass(
    {
      scope: 'project',
      target: root,
      invoking: root,
      list: (a) => a.list(ctx, 'project'),
      legacy: true,
      originProject: undefined,
      legacyOrigins: [],
      handover: true,
    },
    opts,
  );
}

/** Every tool's user-level memory into the global store, created on demand, with no origin. */
export async function importUserMemories(invokingRoot: string, opts: SyncOptions): Promise<ImportReport> {
  const ctx = context(opts.machine, {});
  return runPass(
    {
      scope: 'user',
      target: opts.machine.globalRoot(),
      invoking: invokingRoot,
      list: (a) => a.list(ctx, 'user'),
      legacy: false,
      originProject: '',
      legacyOrigins: [],
      handover: false,
    },
    opts,
  );
}

/** Session end in a folder with no store of its own: the session's project into the global store with its origin, the
 * session folder's notes, then the user pass. */
export async function importAtSessionEnd(
  cwd: string,
  transcriptPath: string | undefined,
  opts: SyncOptions,
): Promise<ImportReport> {
  const globalRoot = opts.machine.globalRoot();
  const ctx = context(opts.machine, { projectRoot: cwd });
  const report = await runPass(
    {
      scope: 'project',
      target: globalRoot,
      invoking: globalRoot,
      list: (a) => a.list(ctx, 'project'),
      legacy: false,
      ...projectOrigins(opts.machine.projectIdentity(cwd)),
      handover: false,
    },
    opts,
  );
  if (transcriptPath !== undefined) {
    mergeReports(report, await importSessionFolder(globalRoot, transcriptPath, cwd, opts));
  }
  mergeReports(report, await importUserMemories(globalRoot, opts));
  return report;
}

/** The session folder's notes under the project Claude filed them for, never cwd's: a session begun at home keeps its
 * home notes user-global wherever it ends. No git call, so post-compact can run it. */
export async function importSessionFolder(
  root: string,
  transcriptPath: string,
  cwd: string | null,
  opts: SyncOptions,
): Promise<ImportReport> {
  const project = transcriptNotesProject(transcriptPath, cwd, opts.machine);
  if (project === null) return emptyReport();
  // A project store takes its own project's notes; another project's, or home's, go to the global store, which parts
  // them by origin.
  const { machine } = opts;
  const own = machine.isGlobalRoot(root) || project.name === machine.projectIdentity(path.dirname(root)).name;
  const target = own ? root : machine.globalRoot();
  const ctx = context(opts.machine, {});
  return runPass(
    {
      scope: 'project',
      target,
      invoking: root,
      legacy: false,
      ...projectOrigins(project),
      handover: false,
      list: (a) => (a.tool === 'claude-code' ? claudeTranscriptListing(ctx, transcriptPath) : null),
    },
    opts,
  );
}

function projectOrigins(project: ProjectIdentity): Pick<Pass, 'originProject' | 'legacyOrigins'> {
  return { originProject: project.name, legacyOrigins: projectNames(project).slice(1) };
}

function context(machine: Machine, extra: Pick<AdapterContext, 'projectRoot'>): AdapterContext {
  return { ...machine, ...extra };
}
