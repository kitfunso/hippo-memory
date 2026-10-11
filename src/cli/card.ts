// The `hippo card` verb (the agent work board); main() loads it lazily from the command table.

import * as cardsApi from '../api/cards.js';
import { cliApiContext } from './api-context.js';
import { isHandoffOutcome } from '../core/handoff.js';
import { type Card, isCardStatus } from '../core/card.js';
import type { CardDetail } from '../store/card-detail.js';
import { printError } from './output.js';
import { type CliFlags, stringFlagOrExit, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { errorMessage } from '../util/log.js';
import { CliExit } from './exit.js';

// Mirrors ARCHIVE_REASON_REQUIRED so the block message can't drift from its usage line.
const CARD_BLOCK_REASON_REQUIRED = 'hippo card block <id> requires --reason "<why>" (recorded as a comment).';

function printCard(detail: CardDetail): void {
  const { card, deps, runs, comments, handoff } = detail;
  console.log(`## Card ${card.id}\n`);
  console.log(`- Title: ${card.title}`);
  console.log(`- Status: ${card.status}`);
  if (card.assigneeRuntime) console.log(`- Assignee: ${card.assigneeRuntime}`);
  if (card.leaseUntil) console.log(`- Lease until: ${card.leaseUntil}`);
  if (card.heartbeatAt) console.log(`- Heartbeat: ${card.heartbeatAt}`);
  if (card.repo) console.log(`- Repo: ${card.repo}`);
  if (card.contract) console.log(`- Contract: ${card.contract}`);
  if (card.budget !== null) console.log(`- Budget: ${card.budget}`);
  console.log(`- Updated: ${card.updatedAt}`);

  if (deps.parents.length > 0) console.log(`- Parents: ${deps.parents.join(', ')}`);
  if (deps.children.length > 0) console.log(`- Children: ${deps.children.join(', ')}`);

  if (runs.length > 0) {
    console.log('\n### Runs');
    for (const run of runs) {
      console.log(`- run ${run.id}: ${run.runtime} started ${run.started}${run.ended ? ` ended ${run.ended} (${run.outcome})` : ' (open)'}`);
    }
  }

  if (comments.length > 0) {
    console.log('\n### Comments');
    for (const comment of comments) {
      console.log(`- [${comment.createdAt}] ${comment.author}: ${comment.body}`);
    }
  }

  if (handoff) {
    console.log('\n### Latest handoff');
    console.log(`- Session: ${handoff.sessionId}, updated ${handoff.updatedAt}`);
    console.log(handoff.summary);
  }
  console.log('');
}

// A too-large --run would silently round to a different id (mirrors parsePositiveIncidentId).
function cardRunFlag(flags: CliFlags): number | undefined {
  const raw = stringFlagOrExit(flags, 'run');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) {
    printError(`Invalid --run: "${raw}" (expected a positive integer).`);
    throw new CliExit(1);
  }
  return n;
}

// Reads after the store already refused, so this only explains the refusal, never changes it.
function cardRefusal(hippoRoot: string, tenantId: string, id: string): string {
  const ctx = cliApiContext(hippoRoot, tenantId);
  const card = cardsApi.cardLoad(ctx, id);
  const liveRun = cardsApi.cardRuns(ctx, id).find((r) => !r.ended);
  return `status ${card?.status ?? 'unknown'}, live run ${liveRun?.id ?? 'none'}`;
}

// One entry per subcommand: the flags handleCard actually reads for it, so a typo like
// --depend-on fails fast instead of silently doing nothing.
type CardSubcommand = 'create' | 'show' | 'list' | 'claim' | 'heartbeat' | 'block' | 'review' | 'complete' | 'reclaim' | 'comment';

const CARD_SUBCOMMAND_FLAGS = {
  create: ['title', 'repo', 'contract', 'budget', 'depends-on'],
  show: ['json'],
  list: ['status', 'json'],
  claim: ['runtime', 'session'],
  heartbeat: ['run'],
  block: ['reason', 'run'],
  review: ['run'],
  complete: ['outcome', 'run'],
  reclaim: new Array<string>(),
  comment: ['body', 'author'],
} satisfies Record<CardSubcommand, string[]>;

type CardHandler = (hippoRoot: string, tenantId: string, args: string[], flags: CliFlags) => void;

/** Runs `hippo card <subcommand>`: rejects flags the subcommand never reads, then hands off to its handler. */
export function handleCard({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';

  if (!Object.hasOwn(CARD_SUBCOMMAND_FLAGS, subcommand)) {
    printError('Usage: hippo card <create|show|list|claim|heartbeat|block|review|complete|reclaim|comment>');
    throw new CliExit(1);
  }
  // SAFETY: hasOwn, unlike `in`, skips inherited keys such as constructor, so subcommand is a real key.
  const known = subcommand as CardSubcommand;
  const allowedFlags = CARD_SUBCOMMAND_FLAGS[known];
  for (const key of Object.keys(flags)) {
    if (!allowedFlags.includes(key)) {
      const valid = allowedFlags.length > 0 ? allowedFlags.map((f) => `--${f}`).join(', ') : '(none)';
      printError(`Unknown flag --${key} for hippo card ${subcommand}. Valid flags: ${valid}`);
      throw new CliExit(1);
    }
  }
  CARD_HANDLERS[known](hippoRoot, tenantId, args, flags);
}

function cardCreate(hippoRoot: string, tenantId: string, _args: string[], flags: CliFlags): void {
  const title = stringFlagOrExit(flags, 'title') ?? '';
  if (!title) {
    printError('Usage: hippo card create --title "..." [--repo <name>] [--contract <text>] [--budget <n>] [--depends-on <id>...]');
    throw new CliExit(1);
  }
  const repo = stringFlagOrExit(flags, 'repo') || undefined;
  const contract = stringFlagOrExit(flags, 'contract') || undefined;
  const budgetRaw = stringFlagOrExit(flags, 'budget');
  let budget: number | undefined;
  if (budgetRaw !== undefined) {
    if (!/^\d+$/.test(budgetRaw)) {
      printError(`Invalid budget: "${budgetRaw}" (expected a positive integer)`);
      throw new CliExit(1);
    }
    budget = Number(budgetRaw);
  }
  const dependsOnFlag = flags['depends-on'];
  if (dependsOnFlag === true) {
    printError('--depends-on requires a value');
    throw new CliExit(1);
  }
  const dependsOn: string[] = Array.isArray(dependsOnFlag) ? dependsOnFlag : [];

  let card: Card;
  try {
    card = cardsApi.cardCreate(cliApiContext(hippoRoot, tenantId), { title, repo, contract, budget, dependsOn });
  } catch (error) {
    printError(errorMessage(error));
    throw new CliExit(1);
  }
  console.log(`Created card ${card.id} (status: ${card.status})`);
}

function cardShow(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const id = args[1];
  if (!id) {
    printError('Usage: hippo card show <id> [--json]');
    throw new CliExit(1);
  }
  const detail = cardsApi.cardDetail(cliApiContext(hippoRoot, tenantId), id);
  if (!detail) {
    printError(`No card found with id ${id}.`);
    throw new CliExit(1);
  }
  if (flags['json']) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }
  printCard(detail);
}

function cardList(hippoRoot: string, tenantId: string, _args: string[], flags: CliFlags): void {
  const status = stringFlagOrExit(flags, 'status');
  if (status !== undefined && !isCardStatus(status)) {
    printError(`Invalid status: "${status}".`);
    throw new CliExit(1);
  }
  const cards = cardsApi.cardList(cliApiContext(hippoRoot, tenantId), { status });
  if (flags['json']) {
    console.log(JSON.stringify({ cards }, null, 2));
    return;
  }
  if (cards.length === 0) {
    console.log('No cards found.');
    return;
  }
  for (const card of cards) {
    console.log(`${card.id}\t${card.status}\t${card.title}${card.assigneeRuntime ? `\t(${card.assigneeRuntime})` : ''}`);
  }
}

function cardClaim(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const id = args[1];
  const runtime = stringFlagOrExit(flags, 'runtime') ?? '';
  if (!id || !runtime) {
    printError('Usage: hippo card claim <id> --runtime <name> [--session <id>]');
    throw new CliExit(1);
  }
  const sessionId = stringFlagOrExit(flags, 'session') || undefined;
  let card: (Card & { runId: number }) | null;
  try {
    card = cardsApi.cardClaim(cliApiContext(hippoRoot, tenantId), id, runtime, sessionId);
  } catch (error) {
    printError(errorMessage(error));
    throw new CliExit(1);
  }
  if (!card) {
    printError(`Could not claim card ${id} (not ready/blocked, or already claimed).`);
    throw new CliExit(1);
  }
  console.log(`Claimed card ${card.id} for ${runtime} (run ${card.runId}, lease until ${card.leaseUntil})`);
}

function cardHeartbeat(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const id = args[1];
  const runId = cardRunFlag(flags);
  if (!id || runId === undefined) {
    printError('Usage: hippo card heartbeat <id> --run <n>');
    throw new CliExit(1);
  }
  let card: Card | null;
  try {
    card = cardsApi.cardHeartbeat(cliApiContext(hippoRoot, tenantId), id, runId);
  } catch (error) {
    printError(errorMessage(error));
    throw new CliExit(1);
  }
  if (!card) {
    printError(`Could not heartbeat card ${id} (${cardRefusal(hippoRoot, tenantId, id)}).`);
    throw new CliExit(1);
  }
  console.log(`Heartbeat card ${card.id}: lease until ${card.leaseUntil}`);
}

function cardBlock(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const id = args[1];
  const reason = stringFlagOrExit(flags, 'reason') ?? '';
  if (!id || !reason) {
    printError(CARD_BLOCK_REASON_REQUIRED);
    throw new CliExit(1);
  }
  const runId = cardRunFlag(flags);
  let card: Card | null;
  try {
    card = cardsApi.cardBlock(cliApiContext(hippoRoot, tenantId), id, reason, runId);
  } catch (error) {
    printError(errorMessage(error));
    throw new CliExit(1);
  }
  if (!card) {
    const why = runId === undefined ? 'not running' : cardRefusal(hippoRoot, tenantId, id);
    printError(`Could not block card ${id} (${why}).`);
    throw new CliExit(1);
  }
  console.log(`Blocked card ${card.id}`);
}

function cardReview(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const id = args[1];
  if (!id) {
    printError('Usage: hippo card review <id> [--run <n>]');
    throw new CliExit(1);
  }
  const runId = cardRunFlag(flags);
  let card: Card | null;
  try {
    card = cardsApi.cardReview(cliApiContext(hippoRoot, tenantId), id, runId);
  } catch (error) {
    printError(errorMessage(error));
    throw new CliExit(1);
  }
  if (!card) {
    const why = runId === undefined ? 'not running' : cardRefusal(hippoRoot, tenantId, id);
    printError(`Could not move card ${id} to review (${why}).`);
    throw new CliExit(1);
  }
  console.log(`Card ${card.id} moved to review`);
}

function cardComplete(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const id = args[1];
  const outcomeRaw = flags['outcome'];
  if (!id || !isHandoffOutcome(outcomeRaw)) {
    printError('Usage: hippo card complete <id> --outcome <success|failure|partial> [--run <n>]');
    throw new CliExit(1);
  }
  const runId = cardRunFlag(flags);
  let result: { card: Card; promotedChildren: string[] } | null;
  try {
    result = cardsApi.cardComplete(cliApiContext(hippoRoot, tenantId), id, outcomeRaw, runId);
  } catch (error) {
    printError(errorMessage(error));
    throw new CliExit(1);
  }
  if (!result) {
    const why = runId === undefined ? 'not in review' : cardRefusal(hippoRoot, tenantId, id);
    printError(`Could not complete card ${id} (${why}).`);
    throw new CliExit(1);
  }
  console.log(`Completed card ${result.card.id} (status: ${result.card.status})`);
  if (result.promotedChildren.length > 0) {
    console.log(`Promoted to ready: ${result.promotedChildren.join(', ')}`);
  }
}

function cardReclaim(hippoRoot: string, tenantId: string, args: string[]): void {
  if (args.length > 1) {
    printError('Usage: hippo card reclaim (sweeps every expired lease; use hippo card block <id> for one card)');
    throw new CliExit(1);
  }
  const ids = cardsApi.cardReclaimExpired(cliApiContext(hippoRoot, tenantId));
  if (ids.length === 0) {
    console.log('No expired leases.');
    return;
  }
  for (const id of ids) {
    console.log(`Reclaimed card ${id} (now ready)`);
  }
}

function cardComment(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const id = args[1];
  if (!id) {
    printError('Usage: hippo card comment <id> --body "..." [--author <name>]');
    throw new CliExit(1);
  }
  // Only show and comment look the card up directly; claim/heartbeat/block/review/complete throw from the store instead.
  const ctx = cliApiContext(hippoRoot, tenantId);
  const card = cardsApi.cardLoad(ctx, id);
  if (!card) {
    printError(`No card found with id ${id}.`);
    throw new CliExit(1);
  }
  const body = stringFlagOrExit(flags, 'body') ?? '';
  if (!body) {
    printError('Usage: hippo card comment <id> --body "..." [--author <name>]');
    throw new CliExit(1);
  }
  const author = stringFlagOrExit(flags, 'author') || 'cli';
  const comment = cardsApi.cardComment(ctx, id, author, body);
  console.log(`Added comment ${comment.id} to card ${id}`);
}

const CARD_HANDLERS = {
  create: cardCreate,
  show: cardShow,
  list: cardList,
  claim: cardClaim,
  heartbeat: cardHeartbeat,
  block: cardBlock,
  review: cardReview,
  complete: cardComplete,
  reclaim: cardReclaim,
  comment: cardComment,
} satisfies Readonly<Record<CardSubcommand, CardHandler>>;
