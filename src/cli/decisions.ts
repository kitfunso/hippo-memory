// First-class object verbs for predictions, decisions and incidents.

import { MemoryEntry } from '../core/memory.js';
import { getMemory } from '../api/memories.js';
import { extractPathTags } from '../search/path-context.js';
import * as predictionsModule from '../store/predictions.js';
import * as decisionsModule from '../objects/decisions.js';
import * as incidentsModule from '../objects/incidents.js';
import { printError } from './output.js';
import { nonEmptyStringFlag, parseListLimit, type CliFlags, flagIsTrue, isStringFlag, stringFlag, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { cliApiContext } from './api-context.js';
import { closeObject, foundOrExit, idArgOrExit, listObjects, printLifecycleTail, requireStatus, type ObjectNames } from './object-verbs.js';
import { errorMessage } from '../util/log.js';
import { CliExit } from './exit.js';

const BASERATE_DECIMALS = 3;
const DECISION: ObjectNames = { cmd: 'decide', noun: 'Decision', idLabel: 'decision' };
const INCIDENT: ObjectNames = { cmd: 'incident', noun: 'Incident', idLabel: 'incident' };
const PREDICTION_NOUN = 'Prediction';

// Lenient on purpose (parseInt reads "1abc" as 1) until the next major version; incidents use the strict parser.
function parseObjectId(idRaw: string, noun: string): number {
  const id = parseInt(String(idRaw), 10);
  if (!Number.isFinite(id) || id <= 0) {
    printError(`Invalid ${noun} id: "${idRaw}"`);
    throw new CliExit(1);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Prediction first-class object
// ---------------------------------------------------------------------------

function predictClose(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const id = idArgOrExit(args, 'Usage: hippo predict close <id> --state <closed|closed-unknown> [--actual <v>] [--note "..."]', 'prediction', parseObjectId);
  const stateRaw = (stringFlag(flags, 'state') ?? '').trim();
  // SAFETY: Set.has only compares by value, so a string outside the closure states is a plain miss.
  if (!predictionsModule.VALID_CLOSURE_STATES.has(stateRaw as predictionsModule.ClosureState) || stateRaw === 'open') {
    printError(`Invalid --state: "${stateRaw}". Must be one of: closed | closed-unknown.`);
    throw new CliExit(1);
  }
  const actualRaw = flags['actual'];
  const actualValue = actualRaw !== undefined ? Number(actualRaw) : undefined;
  if (actualRaw !== undefined && !Number.isFinite(actualValue)) {
    printError(`Invalid --actual: "${actualRaw}". Must be a number.`);
    throw new CliExit(1);
  }
  const closureNote = stringFlag(flags, 'note');

  const closed = predictionsModule.closePrediction(hippoRoot, tenantId, id, {
    // SAFETY: the check above exits unless stateRaw is in VALID_CLOSURE_STATES.
    closureState: stateRaw as predictionsModule.ClosureState,
    actualValue,
    closureNote,
  });
  console.log(`Prediction ${closed.id} closed: state=${closed.closureState}${closed.actualValue !== null ? ` actual=${closed.actualValue}` : ''}`);
}

function loadPredictionList(hippoRoot: string, tenantId: string, status: string, classTag: string, limit: number) {
  if (status === 'open') {
    return predictionsModule.loadOpenPredictions(hippoRoot, tenantId, {
      classTag: classTag || undefined,
      limit,
    });
  }
  if (status === 'all') {
    return classTag
      ? predictionsModule.loadPredictionsByClass(hippoRoot, tenantId, classTag, { limit })
      : predictionsModule.loadAllPredictions(hippoRoot, tenantId, { limit });
  }
  const closureState = requireStatus(status, predictionsModule.VALID_CLOSURE_STATES);
  if (!classTag) {
    // status filter without class — scan all classes is more complex; v1 requires --class for non-default status
    printError('--status filter (non-open) requires --class to be set.');
    throw new CliExit(1);
  }
  return predictionsModule.loadPredictionsByClass(hippoRoot, tenantId, classTag, {
    closureState,
    limit,
  });
}

function predictList(hippoRoot: string, tenantId: string, flags: CliFlags): void {
  const classTag = stringFlag(flags, 'class')?.trim() ?? '';
  const status = stringFlag(flags, 'status')?.trim() ?? 'all';
  const limit = parseListLimit(flags);

  const results = loadPredictionList(hippoRoot, tenantId, status, classTag, limit);
  if (results.length === 0) {
    console.log(classTag ? `No predictions in class "${classTag}".` : 'No predictions.');
    return;
  }
  console.log(`Found ${results.length} predictions:\n`);
  for (const p of results) {
    const estPart = p.estimateValue !== null ? ` estimate=${p.estimateValue}${p.estimateUnit ? ` ${p.estimateUnit}` : ''}` : '';
    const actPart = p.actualValue !== null ? ` actual=${p.actualValue}` : '';
    const tgtPart = p.targetDate ? ` target=${p.targetDate}` : '';
    console.log(`#${p.id} [${p.closureState}] class=${p.classTag}${estPart}${actPart}${tgtPart}`);
    console.log(`    ${p.claimText}`);
    if (p.closureNote) console.log(`    note: ${p.closureNote}`);
  }
}

function predictShow(hippoRoot: string, tenantId: string, args: string[]): void {
  const id = idArgOrExit(args, 'Usage: hippo predict show <id>', 'prediction', parseObjectId);
  const pred = foundOrExit(predictionsModule.loadPredictionById(hippoRoot, tenantId, id), PREDICTION_NOUN, id);
  console.log(`Prediction #${pred.id}`);
  console.log(`  class: ${pred.classTag}`);
  console.log(`  claim: ${pred.claimText}`);
  console.log(`  state: ${pred.closureState}`);
  if (pred.estimateValue !== null) console.log(`  estimate: ${pred.estimateValue}${pred.estimateUnit ? ' ' + pred.estimateUnit : ''}`);
  if (pred.targetDate) console.log(`  target: ${pred.targetDate}`);
  if (pred.actualValue !== null) console.log(`  actual: ${pred.actualValue}`);
  if (pred.closedAt) console.log(`  closed: ${pred.closedAt}`);
  if (pred.closureNote) console.log(`  note: ${pred.closureNote}`);
  if (pred.memoryId) console.log(`  memory: ${pred.memoryId}`);
  console.log(`  created: ${pred.createdAt}`);
}

function predictBaserate(hippoRoot: string, tenantId: string, flags: CliFlags): void {
  // Reference-class / planning-fallacy detector
  const classTag = stringFlag(flags, 'class')?.trim();
  if (!classTag) {
    printError('Usage: hippo predict baserate --class <c>');
    throw new CliExit(1);
  }
  const baserate = predictionsModule.computePredictionBaserate(hippoRoot, tenantId, classTag);
  if (baserate.nClosed === 0) {
    console.log(`No closed predictions in class "${baserate.classTag}" yet.`);
    console.log(`  Create one with: hippo predict "<claim>" --class ${baserate.classTag} --estimate N`);
    console.log(`  Close it later:  hippo predict close <id> --state closed --actual N`);
    return;
  }
  console.log(baserate.summary);
  console.log(`  n_closed:         ${baserate.nClosed}`);
  console.log(`  n_ratio_eligible: ${baserate.nRatioEligible}`);
  if (baserate.meanEstimate !== null) console.log(`  mean_estimate:    ${baserate.meanEstimate.toFixed(BASERATE_DECIMALS)}`);
  if (baserate.meanActual !== null)   console.log(`  mean_actual:      ${baserate.meanActual.toFixed(BASERATE_DECIMALS)}`);
  if (baserate.meanRatio !== null)    console.log(`  mean_ratio:       ${baserate.meanRatio.toFixed(BASERATE_DECIMALS)}x`);
  if (baserate.p50Ratio !== null)     console.log(`  p50_ratio:        ${baserate.p50Ratio.toFixed(BASERATE_DECIMALS)}x`);
  if (baserate.mae !== null)          console.log(`  mae:              ${baserate.mae.toFixed(BASERATE_DECIMALS)}`);
}

export function handlePredict({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';
  if (subcommand === 'close') return predictClose(hippoRoot, tenantId, args, flags);
  if (subcommand === 'list') return predictList(hippoRoot, tenantId, flags);
  if (subcommand === 'show') return predictShow(hippoRoot, tenantId, args);
  if (subcommand === 'baserate') return predictBaserate(hippoRoot, tenantId, flags);
  // Default subcommand: create. args[0] is the claim text.
  predictCreate(hippoRoot, tenantId, subcommand, flags);
}

function predictCreate(hippoRoot: string, tenantId: string, claimText: string, flags: CliFlags): void {
  if (!claimText) {
    printError('Usage: hippo predict "<claim>" --class <c> [--estimate <v>] [--unit <u>] [--target <YYYY-MM-DD>]');
    printError('       hippo predict close <id> --state <closed|closed-unknown> [--actual <v>] [--note "..."]');
    printError('       hippo predict list [--class X] [--status open|closed|closed-unknown|all] [--limit N]');
    printError('       hippo predict show <id>');
    throw new CliExit(1);
  }
  const classTag = stringFlag(flags, 'class')?.trim();
  if (!classTag) {
    printError('--class is required for prediction creation.');
    throw new CliExit(1);
  }
  const estimateRaw = flags['estimate'];
  const estimateValue = estimateRaw !== undefined ? Number(estimateRaw) : undefined;
  if (estimateRaw !== undefined && !Number.isFinite(estimateValue)) {
    printError(`Invalid --estimate: "${estimateRaw}". Must be a number.`);
    throw new CliExit(1);
  }
  const estimateUnit = stringFlag(flags, 'unit');
  const targetDate = stringFlag(flags, 'target');

  const created = predictionsModule.savePrediction(hippoRoot, tenantId, {
    classTag,
    claimText,
    estimateValue,
    estimateUnit,
    targetDate,
  });
  console.log(`Prediction recorded: #${created.id} class=${created.classTag}`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
}

function printDecisionRow(d: decisionsModule.Decision): void {
  const supPart = d.supersededBy !== null ? ` superseded_by=#${d.supersededBy}` : '';
  console.log(`#${d.id} [${d.status}]${supPart} memory=${d.memoryId ?? '-'}`);
  console.log(`    ${d.decisionText}`);
  if (d.context) console.log(`    context: ${d.context}`);
}

function decideList(hippoRoot: string, tenantId: string, flags: CliFlags): void {
  listObjects(flags, {
    plural: 'decisions',
    states: decisionsModule.VALID_DECISION_STATES,
    load: (opts) => decisionsModule.loadDecisions(hippoRoot, tenantId, opts),
    printRow: printDecisionRow,
  });
}

function decideGet(hippoRoot: string, tenantId: string, args: string[]): void {
  const id = idArgOrExit(args, 'Usage: hippo decide get <id>', DECISION.idLabel, parseObjectId);
  const decision = foundOrExit(decisionsModule.loadDecisionById(hippoRoot, tenantId, id), DECISION.noun, id);
  console.log(`Decision #${decision.id}`);
  console.log(`  status: ${decision.status}`);
  console.log(`  text: ${decision.decisionText}`);
  if (decision.context) console.log(`  context: ${decision.context}`);
  printLifecycleTail(decision);
}

function decideClose(hippoRoot: string, tenantId: string, args: string[]): void {
  closeObject(args, DECISION, (id) => decisionsModule.closeDecision(hippoRoot, tenantId, id), parseObjectId);
}

export async function handleDecide({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';
  if (subcommand === 'list') return decideList(hippoRoot, tenantId, flags);
  if (subcommand === 'get') return decideGet(hippoRoot, tenantId, args);
  if (subcommand === 'close') return decideClose(hippoRoot, tenantId, args);
  // Default subcommand: create. args[0] is the decision text.
  await decideCreate(hippoRoot, tenantId, subcommand, flags);
}

async function decideCreate(hippoRoot: string, tenantId: string, decisionText: string, flags: CliFlags): Promise<void> {
  if (!decisionText) exitWithDecideUsage();
  const context = nonEmptyStringFlag(flags, 'context');
  // A value-less `--supersedes` asks to supersede but gives no memory id: reject it rather
  // than silently creating a non-superseding decision.
  if (flagIsTrue(flags, 'supersedes')) {
    printError('--supersedes requires a memory id, e.g. hippo decide "<text>" --supersedes mem_abc123.');
    throw new CliExit(1);
  }
  const supersedesMemId = stringFlag(flags, 'supersedes') ?? null;

  // Backward-compat: --supersedes takes a MEMORY id. Validate it exists and
  // resolve it to the active decision row (if any). Commit the
  // canonical table create+supersede FIRST (inside saveDecision's SAVEPOINT),
  // weaken the old memory LAST (best-effort) so a memory-write failure cannot
  // leave the memory stale without the table reflecting the supersession.
  let supersedesDecisionId: number | undefined;
  let oldEntry: MemoryEntry | null = null;
  if (supersedesMemId) {
    oldEntry = await getMemory(cliApiContext(hippoRoot, tenantId), supersedesMemId);
    if (!oldEntry) {
      printError(`Memory ${supersedesMemId} not found.`);
      throw new CliExit(1);
    }
    supersedesDecisionId =
      decisionsModule.resolveActiveDecisionIdByMemory(hippoRoot, tenantId, supersedesMemId) ?? undefined;
  }

  const decisionPathTags = extractPathTags(process.cwd());
  const created = decisionsModule.saveDecision(hippoRoot, tenantId, {
    decisionText,
    context,
    supersedesDecisionId,
    extraTags: decisionPathTags,
  });

  if (oldEntry) weakenSupersededMemory(hippoRoot, oldEntry, supersedesMemId);

  console.log(`Decision recorded: #${created.id}`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  if (supersedesMemId) printSupersedes(supersedesMemId, supersedesDecisionId);
}

function exitWithDecideUsage(): never {
  printError('Usage: hippo decide "<decision>" [--context "<why>"] [--supersedes <memory-id>]');
  printError('       hippo decide list [--status active|superseded|closed|all] [--limit N]');
  printError('       hippo decide get <id>');
  printError('       hippo decide close <id>');
  throw new CliExit(1);
}

function weakenSupersededMemory(hippoRoot: string, oldEntry: MemoryEntry, supersedesMemId: string | null): void {
  // Best-effort and last: saveDecision already committed. Failing here would make a retry find no active
  // decision for the old memory and create a duplicate active successor, so warn instead.
  try {
    decisionsModule.weakenSupersededMemory(hippoRoot, oldEntry);
  } catch (e) {
    printError(`  warning: decision recorded and superseded, but failed to weaken the prior memory ${supersedesMemId}: ${errorMessage(e)}`);
  }
}

function printSupersedes(supersedesMemId: string, supersedesDecisionId: number | undefined): void {
  const tail =
    supersedesDecisionId !== undefined
      ? ` (decision #${supersedesDecisionId} superseded)`
      : ' (no active decision row; memory weakened only)';
  console.log(`  supersedes memory: ${supersedesMemId}${tail}`);
}

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

  // Default subcommand: open (create). Accept both the documented
  // `incident open "<text>"` form and the bare `incident "<text>"` form: for the
  // `open` keyword the text is args[1], otherwise args[0] IS the text.
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
