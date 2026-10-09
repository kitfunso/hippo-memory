// Readers that turn parsed CLI flags into typed values, and the flag types they share.

import type { RecallSearchOpts } from '../api/recall-pipeline.js';
import type { HippoConfig } from '../core/config.js';
import { printError } from './output.js';

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
  if (typeof value !== 'string') {
    printError('--budget requires an integer value (e.g. --budget 1500).');
    process.exit(1);
  }
  // Number(), like the --hops guard: parseInt('12abc') is 12, silently accepting what this message rejects.
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    printError(`Invalid --budget: "${value}". Must be a non-negative integer.`);
    process.exit(1);
  }
  return parsed;
}

export type CliFlags = Record<string, string | boolean | string[]>;

// Whole-arg digits only: parseInt alone reads "1abc" as 1 and a mutating verb would hit the wrong row. Digits past 2^53 round to a neighbouring id, so they are refused too.
export function parsePositiveId(idRaw: unknown, label: string): number {
  const s = String(idRaw ?? '').trim();
  const id = parseInt(s, 10);
  if (!/^\d+$/.test(s) || id <= 0 || !Number.isSafeInteger(id)) {
    printError(`Invalid ${label} id: "${idRaw}" (expected a positive integer).`);
    process.exit(1);
  }
  return id;
}

export function parseListLimit(flags: CliFlags): number {
  const limitRaw = flags['limit'];
  const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    printError(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
    process.exit(1);
  }
  return limit;
}

// A value-less flag is `true` and a repeated one is a string[]; only a string counts here.
export function stringFlag(flags: CliFlags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

// An empty value reads as absent, so `--change ""` keeps the default.
export function nonEmptyStringFlag(flags: CliFlags, name: string): string | undefined {
  return stringFlag(flags, name) || undefined;
}

export function numberFlag(flags: CliFlags, name: string): number | undefined {
  const v = flags[name];
  return typeof v === 'string' ? Number(v) : undefined;
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
  readonly args: string[];
  readonly flags: CliFlags;
}

export type EngineFlags = Pick<RecallSearchOpts, 'usePhysics' | 'physicsConfig' | 'mmr' | 'mmrLambda' | 'localBump'>;

export function parseAsOfFlag(flags: CliFlags): string | undefined {
  const asOf = stringFlag(flags, 'as-of');
  if (asOf !== undefined && Number.isNaN(new Date(asOf).getTime())) {
    printError(`Error: --as-of value "${asOf}" is not a valid ISO date (e.g. 2026-04-22 or 2026-04-22T12:00:00Z).`);
    process.exit(1);
  }
  return asOf;
}

/** --physics forces physics, --classic forces BM25+cosine, else physics unless the config turns it off. */
export function engineFlags(flags: CliFlags, config: HippoConfig): EngineFlags {
  return {
    usePhysics: boolFlag(flags, 'physics') || (!flags['classic'] && config.physics.enabled !== false),
    physicsConfig: config.physics,
    mmr: !flags['no-mmr'] && config.mmr.enabled,
    mmrLambda: flags['mmr-lambda'] !== undefined ? parseFloat(String(flags['mmr-lambda'])) : config.mmr.lambda,
    localBump: flags['equal-sources']
      ? 1.0
      : flags['local-bump'] !== undefined ? parseFloat(String(flags['local-bump'])) : config.search.localBump,
  };
}

// parseArgs turns a value-less flag into `true`; refuse rather than silently
// stringifying it (String(true) === 'true'), mirroring handleHandoff's guard.
export function stringFlagOrExit(flags: CliFlags, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (v === true || v === false || Array.isArray(v)) { printError(`--${key} requires a value`); process.exit(1); }
  return v.trim();
}
