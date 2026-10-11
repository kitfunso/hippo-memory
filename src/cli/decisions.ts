// First-class object verbs for decisions: record one (optionally superseding an older one's memory), list, get, close.

import { MemoryEntry } from '../core/memory.js';
import { getMemory } from '../api/memories.js';
import { extractPathTags } from '../search/path-context.js';
import * as decisionsModule from '../objects/decisions.js';
import { printError } from './output.js';
import { nonEmptyStringFlag, type CliFlags, flagIsTrue, stringFlag, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { cliApiContext } from './api-context.js';
import { closeObject, foundOrExit, idArgOrExit, listObjects, printLifecycleTail, type ObjectNames } from './object-verbs.js';
import { parseObjectId } from './lenient-id.js';
import { errorMessage } from '../util/log.js';
import { CliExit } from './exit.js';

const DECISION: ObjectNames = { cmd: 'decide', noun: 'Decision', idLabel: 'decision' };

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

  // Commit the table create+supersede first (inside saveDecision's SAVEPOINT) and weaken the old memory last, best-effort,
  // so a memory-write failure cannot leave the memory stale while the table shows the supersession.
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
