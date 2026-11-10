// First-class object verbs for decisions: record one (optionally superseding an older one's
// memory), list, get, close.

import type { Decision } from '../../base/records/object-types.js';
import { memoryGet } from '../../api/memories/memories.js';
import { decisionIdByMemory } from '../../api/objects/object-kinds.js';
import {
  objectClose,
  objectCreate,
  objectGet,
  objectList,
  objectStates,
  type ObjectWrites,
} from '../../api/objects/objects.js';
import { printError } from './output.js';
import {
  type CliFlags,
  type CommandContext,
  flagValueless,
  nonEmptyStringFlag,
  stringFlag,
} from './flag-values.js';
import { requireInit } from './shared.js';
import { cliApiContext } from './api-context.js';
import type { ContextWith } from '../../api/types.js';
import {
  closeObjectVerb,
  foundOrExit,
  idArgOrExit,
  listObjectsVerb,
  printLifecycleTail,
  type ObjectNames,
} from './object-verbs.js';
import { fail } from './exit.js';
import { shellFolder } from './versioned-verbs.js';

const DECISION: ObjectNames = { cmd: 'decide', noun: 'Decision', idLabel: 'decision' };
const NOT_RECORDED =
  'The decision was NOT recorded. Nothing changed, so it is safe to run the command again.';

function printDecisionRow(d: Decision): void {
  const supPart = d.supersededBy !== null ? ` superseded_by=#${d.supersededBy}` : '';
  console.log(`#${d.id} [${d.status}]${supPart} memory=${d.memoryId ?? '-'}`);
  console.log(`    ${d.decisionText}`);
  if (d.context) console.log(`    context: ${d.context}`);
}

function decideList(ctx: ContextWith<'objects'>, flags: CliFlags): Promise<void> {
  return listObjectsVerb(flags, {
    plural: 'decisions',
    states: objectStates('decision'),
    load: (opts) => objectList(ctx, 'decision', opts),
    printRow: printDecisionRow,
  });
}

async function decideGet(ctx: ContextWith<'objects'>, args: string[]): Promise<void> {
  const id = idArgOrExit(args, 'Usage: hippo decide get <id>', DECISION.idLabel);
  const decision = foundOrExit(await objectGet(ctx, 'decision', id), DECISION.noun, id);
  console.log(`Decision #${decision.id}`);
  console.log(`  status: ${decision.status}`);
  console.log(`  text: ${decision.decisionText}`);
  if (decision.context) console.log(`  context: ${decision.context}`);
  printLifecycleTail(decision);
}

function decideClose(ctx: ContextWith<'objects'>, args: string[]): Promise<void> {
  return closeObjectVerb(args, DECISION, (id) => objectClose(ctx, 'decision', id));
}

export async function handleDecide({
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';
  const ctx = cliApiContext(hippoRoot, tenantId);
  if (subcommand === 'list') return decideList(ctx, flags);
  if (subcommand === 'get') return decideGet(ctx, args);
  if (subcommand === 'close') return decideClose(ctx, args);
  // Default subcommand: create. args[0] is the decision text.
  await decideCreate(ctx, subcommand, flags);
}

async function decideCreate(
  ctx: ContextWith<'objects'>,
  decisionText: string,
  flags: CliFlags,
): Promise<void> {
  if (!decisionText) exitWithDecideUsage();
  const context = nonEmptyStringFlag(flags, 'context');
  // A value-less `--supersedes` asks to supersede but gives no memory id: reject it rather than
  // silently creating a non-superseding decision.
  if (flagValueless(flags, 'supersedes')) {
    fail('--supersedes requires a memory id, e.g. hippo decide "<text>" --supersedes mem_abc123.');
  }
  const supersedesMemId = stringFlag(flags, 'supersedes') ?? null;

  // The save weakens the old memory in the same write. A decision row backing the memory is
  // weakened through its supersede link; a plain memory is named so the save weakens it too.
  let supersedesDecisionId: number | undefined;
  let weakensMemoryId: string | undefined;
  if (supersedesMemId) {
    if (!(await memoryGet(ctx, supersedesMemId))) {
      fail(`Memory ${supersedesMemId} not found.`);
    }
    supersedesDecisionId = (await decisionIdByMemory(ctx, supersedesMemId)) ?? undefined;
    if (supersedesDecisionId === undefined) weakensMemoryId = supersedesMemId;
  }

  const write = { decisionText, context, supersedesDecisionId, weakensMemoryId };
  const created = await recordDecision(ctx, write, Boolean(supersedesMemId));

  console.log(`Decision recorded: #${created.id}`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  if (supersedesMemId) printSupersedes(supersedesMemId, supersedesDecisionId);
}

function exitWithDecideUsage(): never {
  printError('Usage: hippo decide "<decision>" [--context "<why>"] [--supersedes <memory-id>]');
  printError('       hippo decide list [--status active|superseded|closed|all] [--limit N]');
  printError('       hippo decide get <id>');
  fail('       hippo decide close <id>');
}

async function recordDecision(
  ctx: ContextWith<'objects'>,
  write: ObjectWrites['decision'],
  supersedes: boolean,
): Promise<Decision> {
  try {
    return await objectCreate(ctx, 'decision', write, shellFolder());
  } catch (e) {
    // The save is whole or nothing, so the user needs to know a retry cannot duplicate.
    if (supersedes) printError(NOT_RECORDED);
    throw e;
  }
}

function printSupersedes(supersedesMemId: string, supersedesDecisionId: number | undefined): void {
  const tail =
    supersedesDecisionId !== undefined
      ? ` (decision #${supersedesDecisionId} superseded)`
      : ' (no active decision row; memory weakened only)';
  console.log(`  supersedes memory: ${supersedesMemId}${tail}`);
}
