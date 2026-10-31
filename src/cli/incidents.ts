// First-class object verbs for incidents: open one, resolve it, close it.

import { extractPathTags } from '../search/path-context.js';
import * as incidentsModule from '../objects/incidents.js';
import { objectsOf } from '../api/objects/objects.js';
import type { Objects } from '../store/port.js';
import { cliApiContext } from './api-context.js';
import { printError } from './output.js';
import { nonEmptyStringFlag, type CliFlags, isStringFlag, stringFlag, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { closeObject, foundOrExit, idArgOrExit, listObjects, type ObjectNames } from './object-verbs.js';
import { fail } from './exit.js';

const INCIDENT: ObjectNames = { cmd: 'incident', noun: 'Incident', idLabel: 'incident' };

function printIncidentRow(inc: incidentsModule.Incident): void {
  const linkPart = inc.linkedMemoryIds.length > 0 ? ` links=${inc.linkedMemoryIds.length}` : '';
  console.log(`#${inc.id} [${inc.status}]${linkPart} memory=${inc.memoryId ?? '-'}`);
  console.log(`    ${inc.incidentText}`);
  if (inc.context) console.log(`    context: ${inc.context}`);
}

function incidentList(objects: Objects, tenantId: string, flags: CliFlags): Promise<void> {
  return listObjects(flags, {
    plural: 'incidents',
    states: incidentsModule.VALID_INCIDENT_STATES,
    load: (opts) => incidentsModule.loadIncidents(objects, tenantId, opts),
    printRow: printIncidentRow,
  });
}

async function incidentGet(objects: Objects, tenantId: string, args: string[]): Promise<void> {
  const id = idArgOrExit(args, 'Usage: hippo incident get <id>', INCIDENT.idLabel);
  const incident = foundOrExit(await incidentsModule.loadIncidentById(objects, tenantId, id), INCIDENT.noun, id);
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

async function incidentResolve(objects: Objects, tenantId: string, args: string[], flags: CliFlags): Promise<void> {
  const id = idArgOrExit(args, 'Usage: hippo incident resolve <id> --resolution "<text>"', INCIDENT.idLabel);
  const resolutionRaw = stringFlag(flags, 'resolution');
  if (!resolutionRaw?.trim()) {
    fail('--resolution requires a non-empty value, e.g. hippo incident resolve <id> --resolution "root cause fixed".');
  }
  const resolved = await incidentsModule.resolveOpenIncident(objects, tenantId, id, resolutionRaw, 'cli');
  console.log(`Incident #${resolved.id} resolved.`);
}

function incidentClose(objects: Objects, tenantId: string, args: string[]): Promise<void> {
  return closeObject(args, INCIDENT, (id) => incidentsModule.closeIncident(objects, tenantId, id));
}

export async function handleIncident({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';
  const objects = objectsOf(cliApiContext(hippoRoot, tenantId));
  if (subcommand === 'list') return incidentList(objects, tenantId, flags);
  if (subcommand === 'get') return incidentGet(objects, tenantId, args);
  if (subcommand === 'resolve') return incidentResolve(objects, tenantId, args, flags);
  if (subcommand === 'close') return incidentClose(objects, tenantId, args);

  // Default subcommand is open (create): accept both `incident open "<text>"` and bare `incident "<text>"`;
  // for the `open` keyword the text is args[1], otherwise args[0] is the text.
  await incidentCreate(objects, hippoRoot, tenantId, subcommand === 'open' ? (args[1] ?? '') : subcommand, flags);
}

async function incidentCreate(
  objects: Objects,
  hippoRoot: string,
  tenantId: string,
  incidentText: string,
  flags: CliFlags,
): Promise<void> {
  if (!incidentText) {
    printError('Usage: hippo incident "<incident>" [--context "<details>"] [--link <memory-id>]...');
    printError('       hippo incident list [--status open|resolved|closed|all] [--limit N]');
    printError('       hippo incident get <id>');
    printError('       hippo incident resolve <id> --resolution "<text>"');
    fail('       hippo incident close <id>');
  }
  const context = nonEmptyStringFlag(flags, 'context');
  // --link is a repeatable flag (collected into an array by parseArgs). A
  // single --link <id> yields a string; normalize both to string[].
  const linkRaw = flags['link'];
  let linkedMemoryIds: string[] | undefined;
  if (Array.isArray(linkRaw)) {
    linkedMemoryIds = linkRaw;
  } else if (isStringFlag(linkRaw)) {
    linkedMemoryIds = [linkRaw];
  } else if (linkRaw === true) {
    fail('--link requires a memory id, e.g. hippo incident "<text>" --link mem_abc123.');
  }

  const incidentPathTags = extractPathTags(process.cwd());
  const created = await incidentsModule.openIncident(objects, hippoRoot, tenantId, {
    incidentText,
    context,
    linkedMemoryIds,
    extraTags: incidentPathTags,
  }, 'cli');

  console.log(`Incident recorded: #${created.id}`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  if (created.linkedMemoryIds.length > 0) {
    console.log(`  linked memories: ${created.linkedMemoryIds.join(', ')}`);
  }
}
