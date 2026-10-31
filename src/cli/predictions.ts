// First-class object verbs for predictions: record a claim, close it against the actual, and read the class base rate.

import * as predictionsApi from '../api/objects/predictions.js';
import type { ContextWith } from '../api/types.js';
import { type ClosureState, VALID_CLOSURE_STATES } from '../core/prediction.js';
import type { Prediction } from '../store/predictions.js';
import { cliApiContext } from './api-context.js';
import { printError } from './output.js';
import { parseListLimit, type CliFlags, stringFlag, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { foundOrExit, idArgOrExit, requireStatus } from './object-verbs.js';
import { fail } from './exit.js';

const BASERATE_DECIMALS = 3;
const PREDICTION_NOUN = 'Prediction';

async function predictClose(ctx: ContextWith<'predictions'>, args: string[], flags: CliFlags): Promise<void> {
  const id = idArgOrExit(
    args,
    'Usage: hippo predict close <id> --state <closed|closed-unknown> [--actual <v>] [--note "..."]',
    'prediction',
  );
  const stateRaw = (stringFlag(flags, 'state') ?? '').trim();
  // SAFETY: Set.has only compares by value, so a string outside the closure states is a plain miss.
  if (!VALID_CLOSURE_STATES.has(stateRaw as ClosureState) || stateRaw === 'open') {
    fail(`Invalid --state: "${stateRaw}". Must be one of: closed | closed-unknown.`);
  }
  const actualRaw = flags['actual'];
  const actualValue = actualRaw !== undefined ? Number(actualRaw) : undefined;
  if (actualRaw !== undefined && !Number.isFinite(actualValue)) {
    fail(`Invalid --actual: "${actualRaw}". Must be a number.`);
  }
  const closureNote = stringFlag(flags, 'note');

  const closed = await predictionsApi.closePrediction(ctx, id, {
    // SAFETY: the check above exits unless stateRaw is in VALID_CLOSURE_STATES and not open.
    closureState: stateRaw as Exclude<ClosureState, 'open'>,
    actualValue,
    closureNote,
  });
  console.log(
    `Prediction ${closed.id} closed: state=${closed.closureState}${closed.actualValue !== null ? ` actual=${closed.actualValue}` : ''}`,
  );
}

async function loadPredictionList(
  ctx: ContextWith<'predictions'>,
  status: string,
  classTag: string,
  limit: number,
): Promise<Prediction[]> {
  if (status === 'open') {
    return predictionsApi.listPredictions(ctx, {
      classTag: classTag || undefined,
      closureState: 'open',
      limit,
    });
  }
  if (status === 'all') {
    return predictionsApi.listPredictions(ctx, classTag ? { classTag, limit } : { limit });
  }
  const closureState = requireStatus(status, VALID_CLOSURE_STATES);
  if (!classTag) {
    // status filter without class: scan all classes is more complex; v1 requires --class for non-default status
    fail('--status filter (non-open) requires --class to be set.');
  }
  return predictionsApi.listPredictions(ctx, {
    classTag,
    closureState,
    limit,
  });
}

async function predictList(ctx: ContextWith<'predictions'>, flags: CliFlags): Promise<void> {
  const classTag = stringFlag(flags, 'class')?.trim() ?? '';
  const status = stringFlag(flags, 'status')?.trim() ?? 'all';
  const limit = parseListLimit(flags);

  const results = await loadPredictionList(ctx, status, classTag, limit);
  if (results.length === 0) {
    console.log(classTag ? `No predictions in class "${classTag}".` : 'No predictions.');
    return;
  }
  console.log(`Found ${results.length} predictions:\n`);
  for (const p of results) {
    const estPart =
      p.estimateValue !== null ? ` estimate=${p.estimateValue}${p.estimateUnit ? ` ${p.estimateUnit}` : ''}` : '';
    const actPart = p.actualValue !== null ? ` actual=${p.actualValue}` : '';
    const tgtPart = p.targetDate ? ` target=${p.targetDate}` : '';
    console.log(`#${p.id} [${p.closureState}] class=${p.classTag}${estPart}${actPart}${tgtPart}`);
    console.log(`    ${p.claimText}`);
    if (p.closureNote) console.log(`    note: ${p.closureNote}`);
  }
}

async function predictShow(ctx: ContextWith<'predictions'>, args: string[]): Promise<void> {
  const id = idArgOrExit(args, 'Usage: hippo predict show <id>', 'prediction');
  const pred = foundOrExit(await predictionsApi.predictionById(ctx, id), PREDICTION_NOUN, id);
  console.log(`Prediction #${pred.id}`);
  console.log(`  class: ${pred.classTag}`);
  console.log(`  claim: ${pred.claimText}`);
  console.log(`  state: ${pred.closureState}`);
  if (pred.estimateValue !== null) {
    console.log(`  estimate: ${pred.estimateValue}${pred.estimateUnit ? ' ' + pred.estimateUnit : ''}`);
  }
  if (pred.targetDate) console.log(`  target: ${pred.targetDate}`);
  if (pred.actualValue !== null) console.log(`  actual: ${pred.actualValue}`);
  if (pred.closedAt) console.log(`  closed: ${pred.closedAt}`);
  if (pred.closureNote) console.log(`  note: ${pred.closureNote}`);
  if (pred.memoryId) console.log(`  memory: ${pred.memoryId}`);
  console.log(`  created: ${pred.createdAt}`);
}

async function predictBaserate(ctx: ContextWith<'predictions'>, flags: CliFlags): Promise<void> {
  // Reference-class / planning-fallacy detector
  const classTag = stringFlag(flags, 'class')?.trim();
  if (!classTag) {
    fail('Usage: hippo predict baserate --class <c>');
  }
  const baserate = await predictionsApi.predictionBaserate(ctx, classTag);
  if (baserate.nClosed === 0) {
    console.log(`No closed predictions in class "${baserate.classTag}" yet.`);
    console.log(`  Create one with: hippo predict "<claim>" --class ${baserate.classTag} --estimate N`);
    console.log(`  Close it later:  hippo predict close <id> --state closed --actual N`);
    return;
  }
  console.log(baserate.summary);
  console.log(`  n_closed:         ${baserate.nClosed}`);
  console.log(`  n_ratio_eligible: ${baserate.nRatioEligible}`);
  if (baserate.meanEstimate !== null) {
    console.log(`  mean_estimate:    ${baserate.meanEstimate.toFixed(BASERATE_DECIMALS)}`);
  }
  if (baserate.meanActual !== null) {
    console.log(`  mean_actual:      ${baserate.meanActual.toFixed(BASERATE_DECIMALS)}`);
  }
  if (baserate.meanRatio !== null) console.log(`  mean_ratio:       ${baserate.meanRatio.toFixed(BASERATE_DECIMALS)}x`);
  if (baserate.p50Ratio !== null) console.log(`  p50_ratio:        ${baserate.p50Ratio.toFixed(BASERATE_DECIMALS)}x`);
  if (baserate.mae !== null)          console.log(`  mae:              ${baserate.mae.toFixed(BASERATE_DECIMALS)}`);
}

export async function handlePredict({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const ctx = cliApiContext(hippoRoot, tenantId);
  const subcommand = args[0] ?? '';
  if (subcommand === 'close') return predictClose(ctx, args, flags);
  if (subcommand === 'list') return predictList(ctx, flags);
  if (subcommand === 'show') return predictShow(ctx, args);
  if (subcommand === 'baserate') return predictBaserate(ctx, flags);
  // Default subcommand: create. args[0] is the claim text.
  return predictCreate(ctx, subcommand, flags);
}

async function predictCreate(ctx: ContextWith<'predictions'>, claimText: string, flags: CliFlags): Promise<void> {
  if (!claimText) {
    printError('Usage: hippo predict "<claim>" --class <c> [--estimate <v>] [--unit <u>] [--target <YYYY-MM-DD>]');
    printError('       hippo predict close <id> --state <closed|closed-unknown> [--actual <v>] [--note "..."]');
    printError('       hippo predict list [--class X] [--status open|closed|closed-unknown|all] [--limit N]');
    fail('       hippo predict show <id>');
  }
  const classTag = stringFlag(flags, 'class')?.trim();
  if (!classTag) {
    fail('--class is required for prediction creation.');
  }
  const estimateRaw = flags['estimate'];
  const estimateValue = estimateRaw !== undefined ? Number(estimateRaw) : undefined;
  if (estimateRaw !== undefined && !Number.isFinite(estimateValue)) {
    fail(`Invalid --estimate: "${estimateRaw}". Must be a number.`);
  }
  const estimateUnit = stringFlag(flags, 'unit');
  const targetDate = stringFlag(flags, 'target');

  const created = await predictionsApi.recordPrediction(ctx, {
    classTag,
    claimText,
    estimateValue,
    estimateUnit,
    targetDate,
  });
  console.log(`Prediction recorded: #${created.id} class=${created.classTag}`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
}
