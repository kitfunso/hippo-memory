// The write verbs: `hippo remember` and `hippo supersede`.

import { envActiveScope } from '../../base/util/env.js';
import * as fs from 'node:fs';
import { ERROR_TAG, Layer, ConfidenceLevel, type MemoryEntry } from '../../base/memory/entry.js';
import * as api from '../../api/index.js';
import { memoryGet } from '../../api/memories/memories.js';
import { ConflictError, NotFoundError, RejectedValueError } from '../../base/errors/api-errors.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import { extractPathTags } from '../../api/memories/remember-local.js';
import { assertClientScope } from '../../base/scope/recall-scope.js';
import {
  type MemoryWrites,
  type RememberRequest,
  type Remembered,
  localWrites,
  pickWrites,
} from './memory-writes.js';
import { cliInitGlobal, type CliCommand } from './api-context.js';
import { validateOwner, isStrictOwnerEnv } from './owner-validation.js';
import { printError } from './output.js';
import { requireInit } from './shared.js';
import { fmt } from './print.js';
import {
  type CliFlags,
  type CommandContext,
  boolFlag,
  hasFlag,
  isOneOf,
  repeatedFlag,
  stringFlag,
  stringFlagOrExit,
  stringListFlag,
} from './flag-values.js';
import { CliExit, fail } from './exit.js';

// `requested` is what the caller typed; `all` adds path and scope tags from this process's cwd
// and env.
interface RememberTags {
  requested: string[];
  all: string[];
}

// The routed write sends the same tags, so a row's tags do not depend on whether a server took it.
function rememberTags(flags: CliFlags, cwd: string): RememberTags {
  const requested = [...repeatedFlag(flags, 'tag')];
  if (boolFlag(flags, 'error')) requested.push(ERROR_TAG);
  const all = [...requested];
  for (const pt of extractPathTags(cwd)) {
    if (!all.includes(pt)) all.push(pt);
  }
  const explicitScope = stringFlagOrExit(flags, 'scope') ?? null;
  const activeScope = explicitScope || envActiveScope();
  if (activeScope) {
    const scopeTag = `scope:${activeScope}`;
    if (!all.includes(scopeTag)) all.push(scopeTag);
  }
  return { requested, all };
}

function rememberConfidence(flags: CliFlags): ConfidenceLevel {
  let confidence: ConfidenceLevel = 'verified';
  if (boolFlag(flags, 'observed')) confidence = 'observed';
  if (boolFlag(flags, 'inferred')) confidence = 'inferred';
  if (boolFlag(flags, 'verified')) confidence = 'verified';
  return confidence;
}

const USER_VISIBLE_KINDS = ['distilled', 'superseded'] as const;

type UserVisibleKind = (typeof USER_VISIBLE_KINDS)[number];

function parseKindFlag(flags: CliFlags): UserVisibleKind | undefined {
  const kindFlagRaw = stringFlag(flags, 'kind');
  const kindFlag = kindFlagRaw === undefined ? undefined : kindFlagRaw.toLowerCase();
  // 'raw' is reserved for ingestion connectors (deletions go through archiveRawMemory); the
  // append-only trigger aborts forget/consolidate on raw rows, so exposing --kind raw would create
  // unforgettable memories. 'archived' is an internal sentinel set only in that transaction.
  if (kindFlag !== undefined && !isOneOf(USER_VISIBLE_KINDS, kindFlag)) {
    printError(
      `Invalid --kind: "${kindFlagRaw}". Must be one of: ${USER_VISIBLE_KINDS.join(', ')}`,
    );
    fail(`(kind='raw' is reserved for ingestion connectors; kind='archived' is internal.)`);
  }
  return kindFlag;
}

type RememberEnvelope = Pick<RememberRequest, 'kind' | 'owner' | 'artifactRef' | 'scope'>;

function parseRememberEnvelope(flags: CliFlags): RememberEnvelope {
  const kind = parseKindFlag(flags);
  const ownerCheck = validateOwner(stringFlag(flags, 'owner') ?? null, {
    strict: isStrictOwnerEnv(),
  });
  if (!ownerCheck.ok) {
    fail(ownerCheck.message);
  }
  if (ownerCheck.message) printError(ownerCheck.message);
  const scope = stringFlag(flags, 'scope')?.trim() || undefined;
  assertClientScope(scope);
  return {
    kind,
    owner: ownerCheck.value ?? undefined,
    artifactRef: stringFlag(flags, 'artifact-ref'),
    scope,
  };
}

function rememberRequest(content: string, flags: CliFlags, useGlobal: boolean): RememberRequest {
  const tags = rememberTags(flags, process.cwd());
  return {
    content,
    tags: tags.all,
    fitTags: tags.requested,
    ...parseRememberEnvelope(flags),
    pinned: boolFlag(flags, 'pin'),
    confidence: rememberConfidence(flags),
    force: boolFlag(flags, 'force'),
    extract: boolFlag(flags, 'extract'),
    source: useGlobal ? 'cli-global' : 'cli',
  };
}

/** The switches only a write on the store honours (with --layer), so a command that sets one
 * never goes to a server. */
const STORE_ONLY_SWITCHES = [
  'pin',
  'extract',
  'force',
  'observed',
  'inferred',
  'verified',
] as const;

async function rememberWrites(cmd: CommandContext): Promise<MemoryWrites> {
  const { flags } = cmd;
  if (boolFlag(flags, 'global')) {
    cliInitGlobal();
    return localWrites({ ...cmd, hippoRoot: hippoHomeDir() });
  }
  if (STORE_ONLY_SWITCHES.some((name) => boolFlag(flags, name)) || hasFlag(flags, 'layer')) {
    return localWrites(cmd);
  }
  return pickWrites(cmd);
}

async function printRemembered(outcome: Remembered, useGlobal: boolean): Promise<void> {
  if (outcome.status === 'skipped') {
    console.log(`Skipped (salience: ${outcome.reason}, score ${outcome.score.toFixed(2)})`);
    return;
  }
  const weak = outcome.startedWeak;
  if (weak) {
    console.log(`Weakened (salience: ${weak.reason}, strength ${weak.strength.toFixed(2)})`);
  }
  if (outcome.status === 'relayed') {
    console.log(`Remembered [${outcome.id}] (via ${outcome.via})`);
    console.log(`   Kind: ${outcome.kind} | Tenant: ${outcome.tenantId}`);
  } else {
    printEntry(outcome.entry, useGlobal);
  }
  for (const w of outcome.warnings) printError(`Warning: ${w}`);
  if (outcome.status === 'stored') printExtraction(await outcome.extraction());
}

function printEntry(entry: MemoryEntry, useGlobal: boolean): void {
  const prefix = useGlobal ? '[global] ' : '';
  console.log(`${prefix}Remembered [${entry.id}]`);
  console.log(
    `   Layer: ${entry.layer} | Strength: ${fmt(entry.strength)} | Half-life: ${entry.halfLifeDays}d | ` +
      `Confidence: ${entry.confidence}`,
  );
  if (entry.tags.length > 0) console.log(`   Tags: ${entry.tags.join(', ')}`);
  if (entry.pinned) console.log('   Pinned (no decay)');
}

function printExtraction(extraction: api.FactExtraction): void {
  if (extraction.status === 'no_key') {
    printError('  (extraction skipped: ANTHROPIC_API_KEY not set)');
  }
  if (extraction.status !== 'ran') return;
  for (const failure of extraction.failures) printError(`  (extraction failed: ${failure})`);
  if (extraction.facts > 0) printError(`  extracted ${extraction.facts} fact(s)`);
}

function supersedeTags(flags: CliFlags): string[] | undefined {
  return stringListFlag(flags, 'tag');
}

interface SupersedeTarget {
  readonly cli: CliCommand;
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly oldId: string;
}

/** The api's conflict text differs by which writer lost; the row itself names its successor
 * either way. */
async function alreadySupersededLine(
  { cli, hippoRoot, tenantId, oldId }: SupersedeTarget,
  conflict: ConflictError,
): Promise<string> {
  const by = (await memoryGet(cli.apiContext(hippoRoot, tenantId), oldId))?.supersededBy;
  return by
    ? `Error: memory ${oldId} is already superseded by ${by}. Supersede that one instead.`
    : `Error: ${conflict.message}`;
}

function parseLayerFlag(flags: CliFlags): Layer | undefined {
  const raw = stringFlag(flags, 'layer');
  if (raw === undefined) return undefined;
  const layer = Object.values(Layer).find((l) => l === raw);
  if (layer === undefined) {
    fail(`Invalid --layer: "${raw}". Must be one of: ${Object.values(Layer).join(', ')}`);
  }
  return layer;
}

interface SupersedeMemoryOptions extends SupersedeTarget {
  readonly newContent: string;
  readonly flags: CliFlags;
}

async function supersedeMemory({
  cli,
  hippoRoot,
  tenantId,
  oldId,
  newContent,
  flags,
}: SupersedeMemoryOptions): Promise<void> {
  requireInit(hippoRoot);

  const overrides = {
    layer: parseLayerFlag(flags),
    tags: supersedeTags(flags),
    // Without --pin the successor keeps the old row's pin.
    pinned: boolFlag(flags, 'pin') ? true : undefined,
  };

  let newId: string;
  try {
    ({ newId } = await api.supersede(
      cli.apiContext(hippoRoot, tenantId),
      oldId,
      newContent,
      overrides,
    ));
  } catch (err) {
    if (err instanceof NotFoundError) printError(`Error: memory ${oldId} not found.`);
    else if (err instanceof RejectedValueError) printError(`Error: ${err.message}`);
    else if (err instanceof ConflictError) {
      printError(await alreadySupersededLine({ cli, hippoRoot, tenantId, oldId }, err));
    } else throw err;
    throw new CliExit(1);
  }
  console.log(`Superseded ${oldId} → ${newId}`);
}

export async function handleRemember(cmd: CommandContext): Promise<void> {
  const { args, flags } = cmd;
  const text =
    args.length === 1 && args[0] === '-'
      ? fs.readFileSync(0, 'utf-8').trim()
      : args.join(' ').trim();
  if (!text || text.length < 3) {
    fail('Memory content too short (minimum 3 characters).');
  }
  const useGlobal = boolFlag(flags, 'global');
  const request = rememberRequest(text, flags, useGlobal);
  const writes = await rememberWrites(cmd);
  await printRemembered(await writes.remember(request), useGlobal);
}

export async function handleSupersede({
  hippoRoot,
  tenantId,
  args,
  flags,
  cli,
}: CommandContext): Promise<void> {
  const oldId = args[0];
  const newContent = args.slice(1).join(' ').trim();
  if (!oldId || !newContent) {
    fail('Usage: hippo supersede <old-id> "<new content>" [--layer L] [--tag T] [--pin]');
  }
  await supersedeMemory({ cli, hippoRoot, tenantId, oldId, newContent, flags });
}
