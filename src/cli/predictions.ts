// First-class object verbs for predictions: record a claim, close it against the actual, and read the class base rate.

import * as predictionsModule from '../store/predictions.js';
import { printError } from './output.js';
import { parseListLimit, type CliFlags, stringFlag, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { foundOrExit, idArgOrExit, requireStatus } from './object-verbs.js';
import { parseObjectId } from './lenient-id.js';
import { CliExit } from './exit.js';

const BASERATE_DECIMALS = 3;
const PREDICTION_NOUN = 'Prediction';

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

function loadPredictionList(hippoRoot: string, tenantId: string, status: string, classTag: string, limit: number): predictionsModule.Prediction[] {
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
    // status filter without class: scan all classes is more complex; v1 requires --class for non-default status
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
