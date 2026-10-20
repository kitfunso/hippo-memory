// First-class object verbs for incidents: open one, resolve it, close it.

import type { Context } from '../../api/types.js';
import { incidentOpen, incidentResolve } from '../../api/objects/object-kinds.js';
import { objectClose, objectGet, objectList, objectStates } from '../../api/objects/objects.js';
import type { Incident } from '../../base/records/object-types.js';
import { cliApiContext } from './api-context.js';
import { printError } from './output.js';
import { nonEmptyStringFlag, type CliFlags, repeatedFlag, stringFlag, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { closeObject, foundOrExit, idArgOrExit, listObjects, type ObjectNames } from './object-verbs.js';
import { fail } from './exit.js';
import { shellFolder } from './versioned-verbs.js';

const INCIDENT: ObjectNames = { cmd: 'incident', noun: 'Incident', idLabel: 'incident' };

function printIncidentRow(inc: Incident): void {
  const linkPart = inc.linkedMemoryIds.length > 0 ? ` links=${inc.linkedMemoryIds.length}` : '';
  console.log(`#${inc.id} [${inc.status}]${linkPart} memory=${inc.memoryId ?? '-'}`);
  console.log(`    ${inc.incidentText}`);
  if (inc.context) console.log(`    context: ${inc.context}`);
}

function incidentList(ctx: Context, flags: CliFlags): Promise<void> {
  return listObjects(flags, {
    plural: 'incidents',
    states: objectStates('incident'),
    load: (opts) => objectList(ctx, 'incident', opts),
    printRow: printIncidentRow,
  });
}

async function incidentGet(ctx: Context, args: string[]): Promise<void> {
  const id = idArgOrExit(args, 'Usage: hippo incident get <id>', INCIDENT.idLabel);
  const incident = foundOrExit(await objectGet(ctx, 'incident', id), INCIDENT.noun, id);
  console.log(`Incident #${incident.id}`);
  console.log(`  status: ${incident.status}`);
  console.log(`  text: ${incident.incidentText}`);
  if (incident.context) console.log(`  context: ${incident.context}`);
  if (incident.resolutionText) console.log(`  resolution: ${incident.resolutionText}`);
  if (incident.resolvedAt) console.log(`  resolved_at: ${incident.resolvedAt}`);
  if (incident.closedAt) console.log(`  closed_at: ${incident.closedAt}`);
  if (incident.linkedMemoryIds.length > 0) {
    console.log(`  linked memories: ${incident.linkedMemoryIds.join(', ')}`);
  }
  if (incident.memoryId) console.log(`  memory: ${incident.memoryId}`);
  console.log(`  created: ${incident.createdAt}`);
}

async function resolveIncident(ctx: Context, args: string[], flags: CliFlags): Promise<void> {
  const id = idArgOrExit(args, 'Usage: hippo incident resolve <id> --resolution "<text>"', INCIDENT.idLabel);
  const resolutionRaw = stringFlag(flags, 'resolution');
  if (!resolutionRaw?.trim()) {
    fail('--resolution requires a non-empty value, e.g. hippo incident resolve <id> --resolution "root cause fixed".');
  }
  const resolved = await incidentResolve(ctx, id, resolutionRaw);
  console.log(`Incident #${resolved.id} resolved.`);
}

function incidentClose(ctx: Context, args: string[]): Promise<void> {
  return closeObject(args, INCIDENT, (id) => objectClose(ctx, 'incident', id));
}

export async function handleIncident({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';
  const ctx = cliApiContext(hippoRoot, tenantId);
  if (subcommand === 'list') return incidentList(ctx, flags);
  if (subcommand === 'get') return incidentGet(ctx, args);
  if (subcommand === 'resolve') return resolveIncident(ctx, args, flags);
  if (subcommand === 'close') return incidentClose(ctx, args);

  // Default subcommand is open (create): accept both `incident open "<text>"` and bare `incident "<text>"`; for the
  // `open` keyword the text is args[1], otherwise args[0] is the text.
  await incidentCreate(ctx, subcommand === 'open' ? (args[1] ?? '') : subcommand, flags);
}

async function incidentCreate(ctx: Context, incidentText: string, flags: CliFlags): Promise<void> {
  if (!incidentText) {
    printError('Usage: hippo incident "<incident>" [--context "<details>"] [--link <memory-id>]...');
    printError('       hippo incident list [--status open|resolved|closed|all] [--limit N]');
    printError('       hippo incident get <id>');
    printError('       hippo incident resolve <id> --resolution "<text>"');
    fail('       hippo incident close <id>');
  }
  const context = nonEmptyStringFlag(flags, 'context');
  if (flags['link'] === true) {
    fail('--link requires a memory id, e.g. hippo incident "<text>" --link mem_abc123.');
  }
  const linkedMemoryIds = repeatedFlag(flags, 'link');

  const created = await incidentOpen(ctx, { incidentText, context, linkedMemoryIds }, shellFolder());

  console.log(`Incident recorded: #${created.id}`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  if (created.linkedMemoryIds.length > 0) {
    console.log(`  linked memories: ${created.linkedMemoryIds.join(', ')}`);
  }
}
