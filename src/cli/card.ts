// The `hippo card` verb (the agent work board); main() loads it lazily from the command table.

import * as cardsApi from '../api/objects/cards.js';
import { cliApiContext } from './api-context.js';
import { isHandoffOutcome } from '../core/handoff.js';
import { type Card, isCardStatus } from '../core/card.js';
import type { CardDetail } from '../store/card-detail.js';
import { printError } from './output.js';
import { type CliFlags, stringFlagOrExit, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { errorMessage } from '../util/log.js';
import { CliExit, fail } from './exit.js';

// Each subcommand's usage line, written once so the repeated checks cannot drift.
const CARD_USAGE = {
  create: 'hippo card create --title "..." [--repo <name>] [--contract <text>] [--budget <n>] [--depends-on <id>...]',
  show: 'hippo card show <id> [--json]',
  claim: 'hippo card claim <id> --runtime <name> [--session <id>]',
  heartbeat: 'hippo card heartbeat <id> --run <n>',
  review: 'hippo card review <id> [--run <n>]',
  complete: 'hippo card complete <id> --outcome <success|failure|partial> [--run <n>]',
  reclaim: 'hippo card reclaim (sweeps every expired lease; use hippo card block <id> for one card)',
  comment: 'hippo card comment <id> --body "..." [--author <name>]',
} as const;

function usageError(sub: keyof typeof CARD_USAGE): CliExit {
  printError(`Usage: ${CARD_USAGE[sub]}`);
  return new CliExit(1);
}

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
      const ended = run.ended ? ` ended ${run.ended} (${run.outcome})` : ' (open)';
      console.log(`- run ${run.id}: ${run.runtime} started ${run.started}${ended}`);
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
    fail(`Invalid --run: "${raw}" (expected a positive integer).`);
  }
  return n;
}

// Reads after the store already refused, so this only explains the refusal, never changes it.
async function cardRefusal(hippoRoot: string, tenantId: string, id: string): Promise<string> {
  const ctx = cliApiContext(hippoRoot, tenantId);
  const card = await cardsApi.cardLoad(ctx, id);
  const liveRun = (await cardsApi.cardRuns(ctx, id)).find((r) => !r.ended);
  return `status ${card?.status ?? 'unknown'}, live run ${liveRun?.id ?? 'none'}`;
}

// One entry per subcommand: the flags handleCard actually reads for it, so a typo like
// --depend-on fails fast instead of silently doing nothing.
type CardSubcommand =
  | 'create'
  | 'show'
  | 'list'
  | 'claim'
  | 'heartbeat'
  | 'block'
  | 'review'
  | 'complete'
  | 'reclaim'
  | 'comment';

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

type CardHandler = (hippoRoot: string, tenantId: string, args: string[], flags: CliFlags) => Promise<void>;

/** Runs `hippo card <subcommand>`: rejects flags the subcommand never reads, then hands off to its handler. */
export function handleCard({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';

  if (!Object.hasOwn(CARD_SUBCOMMAND_FLAGS, subcommand)) {
    fail('Usage: hippo card <create|show|list|claim|heartbeat|block|review|complete|reclaim|comment>');
  }
  // SAFETY: hasOwn, unlike `in`, skips inherited keys such as constructor, so subcommand is a real key.
  const known = subcommand as CardSubcommand;
  const allowedFlags = CARD_SUBCOMMAND_FLAGS[known];
  for (const key of Object.keys(flags)) {
    if (!allowedFlags.includes(key)) {
      const valid = allowedFlags.length > 0 ? allowedFlags.map((f) => `--${f}`).join(', ') : '(none)';
      fail(`Unknown flag --${key} for hippo card ${subcommand}. Valid flags: ${valid}`);
    }
  }
  return CARD_HANDLERS[known](hippoRoot, tenantId, args, flags);
}

async function cardCreate(hippoRoot: string, tenantId: string, _args: string[], flags: CliFlags): Promise<void> {
  const title = stringFlagOrExit(flags, 'title') ?? '';
  if (!title) {
    throw usageError('create');
  }
  const repo = stringFlagOrExit(flags, 'repo') || undefined;
  const contract = stringFlagOrExit(flags, 'contract') || undefined;
  const budgetRaw = stringFlagOrExit(flags, 'budget');
  let budget: number | undefined;
  if (budgetRaw !== undefined) {
    if (!/^\d+$/.test(budgetRaw)) {
      fail(`Invalid budget: "${budgetRaw}" (expected a positive integer)`);
    }
    budget = Number(budgetRaw);
  }
  const dependsOnFlag = flags['depends-on'];
  if (dependsOnFlag === true) {
    fail('--depends-on requires a value');
  }
  const dependsOn: string[] = Array.isArray(dependsOnFlag) ? dependsOnFlag : [];

  let card: Card;
  try {
    card = await cardsApi.cardCreate(cliApiContext(hippoRoot, tenantId), { title, repo, contract, budget, dependsOn });
  } catch (error) {
    fail(errorMessage(error));
  }
  console.log(`Created card ${card.id} (status: ${card.status})`);
}

async function cardShow(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): Promise<void> {
  const id = args[1];
  if (!id) {
    throw usageError('show');
  }
  const detail = await cardsApi.cardDetail(cliApiContext(hippoRoot, tenantId), id);
  if (!detail) {
    fail(`No card found with id ${id}.`);
  }
  if (flags['json']) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }
  printCard(detail);
}

async function cardList(hippoRoot: string, tenantId: string, _args: string[], flags: CliFlags): Promise<void> {
  const status = stringFlagOrExit(flags, 'status');
  if (status !== undefined && !isCardStatus(status)) {
    fail(`Invalid status: "${status}".`);
  }
  const cards = await cardsApi.cardList(cliApiContext(hippoRoot, tenantId), { status });
  if (flags['json']) {
    console.log(JSON.stringify({ cards }, null, 2));
    return;
  }
  if (cards.length === 0) {
    console.log('No cards found.');
    return;
  }
  for (const card of cards) {
    const assignee = card.assigneeRuntime ? `\t(${card.assigneeRuntime})` : '';
    console.log(`${card.id}\t${card.status}\t${card.title}${assignee}`);
  }
}

async function cardClaim(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): Promise<void> {
  const id = args[1];
  const runtime = stringFlagOrExit(flags, 'runtime') ?? '';
  if (!id || !runtime) {
    throw usageError('claim');
  }
  const sessionId = stringFlagOrExit(flags, 'session') || undefined;
  let card: (Card & { runId: number }) | null;
  try {
    card = await cardsApi.cardClaim(cliApiContext(hippoRoot, tenantId), id, runtime, sessionId);
  } catch (error) {
    fail(errorMessage(error));
  }
  if (!card) {
    fail(`Could not claim card ${id} (not ready/blocked, or already claimed).`);
  }
  console.log(`Claimed card ${card.id} for ${runtime} (run ${card.runId}, lease until ${card.leaseUntil})`);
}

async function cardHeartbeat(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): Promise<void> {
  const id = args[1];
  const runId = cardRunFlag(flags);
  if (!id || runId === undefined) {
    throw usageError('heartbeat');
  }
  let card: Card | null;
  try {
    card = await cardsApi.cardHeartbeat(cliApiContext(hippoRoot, tenantId), id, runId);
  } catch (error) {
    fail(errorMessage(error));
  }
  if (!card) {
    fail(`Could not heartbeat card ${id} (${await cardRefusal(hippoRoot, tenantId, id)}).`);
  }
  console.log(`Heartbeat card ${card.id}: lease until ${card.leaseUntil}`);
}

async function cardBlock(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): Promise<void> {
  const id = args[1];
  const reason = stringFlagOrExit(flags, 'reason') ?? '';
  if (!id || !reason) {
    fail(CARD_BLOCK_REASON_REQUIRED);
  }
  const runId = cardRunFlag(flags);
  let card: Card | null;
  try {
    card = await cardsApi.cardBlock(cliApiContext(hippoRoot, tenantId), id, reason, runId);
  } catch (error) {
    fail(errorMessage(error));
  }
  if (!card) {
    const why = runId === undefined ? 'not running' : await cardRefusal(hippoRoot, tenantId, id);
    fail(`Could not block card ${id} (${why}).`);
  }
  console.log(`Blocked card ${card.id}`);
}

async function cardReview(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): Promise<void> {
  const id = args[1];
  if (!id) {
    throw usageError('review');
  }
  const runId = cardRunFlag(flags);
  let card: Card | null;
  try {
    card = await cardsApi.cardReview(cliApiContext(hippoRoot, tenantId), id, runId);
  } catch (error) {
    fail(errorMessage(error));
  }
  if (!card) {
    const why = runId === undefined ? 'not running' : await cardRefusal(hippoRoot, tenantId, id);
    fail(`Could not move card ${id} to review (${why}).`);
  }
  console.log(`Card ${card.id} moved to review`);
}

async function cardComplete(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): Promise<void> {
  const id = args[1];
  const outcomeRaw = flags['outcome'];
  if (!id || !isHandoffOutcome(outcomeRaw)) {
    throw usageError('complete');
  }
  const runId = cardRunFlag(flags);
  let result: { card: Card; promotedChildren: string[] } | null;
  try {
    result = await cardsApi.cardComplete(cliApiContext(hippoRoot, tenantId), id, outcomeRaw, runId);
  } catch (error) {
    fail(errorMessage(error));
  }
  if (!result) {
    const why = runId === undefined ? 'not in review' : await cardRefusal(hippoRoot, tenantId, id);
    fail(`Could not complete card ${id} (${why}).`);
  }
  console.log(`Completed card ${result.card.id} (status: ${result.card.status})`);
  if (result.promotedChildren.length > 0) {
    console.log(`Promoted to ready: ${result.promotedChildren.join(', ')}`);
  }
}

async function cardReclaim(hippoRoot: string, tenantId: string, args: string[]): Promise<void> {
  if (args.length > 1) {
    throw usageError('reclaim');
  }
  const ids = await cardsApi.cardReclaimExpired(cliApiContext(hippoRoot, tenantId));
  if (ids.length === 0) {
    console.log('No expired leases.');
    return;
  }
  for (const id of ids) {
    console.log(`Reclaimed card ${id} (now ready)`);
  }
}

async function cardComment(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): Promise<void> {
  const id = args[1];
  if (!id) {
    throw usageError('comment');
  }
  // Only show and comment look the card up directly; claim/heartbeat/block/review/complete throw from the store
  // instead.
  const ctx = cliApiContext(hippoRoot, tenantId);
  const card = await cardsApi.cardLoad(ctx, id);
  if (!card) {
    fail(`No card found with id ${id}.`);
  }
  const body = stringFlagOrExit(flags, 'body') ?? '';
  if (!body) {
    throw usageError('comment');
  }
  const author = stringFlagOrExit(flags, 'author') || 'cli';
  const comment = await cardsApi.cardComment(ctx, id, author, body);
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
