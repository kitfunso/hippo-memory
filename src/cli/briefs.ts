// First-class object verbs for project briefs and customer notes, plus the entity graph.

import * as fs from 'fs';
import { spawn } from 'child_process';
import { extractPathTags } from '../path-context.js';
import * as briefsModule from '../project-briefs.js';
import * as customerNotesModule from '../customer-notes.js';
import { extractGraph } from '../graph-extract.js';
import { buildGraphModel, renderGraphHtml, renderGraphCanvas, DEFAULT_VIEW_LIMIT } from '../graph-view.js';
import { resolveTenantId } from '../tenant.js';
import { errorMessage, log } from '../log.js';
import { printError } from './output.js';
import { parseListLimit, parsePositiveId, requireInit, type CliFlags } from './shared.js';

function printBriefRow(b: briefsModule.ProjectBrief): void {
  console.log(`#${b.id} [${b.status}] v${b.version} repo="${b.repo}" memory=${b.memoryId ?? '-'}`);
  if (b.changeSummary) console.log(`    change: ${b.changeSummary}`);
}

function briefUsage(): void {
  printError('Usage: hippo brief new "<repo>" --summary "<text>"');
  printError('       hippo brief list [--status active|superseded|closed|all] [--repo "<repo>"] [--limit N]');
  printError('       hippo brief get <id>');
  printError('       hippo brief supersede <id> --summary "<text>" [--change "<summary>"]');
  printError('       hippo brief close <id>');
  printError('       hippo brief refresh "<repo>" [--dry-run]   (auto-assemble the brief from the repo\'s receipts)');
}

function briefList(hippoRoot: string, tenantId: string, flags: CliFlags): void {
  const statusRaw = flags['status'];
  const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
  const repoRaw = flags['repo'];
  const repo = typeof repoRaw === 'string' && repoRaw.trim() ? repoRaw.trim() : undefined;
  const limit = parseListLimit(flags);
  const opts: briefsModule.ListProjectBriefsOpts = { limit, repo };
  if (status !== 'all') {
    if (!briefsModule.VALID_BRIEF_STATES.has(status as briefsModule.BriefStatus)) {
      printError(`Invalid --status: "${status}". Must be one of: active | superseded | closed | all.`);
      process.exit(1);
    }
    opts.status = status as briefsModule.BriefStatus;
  }
  const results = briefsModule.loadProjectBriefs(hippoRoot, tenantId, opts);
  if (results.length === 0) {
    console.log('No project briefs.');
    return;
  }
  console.log(`Found ${results.length} project briefs:
`);
  for (const b of results) printBriefRow(b);
}

function briefRefresh(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const repoRaw = args[1];
  if (!repoRaw) {
    printError('Usage: hippo brief refresh "<repo>" [--dry-run]');
    process.exit(1);
  }
  const dryRun = Boolean(flags['dry-run']);
  try {
    if (dryRun) {
      const { markdown, receiptCount } = briefsModule.assembleBriefFromReceipts(hippoRoot, tenantId, repoRaw);
      printError(`(dry-run: assembled from ${receiptCount} receipt(s); brief NOT written)`);
      console.log(markdown);
      return;
    }
    const created = briefsModule.refreshBrief(hippoRoot, tenantId, repoRaw, 'cli');
    console.log(`Project brief #${created.id} recorded (v${created.version}) for repo "${created.repo}".`);
    if (created.changeSummary) console.log(`  change: ${created.changeSummary}`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    printError((e as Error).message);
    process.exit(1);
  }
}

function briefGet(hippoRoot: string, tenantId: string, args: string[]): void {
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo brief get <id>');
    process.exit(1);
  }
  const id = parsePositiveId(idRaw, 'brief');
  const b = briefsModule.loadProjectBriefById(hippoRoot, tenantId, id);
  if (!b) {
    printError(`Project brief ${id} not found.`);
    process.exit(1);
  }
  console.log(`Project brief #${b.id}`);
  console.log(`  repo: ${b.repo}`);
  console.log(`  status: ${b.status}`);
  console.log(`  version: ${b.version}`);
  console.log(`  summary: ${b.summary}`);
  if (b.changeSummary) console.log(`  change_summary: ${b.changeSummary}`);
  if (b.supersededBy !== null) console.log(`  superseded_by: #${b.supersededBy}`);
  if (b.supersededAt) console.log(`  superseded_at: ${b.supersededAt}`);
  if (b.closedAt) console.log(`  closed_at: ${b.closedAt}`);
  if (b.memoryId) console.log(`  memory: ${b.memoryId}`);
  console.log(`  created: ${b.createdAt}`);
}

function briefSupersede(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo brief supersede <id> --summary "<text>" [--change "<summary>"]');
    process.exit(1);
  }
  const id = parsePositiveId(idRaw, 'brief');
  const summaryRaw = flags['summary'];
  if (typeof summaryRaw !== 'string' || !summaryRaw.trim()) {
    printError('hippo brief supersede requires --summary "<text>" for the new version.');
    process.exit(1);
  }
  const existing = briefsModule.loadProjectBriefById(hippoRoot, tenantId, id);
  if (!existing) {
    printError(`Project brief ${id} not found.`);
    process.exit(1);
  }
  const changeRaw = flags['change'];
  try {
    const created = briefsModule.saveProjectBrief(hippoRoot, tenantId, {
      repo: existing.repo,
      summary: summaryRaw,
      changeSummary: typeof changeRaw === 'string' && changeRaw ? changeRaw : undefined,
      supersedesBriefId: id,
      extraTags: extractPathTags(process.cwd()),
    });
    console.log(`Project brief #${created.id} recorded (v${created.version}), superseding #${id}.`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    printError((e as Error).message);
    process.exit(1);
  }
}

function briefClose(hippoRoot: string, tenantId: string, args: string[]): void {
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo brief close <id>');
    process.exit(1);
  }
  const id = parsePositiveId(idRaw, 'brief');
  const closed = briefsModule.closeProjectBrief(hippoRoot, tenantId, id);
  console.log(`Project brief #${closed.id} closed.`);
}

function briefCreate(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const subcommand = args[0] ?? '';
  // Default subcommand: new (create). Accept both `brief new "<repo>"` and the
  // bare `brief "<repo>"` form: for the `new` keyword the repo is args[1].
  const repo = subcommand === 'new' ? (args[1] ?? '') : subcommand;
  const summaryRaw = flags['summary'];
  if (!repo || typeof summaryRaw !== 'string' || !summaryRaw.trim()) {
    briefUsage();
    process.exit(1);
  }
  try {
    const created = briefsModule.saveProjectBrief(hippoRoot, tenantId, {
      repo,
      summary: summaryRaw,
      extraTags: extractPathTags(process.cwd()),
    });
    console.log(`Project brief recorded: #${created.id} (v${created.version}) for repo "${created.repo}"`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    printError((e as Error).message);
    process.exit(1);
  }
}

export function cmdProjectBrief(
  hippoRoot: string,
  args: string[],
  flags: CliFlags
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';
  if (subcommand === 'list') return briefList(hippoRoot, tenantId, flags);
  if (subcommand === 'refresh') return briefRefresh(hippoRoot, tenantId, args, flags);
  if (subcommand === 'get') return briefGet(hippoRoot, tenantId, args);
  if (subcommand === 'supersede') return briefSupersede(hippoRoot, tenantId, args, flags);
  if (subcommand === 'close') return briefClose(hippoRoot, tenantId, args);
  briefCreate(hippoRoot, tenantId, args, flags);
}

function printNoteRow(n: customerNotesModule.CustomerNote): void {
  console.log(`#${n.id} [${n.status}] v${n.version} customer="${n.customer}" memory=${n.memoryId ?? '-'}`);
  if (n.changeSummary) console.log(`    change: ${n.changeSummary}`);
}

function noteUsage(): void {
  printError('Usage: hippo note new "<customer>" --text "<note>"');
  printError('       hippo note list [--status active|superseded|closed|all] [--customer "<id>"] [--limit N]');
  printError('       hippo note get <id>');
  printError('       hippo note supersede <id> --text "<note>" [--change "<summary>"]');
  printError('       hippo note close <id>');
}

function graphExtract(hippoRoot: string, tenantId: string): void {
  const result = extractGraph(hippoRoot, tenantId);
  const byType = Object.entries(result.byType)
    .map(([t, n]) => `${t} ${n}`)
    .join(', ');
  const supersedes = result.relations - result.references;
  console.log(`Graph extracted: ${result.entities} entities (${byType}) + ${result.relations} relations (${supersedes} supersedes, ${result.references} references).`);
  if (result.truncated.length > 0) {
    printError(`WARNING: under-extracted (hit the per-type cap): ${result.truncated.join(', ')}. The graph is incomplete for those types.`);
  }
}

function graphShow(hippoRoot: string, tenantId: string, entity: string | undefined, flags: CliFlags): void {
  const model = buildGraphModel(hippoRoot, tenantId, { entity, limit: DEFAULT_VIEW_LIMIT });
  if (flags['json']) {
    console.log(JSON.stringify(model, null, 2));
    return;
  }
  if (model.nodes.length === 0) {
    console.log(entity ? `No entity named "${entity}".` : 'Graph is empty. Run `hippo graph extract` first.');
    return;
  }
  console.log(`Graph: ${model.nodes.length} entities, ${model.edges.length} relations${model.truncated ? ' (truncated)' : ''}`);
  const byType = new Map<string, { id: number; name: string }[]>();
  for (const n of model.nodes) {
    const arr = byType.get(n.type) ?? [];
    arr.push({ id: n.id, name: n.name });
    byType.set(n.type, arr);
  }
  for (const [type, ns] of byType) {
    console.log(`\n${type} (${ns.length}):`);
    for (const n of ns) console.log(`  [${n.id}] ${n.name}`);
  }
  if (model.edges.length > 0) {
    const nameById = new Map(model.nodes.map((n) => [n.id, n.name]));
    console.log('\nrelations:');
    for (const e of model.edges) {
      console.log(`  ${nameById.get(e.from)} --${e.relType}--> ${nameById.get(e.to)}`);
    }
  }
}

function openInBrowser(out: string): void {
  // Best-effort browser launch; never fail the command if it doesn't work.
  try {
    const [cmd, cmdArgs] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', out]]
        : process.platform === 'darwin'
          ? ['open', [out]]
          : ['xdg-open', [out]];
    const child = spawn(cmd, cmdArgs as string[], { detached: true, stdio: 'ignore', windowsHide: true });
    // A missing launcher (e.g. xdg-open absent) emits 'error' asynchronously;
    // an unhandled 'error' event would throw, so swallow it — the file is
    // already written and its path printed above.
    child.on('error', () => { /* best-effort launch */ });
    child.unref();
  } catch (err) {
    // The file is written and its path printed above, so a browser that will not start costs nothing.
    log.debug(`browser not opened: ${errorMessage(err)}`);
  }
}

function graphView(hippoRoot: string, tenantId: string, entity: string | undefined, flags: CliFlags): void {
  const format = typeof flags['format'] === 'string' ? (flags['format'] as string) : 'html';
  if (format !== 'html' && format !== 'canvas') {
    printError("graph view: --format must be 'html' or 'canvas'");
    process.exit(1);
  }
  const model = buildGraphModel(hippoRoot, tenantId, { entity, limit: DEFAULT_VIEW_LIMIT });
  const content = format === 'canvas' ? renderGraphCanvas(model) : renderGraphHtml(model);
  const defaultOut = format === 'canvas' ? 'hippo-graph.canvas' : 'hippo-graph.html';
  const out = typeof flags['out'] === 'string' ? (flags['out'] as string) : defaultOut;
  fs.writeFileSync(out, content, 'utf8');
  console.log(`Wrote ${model.nodes.length} entities + ${model.edges.length} relations to ${out}${model.truncated ? ' (truncated)' : ''}`);
  if (flags['open'] && format === 'html') openInBrowser(out);
}

export function cmdGraph(
  hippoRoot: string,
  args: string[],
  flags: CliFlags
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';
  if (subcommand === 'extract') return graphExtract(hippoRoot, tenantId);
  const entity = typeof flags['entity'] === 'string' ? (flags['entity'] as string) : undefined;
  if (subcommand === 'show') return graphShow(hippoRoot, tenantId, entity, flags);
  if (subcommand === 'view') return graphView(hippoRoot, tenantId, entity, flags);

  printError(
    'Usage:\n' +
      '  hippo graph extract                     Rebuild the entity/relation graph from consolidated objects\n' +
      '  hippo graph show [--entity NAME] [--json]   Inspect entities + their edges (text or JSON)\n' +
      '  hippo graph view [--out FILE] [--open] [--format html|canvas] [--entity NAME]   Generate an interactive node-link diagram',
  );
  process.exit(1);
}

function noteList(hippoRoot: string, tenantId: string, flags: CliFlags): void {
  const statusRaw = flags['status'];
  const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
  const customerRaw = flags['customer'];
  const customer = typeof customerRaw === 'string' && customerRaw.trim() ? customerRaw.trim() : undefined;
  const limit = parseListLimit(flags);
  const opts: customerNotesModule.ListCustomerNotesOpts = { limit, customer };
  if (status !== 'all') {
    if (!customerNotesModule.VALID_NOTE_STATES.has(status as customerNotesModule.NoteStatus)) {
      printError(`Invalid --status: "${status}". Must be one of: active | superseded | closed | all.`);
      process.exit(1);
    }
    opts.status = status as customerNotesModule.NoteStatus;
  }
  const results = customerNotesModule.loadCustomerNotes(hippoRoot, tenantId, opts);
  if (results.length === 0) {
    console.log('No customer notes.');
    return;
  }
  console.log(`Found ${results.length} customer notes:\n`);
  for (const n of results) printNoteRow(n);
}

function noteGet(hippoRoot: string, tenantId: string, args: string[]): void {
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo note get <id>');
    process.exit(1);
  }
  const id = parsePositiveId(idRaw, 'note');
  const n = customerNotesModule.loadCustomerNoteById(hippoRoot, tenantId, id);
  if (!n) {
    printError(`Customer note ${id} not found.`);
    process.exit(1);
  }
  console.log(`Customer note #${n.id}`);
  console.log(`  customer: ${n.customer}`);
  console.log(`  status: ${n.status}`);
  console.log(`  version: ${n.version}`);
  console.log(`  note: ${n.note}`);
  if (n.changeSummary) console.log(`  change_summary: ${n.changeSummary}`);
  if (n.supersededBy !== null) console.log(`  superseded_by: #${n.supersededBy}`);
  if (n.supersededAt) console.log(`  superseded_at: ${n.supersededAt}`);
  if (n.closedAt) console.log(`  closed_at: ${n.closedAt}`);
  if (n.memoryId) console.log(`  memory: ${n.memoryId}`);
  console.log(`  created: ${n.createdAt}`);
}

function noteSupersede(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo note supersede <id> --text "<note>" [--change "<summary>"]');
    process.exit(1);
  }
  const id = parsePositiveId(idRaw, 'note');
  const textRaw = flags['text'];
  if (typeof textRaw !== 'string' || !textRaw.trim()) {
    printError('hippo note supersede requires --text "<note>" for the new version.');
    process.exit(1);
  }
  const existing = customerNotesModule.loadCustomerNoteById(hippoRoot, tenantId, id);
  if (!existing) {
    printError(`Customer note ${id} not found.`);
    process.exit(1);
  }
  const changeRaw = flags['change'];
  try {
    const created = customerNotesModule.saveCustomerNote(hippoRoot, tenantId, {
      customer: existing.customer,
      note: textRaw,
      changeSummary: typeof changeRaw === 'string' && changeRaw ? changeRaw : undefined,
      supersedesNoteId: id,
      extraTags: extractPathTags(process.cwd()),
    });
    console.log(`Customer note #${created.id} recorded (v${created.version}), superseding #${id}.`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    printError((e as Error).message);
    process.exit(1);
  }
}

function noteClose(hippoRoot: string, tenantId: string, args: string[]): void {
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo note close <id>');
    process.exit(1);
  }
  const id = parsePositiveId(idRaw, 'note');
  const closed = customerNotesModule.closeCustomerNote(hippoRoot, tenantId, id);
  console.log(`Customer note #${closed.id} closed.`);
}

export function cmdCustomerNote(
  hippoRoot: string,
  args: string[],
  flags: CliFlags
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';
  if (subcommand === 'list') return noteList(hippoRoot, tenantId, flags);
  if (subcommand === 'get') return noteGet(hippoRoot, tenantId, args);
  if (subcommand === 'supersede') return noteSupersede(hippoRoot, tenantId, args, flags);
  if (subcommand === 'close') return noteClose(hippoRoot, tenantId, args);

  // Default subcommand: new (create). Accept both `note new "<customer>"` and the
  // bare `note "<customer>"` form: for the `new` keyword the customer is args[1].
  const customer = subcommand === 'new' ? (args[1] ?? '') : subcommand;
  const textRaw = flags['text'];
  if (!customer || typeof textRaw !== 'string' || !textRaw.trim()) {
    noteUsage();
    process.exit(1);
  }
  try {
    const created = customerNotesModule.saveCustomerNote(hippoRoot, tenantId, {
      customer,
      note: textRaw,
      extraTags: extractPathTags(process.cwd()),
    });
    console.log(`Customer note recorded: #${created.id} (v${created.version}) for customer "${created.customer}"`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    printError((e as Error).message);
    process.exit(1);
  }
}
