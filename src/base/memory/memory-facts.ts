// What the dashboard reads off one memory at an instant. The store's dashboard SQL calls these same functions, so a
// count, a sort and a listed row never judge one memory two ways.
import {
  calculateStrength,
  confidenceFacets,
  netWrong,
  Layer,
  type ConfidenceInputs,
  type LossAversion,
  type MemoryEntry,
  type StrengthInputs,
} from './memory.js';
import { AT_RISK_BELOW, STRONG_FROM } from './strength-bands.js';
import { DAY_MS } from '../util/time.js';

/** Band indices, in the order the dashboard's wire names them: pinned, strong, fading, at risk. */
const BAND_PINNED = 0;
const BAND_STRONG = 1;
const BAND_FADING = 2;
export const BAND_AT_RISK = 3;

/** Layers in the dashboard's wire order; a layer's index is its place here. */
export const LAYER_ORDER = [Layer.Buffer, Layer.Episodic, Layer.Semantic, Layer.Trace] as const;

/** Confidence tiers in sort order; any other tier sorts after them. */
export const CONFIDENCE_ORDER = ['verified', 'observed', 'inferred', 'stale'] as const;

/** Days of created history the dashboard's series spans; an older row counts at its first point. */
export const SERIES_DAYS = 90;

const AHEAD_7D_MS = 7 * DAY_MS;
const AHEAD_30D_MS = 30 * DAY_MS;

export interface MemoryFacts {
  strength: number;
  strength7d: number;
  strength30d: number;
  band: number;
  layer: number;
  ageDays: number;
  lastRetrievedDays: number;
  confidence: string;
  agedOut: boolean;
  wrong: boolean;
}

/** Index of a layer in `LAYER_ORDER`. */
export function layerIndex(layer: Layer): number {
  switch (layer) {
    case Layer.Buffer:
      return 0;
    case Layer.Episodic:
      return 1;
    case Layer.Semantic:
      return 2;
    case Layer.Trace:
      return 3;
  }
}

/** Days from `thenIso` to `nowMs`, never below 0; 0 when the time does not parse. */
export function daysBetween(thenIso: string, nowMs: number): number {
  const days = (nowMs - Date.parse(thenIso)) / DAY_MS;
  return Number.isFinite(days) ? Math.max(0, days) : 0;
}

/** A pin wins, then 30-day strength under the at-risk cut, then strength now at or over the strong cut. */
function bandOf(pinned: boolean, strength: number, strength30d: number): number {
  if (pinned) return BAND_PINNED;
  if (strength30d < AT_RISK_BELOW) return BAND_AT_RISK;
  return strength >= STRONG_FROM ? BAND_STRONG : BAND_FADING;
}

/** The band of `entry` at `nowMs`, as memoryFacts judges it. */
export function bandAt(entry: StrengthInputs, nowMs: number, lossAversion: LossAversion): number {
  const strength = calculateStrength(entry, new Date(nowMs), lossAversion);
  return bandOf(entry.pinned, strength, calculateStrength(entry, new Date(nowMs + AHEAD_30D_MS), lossAversion));
}

/** A list shows this many UTF-16 units of content; the store reads one character more, so the cut shows. */
export const LIST_HEAD_CHARS = 240;

/** The start of a memory's content a list shows, and whether any was left off. */
export interface ListHead {
  readonly head: string;
  readonly truncated: boolean;
}

/** Never splits a surrogate pair. */
export function listHead(content: string): ListHead {
  if (content.length <= LIST_HEAD_CHARS) return { head: content, truncated: false };
  let end = LIST_HEAD_CHARS;
  const last = content.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { head: content.slice(0, end), truncated: true };
}

/** 0 strong, 1 fading, 2 under the at-risk cut. */
export function strengthBucket(value: number): 0 | 1 | 2 {
  return value >= STRONG_FROM ? 0 : value >= AT_RISK_BELOW ? 1 : 2;
}

/** Whole days from `timeMs` back from `nowMs`, held to 0 through SERIES_DAYS; a time to come is today. */
export function seriesDay(timeMs: number, nowMs: number): number {
  return Math.min(SERIES_DAYS, Math.max(0, Math.floor((nowMs - timeMs) / DAY_MS)));
}

/** Strength now and at +7d and +30d, band, age and the confidence split for one entry at `nowMs`. */
export function memoryFacts(
  entry: StrengthInputs & ConfidenceInputs & Pick<MemoryEntry, 'layer'>,
  nowMs: number,
  lossAversion: LossAversion,
): MemoryFacts {
  const now = new Date(nowMs);
  const strength = calculateStrength(entry, now, lossAversion);
  const strength7d = calculateStrength(entry, new Date(nowMs + AHEAD_7D_MS), lossAversion);
  const strength30d = calculateStrength(entry, new Date(nowMs + AHEAD_30D_MS), lossAversion);
  const facets = confidenceFacets(entry, now);
  return {
    strength,
    strength7d,
    strength30d,
    band: bandOf(entry.pinned, strength, strength30d),
    layer: layerIndex(entry.layer),
    ageDays: daysBetween(entry.created, nowMs),
    lastRetrievedDays: daysBetween(entry.lastRetrieved, nowMs),
    confidence: facets.tier,
    agedOut: facets.agedOut,
    wrong: netWrong(entry) > 0,
  };
}
