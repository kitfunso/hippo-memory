// Readers that turn parsed CLI flags into typed values, and the flag types they share.

import { resolveListLimit } from '../../base/util/limits.js';
import type { CallerState } from '../../api/callers.js';
import type { RecallSearchOptions } from '../../api/recall/pipeline.js';
import type { HippoConfig } from '../../base/config/config.js';
import { fail } from './exit.js';

export function isBooleanFlag(value: string | boolean | string[] | undefined): value is boolean {
  return typeof value === 'boolean';
}

export function isStringFlag(value: string | boolean | string[] | undefined): value is string {
  return typeof value === 'string';
}

// All digits or NaN: parseInt reads "12abc" as 12 and " 12" as 12, which a count flag must refuse.
function parseWholeNumber(raw: string): number {
  return /^\d+$/.test(raw) ? Number(raw) : NaN;
}

export function parseLimitFlag(flags: CliFlags, name: string): number {
  const value = flags[name];
  if (!value) return Infinity;
  const parsed = parseWholeNumber(String(value));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : Infinity;
}

export function parseCountFlag(flags: CliFlags, name: string): number {
  const value = flags[name];
  if (!value || value === true || Array.isArray(value)) return 0;
  const parsed = parseWholeNumber(String(value));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 0;
}

/** --budget as a non-negative integer, or `fallback` when absent; a bare or junk value exits. */
export function parseBudgetFlag<F extends number | undefined>(flags: CliFlags, fallback: F): number | F {
  const value = flags['budget'];
  if (value === undefined) return fallback;
  // A value-less flag and a junk value are different typos; the --hops guard already splits them.
  if (!isStringFlag(value)) {
    fail('--budget requires an integer value (e.g. --budget 1500).');
  }
  // Number(), like the --hops guard: parseInt('12abc') is 12, silently accepting what this message rejects.
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    fail(`Invalid --budget: "${value}". Must be a non-negative integer.`);
  }
  return parsed;
}

export type CliFlags = Record<string, string | boolean | string[]>;

// Whole-arg digits only: parseInt alone reads "1abc" as 1 and a mutating verb would hit the wrong row.
// Digits past 2^53 round to a neighboring id, so they are refused too.
export function parsePositiveId(idRaw: string | undefined, label: string): number {
  const s = String(idRaw ?? '').trim();
  const id = parseInt(s, 10);
  if (!/^\d+$/.test(s) || id <= 0 || !Number.isSafeInteger(id)) {
    fail(`Invalid ${label} id: "${idRaw}" (expected a positive integer).`);
  }
  return id;
}

export function parseListLimit(flags: CliFlags): number {
  const limitRaw = flags['limit'];
  const limit = resolveListLimit(limitRaw !== undefined ? parseWholeNumber(String(limitRaw)) : undefined);
  if (limit === undefined) {
    fail(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
  }
  return limit;
}

/** A flag value, or the deferred error that rejects it. */
export interface ParsedFlag<T> {
  value?: T;
  fail?: () => never;
}

export function failLater(message: string): () => never {
  return () => {
    fail(message);
  };
}

/** The whole numbers a flag accepts; without a `max` that is every integer from `min`, which is at least 1. */
export interface IntRange {
  readonly min: number;
  readonly max?: number;
  readonly example?: string;
}

/**
 * A whole-number flag within `range`: {} when absent, else the number or the refusal to raise. A value-less flag is
 * refused apart from a junk one, because Number(true) is 1 and would quietly run a 1-hop expansion.
 */
export function intFlagInRange(flags: CliFlags, name: string, { min, max, example }: IntRange): ParsedFlag<number> {
  const raw = flags[name];
  if (raw === undefined) return {};
  const [noun, bounds] = max === undefined ? ['a positive integer', ''] : ['an integer', ` ${min}..${max}`];
  if (isBooleanFlag(raw)) {
    const hint = example === undefined ? '' : ` (e.g. --${name} ${example})`;
    return { fail: failLater(`--${name} requires ${noun} value${bounds}${hint}.`) };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > (max ?? Infinity)) {
    return { fail: failLater(`Invalid --${name}: "${String(raw)}". Must be ${noun}${bounds}.`) };
  }
  return { value };
}

// A value-less flag is `true` and a repeated one is a string[]; only a string counts here.
export function stringFlag(flags: CliFlags, name: string): string | undefined {
  const v = flags[name];
  return isStringFlag(v) ? v : undefined;
}

// An empty value reads as absent, so `--change ""` keeps the default.
export function nonEmptyStringFlag(flags: CliFlags, name: string): string | undefined {
  return stringFlag(flags, name) || undefined;
}

// A repeated flag is already a list; a single value is a comma-separated list.
export function stringListFlag(flags: CliFlags, name: string): string[] | undefined {
  const v = flags[name];
  if (Array.isArray(v)) return v;
  return isStringFlag(v)
    ? v
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;
}

// A repeated flag is a list and a single value a one-item list; unlike stringListFlag it never splits on commas.
export function repeatedFlag(flags: CliFlags, name: string): string[] {
  const v = flags[name];
  return Array.isArray(v) ? v : isStringFlag(v) ? [v] : [];
}

export function isOneOf<T extends string>(allowed: readonly T[], value: string): value is T {
  return allowed.some((a) => a === value);
}

// A junk value exits instead of becoming NaN, which would pass every `<` gate.
export function numberFlag(flags: CliFlags, name: string): number | undefined {
  const v = flags[name];
  if (!isStringFlag(v)) return undefined;
  const parsed = Number(v);
  if (v.trim() === '' || !Number.isFinite(parsed)) {
    fail(`Invalid --${name}: "${v}". Must be a number.`);
  }
  return parsed;
}

// Any truthy value counts, so a string value is true too.
export function boolFlag(flags: CliFlags, name: string): boolean {
  return Boolean(flags[name]);
}

// A flag that takes a value was typed with none (`--x` and nothing after it).
export function flagValueless(flags: CliFlags, name: string): boolean {
  return flags[name] === true;
}

// Typed at all, bare or with a value.
export function hasFlag(flags: CliFlags, name: string): boolean {
  return flags[name] !== undefined;
}

/** What the command table hands each verb's run(). */
export interface CommandContext {
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly args: string[];
  readonly flags: CliFlags;
  /** Unset in a hippo process, which runs one command, so its recall starts empty rings; a caller that runs several
   * commands in one process passes one set to each. */
  readonly callers?: CallerState;
}

export type EngineFlags = Pick<RecallSearchOptions, 'usePhysics' | 'physicsConfig' | 'mmr' | 'mmrLambda' | 'localBump'>;

export function parseAsOfFlag(flags: CliFlags): string | undefined {
  const asOf = stringFlag(flags, 'as-of');
  if (asOf !== undefined && Number.isNaN(new Date(asOf).getTime())) {
    fail(`Error: --as-of value "${asOf}" is not a valid ISO date (e.g. 2026-04-22 or 2026-04-22T12:00:00Z).`);
  }
  return asOf;
}

/** --physics forces physics, --classic forces BM25+cosine, else physics unless the config turns it off. */
export function engineFlags(flags: CliFlags, config: HippoConfig): EngineFlags {
  return {
    usePhysics: boolFlag(flags, 'physics') || (!boolFlag(flags, 'classic') && config.physics.enabled !== false),
    physicsConfig: config.physics,
    mmr: !boolFlag(flags, 'no-mmr') && config.mmr.enabled,
    mmrLambda: numberFlag(flags, 'mmr-lambda') ?? config.mmr.lambda,
    localBump: boolFlag(flags, 'equal-sources') ? 1.0 : (numberFlag(flags, 'local-bump') ?? config.search.localBump),
  };
}

// parseArgs turns a value-less flag into `true`; refuse rather than silently stringifying it (String(true) === 'true'),
// mirroring handleHandoff's guard.
export function stringFlagOrExit(flags: CliFlags, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (v === true || v === false || Array.isArray(v)) fail(`--${key} requires a value`);
  return v.trim();
}
