// The `hippo card` verb (the agent work board); main() loads it lazily from the command table.

import { cliStore } from './api-context.js';
import { isHandoffOutcome } from '../../base/session/handoff.js';
import { type Card, type CardStatus, isCardStatus } from '../../base/records/card.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { MAX_LIST_LIMIT } from '../../base/util/limits.js';
import { keysetPages } from '../../api/pages.js';
import type { CardDetail } from '../../base/ports/store/cards.js';
import { printError } from './output.js';
import { printJsonList } from './json-list.js';
import {
  type CliFlags,
  type CommandContext,
  boolFlag,
  flagValueless,
  repeatedFlag,
  stringFlag,
  stringFlagOrExit,
} from './flag-values.js';
import { requireInit } from './shared.js';
import { errorMessage } from '../../base/util/log.js';
import { CliExit, fail } from './exit.js';

// Each subcommand's usage line, written once so the repeated checks cannot drift.
const CARD_USAGE = {
  create:
    'hippo card create --title "..." [--repo <name>] [--contract <text>] [--budget <n>] [--depends-on <id>...]',
  show: 'hippo card show <id> [--json]',
  claim: 'hippo card claim <id> --runtime <name> [--session <id>]',
  heartbeat: 'hippo card heartbeat <id> --run <n>',
  review: 'hippo card review <id> [--run <n>]',
  complete: 'hippo card complete <id> --outcome <success|failure|partial> [--run <n>]',
  reclaim:
    'hippo card reclaim (sweeps every expired lease; use hippo card block <id> for one card)',
  comment: 'hippo card comment <id> --body "..." [--author <name>]',
} as const satisfies Partial<Record<CardSubcommandName, string>>;

function usageError(sub: keyof typeof CARD_USAGE): CliExit {
  printError(`Usage: ${CARD_USAGE[sub]}`);
  return new CliExit(1);
}

// Mirrors ARCHIVE_REASON_REQUIRED so the block message can't drift from its usage line.
const CARD_BLOCK_REASON_REQUIRED =
  'hippo card block <id> requires --reason "<why>" (recorded as a comment).';

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

interface CardRefusalOptions {
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly id: string;
}

// Reads after the store already refused, so this only explains the refusal, never changes it.
async function cardRefusal({ hippoRoot, tenantId, id }: CardRefusalOptions): Promise<string> {
  const detail = await cliStore(hippoRoot).cards.detail(tenantId, id);
  const liveRun = detail?.runs.find((r) => !r.ended);
  return `status ${detail?.card.status ?? 'unknown'}, live run ${liveRun?.id ?? 'none'}`;
}

type CardHandler = (
  hippoRoot: string,
  tenantId: string,
  args: string[],
  flags: CliFlags,
) => Promise<void>;

/** A `hippo card` subcommand: the flags its handler reads, so a typo like --depend-on fails fast
 * instead of silently doing nothing. */
interface CardSubcommand {
  readonly flags: readonly string[];
  readonly run: CardHandler;
}

type CardSubcommandName = keyof typeof CARD_SUBCOMMANDS;

/** Runs `hippo card <subcommand>`: rejects flags the subcommand never reads, then hands off to
 * its handler. */
export function handleCard({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';

  if (!Object.hasOwn(CARD_SUBCOMMANDS, subcommand)) {
    fail(`Usage: hippo card <${Object.keys(CARD_SUBCOMMANDS).join('|')}>`);
  }
  // SAFETY: hasOwn, unlike `in`, skips inherited keys such as constructor, so subcommand is a real
  // key.
  const known: CardSubcommand = CARD_SUBCOMMANDS[subcommand as CardSubcommandName];
  for (const key of Object.keys(flags)) {
    if (!known.flags.includes(key)) {
      const valid = known.flags.length > 0 ? known.flags.map((f) => `--${f}`).join(', ') : '(none)';
      fail(`Unknown flag --${key} for hippo card ${subcommand}. Valid flags: ${valid}`);
    }
  }
  return known.run(hippoRoot, tenantId, args, flags);
}

async function cardCreate(
  hippoRoot: string,
  tenantId: string,
  _args: string[],
  flags: CliFlags,
): Promise<void> {
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
  if (flagValueless(flags, 'depends-on')) {
    fail('--depends-on requires a value');
  }
  const dependsOn = repeatedFlag(flags, 'depends-on');

  let card: Card;
  try {
    card = await cliStore(hippoRoot).cards.create(tenantId, {
      title,
      repo,
      contract,
      budget,
      dependsOn,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
  console.log(`Created card ${card.id} (status: ${card.status})`);
}

async function cardShow(
  hippoRoot: string,
  tenantId: string,
  args: string[],
  flags: CliFlags,
): Promise<void> {
  const id = args[1];
  if (!id) {
    throw usageError('show');
  }
  const detail = await cliStore(hippoRoot).cards.detail(tenantId, id);
  if (!detail) {
    fail(`No card found with id ${id}.`);
  }
  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }
  printCard(detail);
}

/** Every page of the tenant's cards in list order, the largest page at a time, so the list
 * prints as it reads. */
async function* cardPages(
  hippoRoot: string,
  tenantId: string,
  status?: CardStatus,
): AsyncGenerator<Card[]> {
  const read = (after?: KeysetPosition) =>
    cliStore(hippoRoot).cards.list(tenantId, { status, limit: MAX_LIST_LIMIT, after });
  for await (const page of keysetPages(read)) yield page.cards;
}

async function cardList(
  hippoRoot: string,
  tenantId: string,
  _args: string[],
  flags: CliFlags,
): Promise<void> {
  const status = stringFlagOrExit(flags, 'status');
  if (status !== undefined && !isCardStatus(status)) {
    fail(`Invalid status: "${status}".`);
  }
  const pages = cardPages(hippoRoot, tenantId, status);
  if (boolFlag(flags, 'json')) {
    await printJsonList('cards', pages);
    return;
  }
  let none = true;
  for await (const cards of pages) {
    for (const card of cards) {
      const assignee = card.assigneeRuntime ? `\t(${card.assigneeRuntime})` : '';
      console.log(`${card.id}\t${card.status}\t${card.title}${assignee}`);
      none = false;
    }
  }
  if (none) console.log('No cards found.');
}

async function cardClaim(
  hippoRoot: string,
  tenantId: string,
  args: string[],
  flags: CliFlags,
): Promise<void> {
  const id = args[1];
  const runtime = stringFlagOrExit(flags, 'runtime') ?? '';
  if (!id || !runtime) {
    throw usageError('claim');
  }
  const sessionId = stringFlagOrExit(flags, 'session') || undefined;
  let card: (Card & { runId: number }) | null;
  try {
    card = await cliStore(hippoRoot).cards.claim(tenantId, id, runtime, sessionId);
  } catch (error) {
    fail(errorMessage(error));
  }
  if (!card) {
    fail(`Could not claim card ${id} (not ready/blocked, or already claimed).`);
  }
  console.log(
    `Claimed card ${card.id} for ${runtime} (run ${card.runId}, lease until ${card.leaseUntil})`,
  );
}

async function cardHeartbeat(
  hippoRoot: string,
  tenantId: string,
  args: string[],
  flags: CliFlags,
): Promise<void> {
  const id = args[1];
  const runId = cardRunFlag(flags);
  if (!id || runId === undefined) {
    throw usageError('heartbeat');
  }
  let card: Card | null;
  try {
    card = await cliStore(hippoRoot).cards.heartbeat(tenantId, id, runId);
  } catch (error) {
    fail(errorMessage(error));
  }
  if (!card) {
    fail(`Could not heartbeat card ${id} (${await cardRefusal({ hippoRoot, tenantId, id })}).`);
  }
  console.log(`Heartbeat card ${card.id}: lease until ${card.leaseUntil}`);
}

async function cardBlock(
  hippoRoot: string,
  tenantId: string,
  args: string[],
  flags: CliFlags,
): Promise<void> {
  const id = args[1];
  const reason = stringFlagOrExit(flags, 'reason') ?? '';
  if (!id || !reason) {
    fail(CARD_BLOCK_REASON_REQUIRED);
  }
  const runId = cardRunFlag(flags);
  let card: Card | null;
  try {
    card = await cliStore(hippoRoot).cards.block(tenantId, id, reason, runId);
  } catch (error) {
    fail(errorMessage(error));
  }
  if (!card) {
    const why =
      runId === undefined ? 'not running' : await cardRefusal({ hippoRoot, tenantId, id });
    fail(`Could not block card ${id} (${why}).`);
  }
  console.log(`Blocked card ${card.id}`);
}

async function cardReview(
  hippoRoot: string,
  tenantId: string,
  args: string[],
  flags: CliFlags,
): Promise<void> {
  const id = args[1];
  if (!id) {
    throw usageError('review');
  }
  const runId = cardRunFlag(flags);
  let card: Card | null;
  try {
    card = await cliStore(hippoRoot).cards.review(tenantId, id, runId);
  } catch (error) {
    fail(errorMessage(error));
  }
  if (!card) {
    const why =
      runId === undefined ? 'not running' : await cardRefusal({ hippoRoot, tenantId, id });
    fail(`Could not move card ${id} to review (${why}).`);
  }
  console.log(`Card ${card.id} moved to review`);
}

async function cardComplete(
  hippoRoot: string,
  tenantId: string,
  args: string[],
  flags: CliFlags,
): Promise<void> {
  const id = args[1];
  const outcomeRaw = stringFlag(flags, 'outcome');
  if (!id || !isHandoffOutcome(outcomeRaw)) {
    throw usageError('complete');
  }
  const runId = cardRunFlag(flags);
  let result: { card: Card; promotedChildren: string[] } | null;
  try {
    result = await cliStore(hippoRoot).cards.complete(tenantId, id, outcomeRaw, runId);
  } catch (error) {
    fail(errorMessage(error));
  }
  if (!result) {
    const why =
      runId === undefined ? 'not in review' : await cardRefusal({ hippoRoot, tenantId, id });
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
  const ids = await cliStore(hippoRoot).cards.reclaimExpired(tenantId);
  if (ids.length === 0) {
    console.log('No expired leases.');
    return;
  }
  for (const id of ids) {
    console.log(`Reclaimed card ${id} (now ready)`);
  }
}

async function cardComment(
  hippoRoot: string,
  tenantId: string,
  args: string[],
  flags: CliFlags,
): Promise<void> {
  const id = args[1];
  if (!id) {
    throw usageError('comment');
  }
  // Only show and comment look the card up directly; claim/heartbeat/block/review/complete throw
  // from the store instead.
  const cards = cliStore(hippoRoot).cards;
  const card = (await cards.detail(tenantId, id))?.card;
  if (!card) {
    fail(`No card found with id ${id}.`);
  }
  const body = stringFlagOrExit(flags, 'body') ?? '';
  if (!body) {
    throw usageError('comment');
  }
  const author = stringFlagOrExit(flags, 'author') || 'cli';
  const comment = await cards.comment(tenantId, id, author, body);
  console.log(`Added comment ${comment.id} to card ${id}`);
}

// The one place a subcommand is spelled: handleCard builds its usage line and flag check from it.
const CARD_SUBCOMMANDS = {
  create: { flags: ['title', 'repo', 'contract', 'budget', 'depends-on'], run: cardCreate },
  show: { flags: ['json'], run: cardShow },
  list: { flags: ['status', 'json'], run: cardList },
  claim: { flags: ['runtime', 'session'], run: cardClaim },
  heartbeat: { flags: ['run'], run: cardHeartbeat },
  block: { flags: ['reason', 'run'], run: cardBlock },
  review: { flags: ['run'], run: cardReview },
  complete: { flags: ['outcome', 'run'], run: cardComplete },
  reclaim: { flags: [], run: cardReclaim },
  comment: { flags: ['body', 'author'], run: cardComment },
} satisfies Readonly<Record<string, CardSubcommand>>;
