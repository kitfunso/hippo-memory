// First-class object verbs for decisions: record one (optionally superseding an older one's memory), list, get, close.

import { MemoryEntry } from '../core/memory.js';
import { getMemory } from '../api/memories/memories.js';
import { objectsOf } from '../api/objects/objects.js';
import type { Objects } from '../store/port.js';
import { extractPathTags } from '../search/path-context.js';
import * as decisionsModule from '../objects/decisions.js';
import { printError } from './output.js';
import { nonEmptyStringFlag, type CliFlags, flagIsTrue, stringFlag, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { cliApiContext } from './api-context.js';
import type { ContextWith } from '../api/index.js';
import {
  closeObject,
  foundOrExit,
  idArgOrExit,
  listObjects,
  printLifecycleTail,
  type ObjectNames,
} from './object-verbs.js';
import { errorMessage } from '../util/log.js';
import { fail } from './exit.js';

const DECISION: ObjectNames = { cmd: 'decide', noun: 'Decision', idLabel: 'decision' };

function printDecisionRow(d: decisionsModule.Decision): void {
  const supPart = d.supersededBy !== null ? ` superseded_by=#${d.supersededBy}` : '';
  console.log(`#${d.id} [${d.status}]${supPart} memory=${d.memoryId ?? '-'}`);
  console.log(`    ${d.decisionText}`);
  if (d.context) console.log(`    context: ${d.context}`);
}

function decideList(objects: Objects, tenantId: string, flags: CliFlags): Promise<void> {
  return listObjects(flags, {
    plural: 'decisions',
    states: decisionsModule.VALID_DECISION_STATES,
    load: (opts) => decisionsModule.loadDecisions(objects, tenantId, opts),
    printRow: printDecisionRow,
  });
}

async function decideGet(objects: Objects, tenantId: string, args: string[]): Promise<void> {
  const id = idArgOrExit(args, 'Usage: hippo decide get <id>', DECISION.idLabel);
  const decision = foundOrExit(await decisionsModule.loadDecisionById(objects, tenantId, id), DECISION.noun, id);
  console.log(`Decision #${decision.id}`);
  console.log(`  status: ${decision.status}`);
  console.log(`  text: ${decision.decisionText}`);
  if (decision.context) console.log(`  context: ${decision.context}`);
  printLifecycleTail(decision);
}

function decideClose(objects: Objects, tenantId: string, args: string[]): Promise<void> {
  return closeObject(args, DECISION, (id) => decisionsModule.closeDecision(objects, tenantId, id));
}

export async function handleDecide({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';
  const ctx = cliApiContext(hippoRoot, tenantId);
  const objects = objectsOf(ctx);
  if (subcommand === 'list') return decideList(objects, tenantId, flags);
  if (subcommand === 'get') return decideGet(objects, tenantId, args);
  if (subcommand === 'close') return decideClose(objects, tenantId, args);
  // Default subcommand: create. args[0] is the decision text.
  await decideCreate(ctx, subcommand, flags);
}

async function decideCreate(ctx: ContextWith<'objects'>, decisionText: string, flags: CliFlags): Promise<void> {
  const { hippoRoot, tenantId } = ctx;
  if (!decisionText) exitWithDecideUsage();
  const context = nonEmptyStringFlag(flags, 'context');
  // A value-less `--supersedes` asks to supersede but gives no memory id: reject it rather
  // than silently creating a non-superseding decision.
  if (flagIsTrue(flags, 'supersedes')) {
    fail('--supersedes requires a memory id, e.g. hippo decide "<text>" --supersedes mem_abc123.');
  }
  const supersedesMemId = stringFlag(flags, 'supersedes') ?? null;

  // Commit the table create+supersede first (inside saveDecision's SAVEPOINT) and weaken the old memory last,
  // best-effort, so a memory-write failure cannot leave the memory stale while the table shows the supersession.
  let supersedesDecisionId: number | undefined;
  let oldEntry: MemoryEntry | null = null;
  if (supersedesMemId) {
    oldEntry = await getMemory(ctx, supersedesMemId);
    if (!oldEntry) {
      fail(`Memory ${supersedesMemId} not found.`);
    }
    supersedesDecisionId =
      (await decisionsModule.resolveActiveDecisionIdByMemory(objectsOf(ctx), tenantId, supersedesMemId)) ?? undefined;
  }

  const decisionPathTags = extractPathTags(process.cwd());
  const created = await decisionsModule.saveDecision(objectsOf(ctx), hippoRoot, tenantId, {
    decisionText,
    context,
    supersedesDecisionId,
    extraTags: decisionPathTags,
  });

  if (oldEntry) weakenOrWarn(hippoRoot, oldEntry, supersedesMemId);

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

function weakenOrWarn(hippoRoot: string, oldEntry: MemoryEntry, supersedesMemId: string | null): void {
  // Best-effort and last: saveDecision already committed. Failing here would make a retry find no active
  // decision for the old memory and create a duplicate active successor, so warn instead.
  try {
    decisionsModule.weakenSupersededMemory(hippoRoot, oldEntry);
  } catch (e) {
    printError(
      `  warning: decision recorded and superseded, but failed to weaken the prior memory ${supersedesMemId}: ${errorMessage(e)}`,
    );
  }
}

function printSupersedes(supersedesMemId: string, supersedesDecisionId: number | undefined): void {
  const tail =
    supersedesDecisionId !== undefined
      ? ` (decision #${supersedesDecisionId} superseded)`
      : ' (no active decision row; memory weakened only)';
  console.log(`  supersedes memory: ${supersedesMemId}${tail}`);
}
