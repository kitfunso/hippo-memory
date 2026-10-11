// First-class object verbs for incidents: open one, resolve it, close it.

import { extractPathTags } from '../search/path-context.js';
import * as incidentsModule from '../objects/incidents.js';
import { printError } from './output.js';
import { nonEmptyStringFlag, type CliFlags, isStringFlag, stringFlag, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { closeObject, foundOrExit, idArgOrExit, listObjects, type ObjectNames } from './object-verbs.js';
import { CliExit } from './exit.js';

const INCIDENT: ObjectNames = { cmd: 'incident', noun: 'Incident', idLabel: 'incident' };

function printIncidentRow(inc: incidentsModule.Incident): void {
  const linkPart = inc.linkedMemoryIds.length > 0 ? ` links=${inc.linkedMemoryIds.length}` : '';
  console.log(`#${inc.id} [${inc.status}]${linkPart} memory=${inc.memoryId ?? '-'}`);
  console.log(`    ${inc.incidentText}`);
  if (inc.context) console.log(`    context: ${inc.context}`);
}

function incidentList(hippoRoot: string, tenantId: string, flags: CliFlags): void {
  listObjects(flags, {
    plural: 'incidents',
    states: incidentsModule.VALID_INCIDENT_STATES,
    load: (opts) => incidentsModule.loadIncidents(hippoRoot, tenantId, opts),
    printRow: printIncidentRow,
  });
}

function incidentGet(hippoRoot: string, tenantId: string, args: string[]): void {
  const id = idArgOrExit(args, 'Usage: hippo incident get <id>', INCIDENT.idLabel);
  const incident = foundOrExit(incidentsModule.loadIncidentById(hippoRoot, tenantId, id), INCIDENT.noun, id);
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

function incidentResolve(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const id = idArgOrExit(args, 'Usage: hippo incident resolve <id> --resolution "<text>"', INCIDENT.idLabel);
  const resolutionRaw = stringFlag(flags, 'resolution');
  if (!resolutionRaw?.trim()) {
    printError('--resolution requires a non-empty value, e.g. hippo incident resolve <id> --resolution "root cause fixed".');
    throw new CliExit(1);
  }
  const resolved = incidentsModule.resolveIncident(hippoRoot, tenantId, id, resolutionRaw);
  console.log(`Incident #${resolved.id} resolved.`);
}

function incidentClose(hippoRoot: string, tenantId: string, args: string[]): void {
  closeObject(args, INCIDENT, (id) => incidentsModule.closeIncident(hippoRoot, tenantId, id));
}

export function handleIncident({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';
  if (subcommand === 'list') return incidentList(hippoRoot, tenantId, flags);
  if (subcommand === 'get') return incidentGet(hippoRoot, tenantId, args);
  if (subcommand === 'resolve') return incidentResolve(hippoRoot, tenantId, args, flags);
  if (subcommand === 'close') return incidentClose(hippoRoot, tenantId, args);

  // Default subcommand is open (create): accept both `incident open "<text>"` and bare `incident "<text>"`;
  // for the `open` keyword the text is args[1], otherwise args[0] is the text.
  incidentCreate(hippoRoot, tenantId, subcommand === 'open' ? (args[1] ?? '') : subcommand, flags);
}

function incidentCreate(hippoRoot: string, tenantId: string, incidentText: string, flags: CliFlags): void {
  if (!incidentText) {
    printError('Usage: hippo incident "<incident>" [--context "<details>"] [--link <memory-id>]...');
    printError('       hippo incident list [--status open|resolved|closed|all] [--limit N]');
    printError('       hippo incident get <id>');
    printError('       hippo incident resolve <id> --resolution "<text>"');
    printError('       hippo incident close <id>');
    throw new CliExit(1);
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
    printError('--link requires a memory id, e.g. hippo incident "<text>" --link mem_abc123.');
    throw new CliExit(1);
  }

  const incidentPathTags = extractPathTags(process.cwd());
  const created = incidentsModule.saveIncident(hippoRoot, tenantId, {
    incidentText,
    context,
    linkedMemoryIds,
    extraTags: incidentPathTags,
  });

  console.log(`Incident recorded: #${created.id}`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  if (created.linkedMemoryIds.length > 0) {
    console.log(`  linked memories: ${created.linkedMemoryIds.join(', ')}`);
  }
}
