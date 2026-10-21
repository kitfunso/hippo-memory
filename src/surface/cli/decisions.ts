// First-class object verbs for decisions: record one (optionally superseding an older one's memory), list, get, close.

import { MemoryEntry } from '../../base/memory/memory.js';
import type { Decision } from '../../base/records/object-types.js';
import { memoryGet } from '../../api/memories/memories.js';
import { decisionIdByMemory, decisionMemoryWeaken } from '../../api/objects/object-kinds.js';
import { objectClose, objectCreate, objectGet, objectList, objectStates } from '../../api/objects/objects.js';
import { printError } from './output.js';
import { type CliFlags, type CommandContext, flagValueless, nonEmptyStringFlag, stringFlag } from './flag-values.js';
import { requireInit } from './shared.js';
import { cliApiContext } from './api-context.js';
import type { Context } from '../../api/index.js';
import {
  closeObject,
  foundOrExit,
  idArgOrExit,
  listObjects,
  printLifecycleTail,
  type ObjectNames,
} from './object-verbs.js';
import { errorMessage } from '../../base/util/log.js';
import { fail } from './exit.js';
import { shellFolder } from './versioned-verbs.js';

const DECISION: ObjectNames = { cmd: 'decide', noun: 'Decision', idLabel: 'decision' };

function printDecisionRow(d: Decision): void {
  const supPart = d.supersededBy !== null ? ` superseded_by=#${d.supersededBy}` : '';
  console.log(`#${d.id} [${d.status}]${supPart} memory=${d.memoryId ?? '-'}`);
  console.log(`    ${d.decisionText}`);
  if (d.context) console.log(`    context: ${d.context}`);
}

function decideList(ctx: Context, flags: CliFlags): Promise<void> {
  return listObjects(flags, {
    plural: 'decisions',
    states: objectStates('decision'),
    load: (opts) => objectList(ctx, 'decision', opts),
    printRow: printDecisionRow,
  });
}

async function decideGet(ctx: Context, args: string[]): Promise<void> {
  const id = idArgOrExit(args, 'Usage: hippo decide get <id>', DECISION.idLabel);
  const decision = foundOrExit(await objectGet(ctx, 'decision', id), DECISION.noun, id);
  console.log(`Decision #${decision.id}`);
  console.log(`  status: ${decision.status}`);
  console.log(`  text: ${decision.decisionText}`);
  if (decision.context) console.log(`  context: ${decision.context}`);
  printLifecycleTail(decision);
}

function decideClose(ctx: Context, args: string[]): Promise<void> {
  return closeObject(args, DECISION, (id) => objectClose(ctx, 'decision', id));
}

export async function handleDecide({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';
  const ctx = cliApiContext(hippoRoot, tenantId);
  if (subcommand === 'list') return decideList(ctx, flags);
  if (subcommand === 'get') return decideGet(ctx, args);
  if (subcommand === 'close') return decideClose(ctx, args);
  // Default subcommand: create. args[0] is the decision text.
  await decideCreate(ctx, subcommand, flags);
}

async function decideCreate(ctx: Context, decisionText: string, flags: CliFlags): Promise<void> {
  if (!decisionText) exitWithDecideUsage();
  const context = nonEmptyStringFlag(flags, 'context');
  // A value-less `--supersedes` asks to supersede but gives no memory id: reject it rather than silently creating a
  // non-superseding decision.
  if (flagValueless(flags, 'supersedes')) {
    fail('--supersedes requires a memory id, e.g. hippo decide "<text>" --supersedes mem_abc123.');
  }
  const supersedesMemId = stringFlag(flags, 'supersedes') ?? null;

  // Commit the table create+supersede first (inside the save's SAVEPOINT) and weaken the old memory last,
  // best-effort, so a memory-write failure cannot leave the memory stale while the table shows the supersession.
  let supersedesDecisionId: number | undefined;
  let oldEntry: MemoryEntry | null = null;
  if (supersedesMemId) {
    oldEntry = await memoryGet(ctx, supersedesMemId);
    if (!oldEntry) {
      fail(`Memory ${supersedesMemId} not found.`);
    }
    supersedesDecisionId = (await decisionIdByMemory(ctx, supersedesMemId)) ?? undefined;
  }

  const write = { decisionText, context, supersedesDecisionId };
  const created = await objectCreate(ctx, 'decision', write, shellFolder());

  if (oldEntry) await weakenOrWarn(ctx, oldEntry, supersedesMemId);

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

async function weakenOrWarn(ctx: Context, oldEntry: MemoryEntry, supersedesMemId: string | null): Promise<void> {
  // Best-effort and last: the decision already committed. Failing here would make a retry find no active decision for
  // the old memory and create a duplicate active successor, so warn instead.
  try {
    await decisionMemoryWeaken(ctx, oldEntry);
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
