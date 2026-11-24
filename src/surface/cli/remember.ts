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
import { cliApiContext, cliInitGlobal } from './api-context.js';
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

interface RememberTags {
  requested: string[];
  all: string[];
}

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
  if (kindFlag !== undefined && !isOneOf(USER_VISIBLE_KINDS, kindFlag)) {
    printError(
      `Invalid --kind: "${kindFlagRaw}". Must be one of: ${USER_VISIBLE_KINDS.join(', ')}`,
    );
    fail(`(kind='raw' is reserved for ingestion connectors; kind='archived' is internal.)`);
  }
  return kindFlag;
}

type RememberEnvelope = Pick<
  RememberRequest,
  'kind' | 'owner' | 'artifactRef' | 'scope' | 'leadIn'
>;

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
    leadIn: stringFlagOrExit(flags, 'lead-in'),
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

const STORE_ONLY_SWITCHES = [
  'pin',
  'extract',
  'force',
  'observed',
  'inferred',
  'verified',
] as const;

async function rememberWrites(
  hippoRoot: string,
  tenantId: string,
  flags: CliFlags,
): Promise<MemoryWrites> {
  if (boolFlag(flags, 'global')) {
    cliInitGlobal();
    return localWrites(hippoHomeDir(), tenantId);
  }
  if (STORE_ONLY_SWITCHES.some((name) => boolFlag(flags, name)) || hasFlag(flags, 'layer')) {
    return localWrites(hippoRoot, tenantId);
  }
  return pickWrites(hippoRoot, tenantId);
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
    const held = outcome.quarantined;
    console.log(
      held
        ? `Quarantined [${outcome.id}] (via ${outcome.via}) for admin review (reason: ${held.reason}); ` +
            `an admin releases it with: hippo quarantine approve ${outcome.id}`
        : `Remembered [${outcome.id}] (via ${outcome.via})`,
    );
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
    printError('  (extraction skipped: no model set; set HIPPO_LLM_BASE_URL or ANTHROPIC_API_KEY)');
  }
  if (extraction.status !== 'ran') return;
  for (const failure of extraction.failures) printError(`  (extraction failed: ${failure})`);
  if (extraction.facts > 0) printError(`  extracted ${extraction.facts} fact(s)`);
}

function supersedeTags(flags: CliFlags): string[] | undefined {
  return stringListFlag(flags, 'tag');
}

interface SupersedeTarget {
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly oldId: string;
}

async function alreadySupersededLine(
  { hippoRoot, tenantId, oldId }: SupersedeTarget,
  conflict: ConflictError,
): Promise<string> {
  const by = (await memoryGet(cliApiContext(hippoRoot, tenantId), oldId))?.supersededBy;
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
    pinned: boolFlag(flags, 'pin') ? true : undefined,
  };

  let newId: string;
  try {
    ({ newId } = await api.supersede(
      cliApiContext(hippoRoot, tenantId),
      oldId,
      newContent,
      overrides,
    ));
  } catch (err) {
    if (err instanceof NotFoundError) printError(`Error: memory ${oldId} not found.`);
    else if (err instanceof RejectedValueError) printError(`Error: ${err.message}`);
    else if (err instanceof ConflictError) {
      printError(await alreadySupersededLine({ hippoRoot, tenantId, oldId }, err));
    } else throw err;
    throw new CliExit(1);
  }
  console.log(`Superseded ${oldId} → ${newId}`);
}

export async function handleRemember({
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  const text =
    args.length === 1 && args[0] === '-'
      ? fs.readFileSync(0, 'utf-8').trim()
      : args.join(' ').trim();
  if (!text || text.length < 3) {
    fail('Memory content too short (minimum 3 characters).');
  }
  const useGlobal = boolFlag(flags, 'global');
  const request = rememberRequest(text, flags, useGlobal);
  const writes = await rememberWrites(hippoRoot, tenantId, flags);
  await printRemembered(await writes.remember(request), useGlobal);
}

export async function handleSupersede({
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  const oldId = args[0];
  const newContent = args.slice(1).join(' ').trim();
  if (!oldId || !newContent) {
    fail('Usage: hippo supersede <old-id> "<new content>" [--layer L] [--tag T] [--pin]');
  }
  await supersedeMemory({ hippoRoot, tenantId, oldId, newContent, flags });
}
