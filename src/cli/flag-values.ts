// Readers that turn parsed CLI flags into typed values, and the flag types they share.

import { DEFAULT_LIST_LIMIT } from '../util/limits.js';
import type { RecallSearchOpts } from '../api/recall-pipeline.js';
import type { HippoConfig } from '../core/config.js';
import { printError } from './output.js';
import { CliExit } from './exit.js';

export function isBooleanFlag(value: string | boolean | string[] | undefined): value is boolean {
  return typeof value === 'boolean';
}

export function isStringFlag(value: string | boolean | string[] | undefined): value is string {
  return typeof value === 'string';
}

export function parseLimitFlag(value: string | boolean | string[] | undefined): number {
  if (!value) return Infinity;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : Infinity;
}

export function parseCountFlag(value: string | boolean | string[] | undefined): number {
  if (!value || value === true || Array.isArray(value)) return 0;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 0;
}

export function parseBudgetFlag(value: string | boolean | string[] | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  // A value-less flag and a junk value are different typos; the --hops guard already splits them.
  if (!isStringFlag(value)) {
    printError('--budget requires an integer value (e.g. --budget 1500).');
    throw new CliExit(1);
  }
  // Number(), like the --hops guard: parseInt('12abc') is 12, silently accepting what this message rejects.
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    printError(`Invalid --budget: "${value}". Must be a non-negative integer.`);
    throw new CliExit(1);
  }
  return parsed;
}

export type CliFlags = Record<string, string | boolean | string[]>;

// Whole-arg digits only: parseInt alone reads "1abc" as 1 and a mutating verb would hit the wrong row. Digits past 2^53 round to a neighbouring id, so they are refused too.
export function parsePositiveId(idRaw: string | undefined, label: string): number {
  const s = String(idRaw ?? '').trim();
  const id = parseInt(s, 10);
  if (!/^\d+$/.test(s) || id <= 0 || !Number.isSafeInteger(id)) {
    printError(`Invalid ${label} id: "${idRaw}" (expected a positive integer).`);
    throw new CliExit(1);
  }
  return id;
}

export function parseListLimit(flags: CliFlags): number {
  const limitRaw = flags['limit'];
  const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : DEFAULT_LIST_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    printError(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
    throw new CliExit(1);
  }
  return limit;
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
  return isStringFlag(v) ? v.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
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
    printError(`Invalid --${name}: "${v}". Must be a number.`);
    throw new CliExit(1);
  }
  return parsed;
}

// Any truthy value counts, so a string value is true too.
export function boolFlag(flags: CliFlags, name: string): boolean {
  return Boolean(flags[name]);
}

// Only a bare switch counts; `--x value` is false.
export function flagIsTrue(flags: CliFlags, name: string): boolean {
  return flags[name] === true;
}

/** What the command table hands each verb's run(). */
export interface CommandContext {
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly args: string[];
  readonly flags: CliFlags;
}

export type EngineFlags = Pick<RecallSearchOpts, 'usePhysics' | 'physicsConfig' | 'mmr' | 'mmrLambda' | 'localBump'>;

export function parseAsOfFlag(flags: CliFlags): string | undefined {
  const asOf = stringFlag(flags, 'as-of');
  if (asOf !== undefined && Number.isNaN(new Date(asOf).getTime())) {
    printError(`Error: --as-of value "${asOf}" is not a valid ISO date (e.g. 2026-04-22 or 2026-04-22T12:00:00Z).`);
    throw new CliExit(1);
  }
  return asOf;
}

/** --physics forces physics, --classic forces BM25+cosine, else physics unless the config turns it off. */
export function engineFlags(flags: CliFlags, config: HippoConfig): EngineFlags {
  return {
    usePhysics: boolFlag(flags, 'physics') || (!flags['classic'] && config.physics.enabled !== false),
    physicsConfig: config.physics,
    mmr: !flags['no-mmr'] && config.mmr.enabled,
    mmrLambda: numberFlag(flags, 'mmr-lambda') ?? config.mmr.lambda,
    localBump: flags['equal-sources']
      ? 1.0
      : numberFlag(flags, 'local-bump') ?? config.search.localBump,
  };
}

// parseArgs turns a value-less flag into `true`; refuse rather than silently
// stringifying it (String(true) === 'true'), mirroring handleHandoff's guard.
export function stringFlagOrExit(flags: CliFlags, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (v === true || v === false || Array.isArray(v)) { printError(`--${key} requires a value`); throw new CliExit(1); }
  return v.trim();
}
