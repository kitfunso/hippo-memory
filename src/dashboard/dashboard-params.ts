// One shared parser for every dashboard query and path field, so no route trusts `parseInt` or an unchecked id.

import { LAYERS, type Chip } from './dashboard-snapshot.js';

/** A request field failed validation; the router answers 400 with this plain message. */
export class ParamError extends Error {}

export const SORT_KEYS = ['content', 'layer', 'strength', 'retrievals', 'last', 'age', 'confidence', 'scope'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

const CHIPS: readonly Chip[] = ['all', 'risk', 'pinned', 'conflict'];
const MEMORY_ID = /^[A-Za-z0-9_-]+$/;
const INTEGER = /^-?\d+$/;
export const LIMIT_DEFAULT = 100;
export const LIMIT_MAX = 500;
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 200;

export interface Brush {
  amin: number;
  amax: number;
  smin: number;
  smax: number;
}

export interface MemoryQuery {
  offset: number;
  limit: number;
  sort: SortKey;
  dir: SortDir;
  chip: Chip;
  /** Layer indices in wire order, ascending, no duplicates. */
  layers: number[];
  brush: Brush;
  /** Lowercased search text, or null when none or shorter than the minimum. */
  q: string | null;
}

function integerParam(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const n = INTEGER.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ParamError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

function oneOf<T extends string>(params: URLSearchParams, name: string, allowed: readonly T[], fallback: T): T {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const hit = allowed.find((a) => a === raw);
  if (hit === undefined) throw new ParamError(`${name} must be one of ${allowed.join(', ')}`);
  return hit;
}

function finiteParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null) return null;
  const n = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(n)) throw new ParamError(`${name} must be a number`);
  return n;
}

function layersParam(params: URLSearchParams): number[] {
  const raw = params.get('layers');
  if (raw === null) return LAYERS.map((_, i) => i);
  const picked = new Set<number>();
  for (const part of raw.split(',')) {
    const i = LAYERS.findIndex((l) => l === part.trim());
    if (i === -1) throw new ParamError(`layers must be a comma list of ${LAYERS.join(', ')}`);
    picked.add(i);
  }
  return [...picked].sort((a, b) => a - b);
}

function rangeParam(params: URLSearchParams, lo: string, hi: string): [number, number] {
  const min = finiteParam(params, lo);
  const max = finiteParam(params, hi);
  if (min !== null && max !== null && min > max) throw new ParamError(`${lo} must not exceed ${hi}`);
  return [min ?? Number.NEGATIVE_INFINITY, max ?? Number.POSITIVE_INFINITY];
}

/** Search text for the memories route: shorter than the minimum means no filter; longer than the maximum is a 400. */
function optionalSearch(params: URLSearchParams): string | null {
  const raw = params.get('q');
  if (raw === null) return null;
  const q = raw.trim();
  if (q.length > SEARCH_MAX) throw new ParamError(`q must be at most ${SEARCH_MAX} characters`);
  return q.length < SEARCH_MIN ? null : q.toLowerCase();
}

/** Parses and validates the query of `GET /api/projects/:key/memories`. */
export function parseMemoryQuery(params: URLSearchParams): MemoryQuery {
  const [amin, amax] = rangeParam(params, 'amin', 'amax');
  const [smin, smax] = rangeParam(params, 'smin', 'smax');
  const sort = oneOf(params, 'sort', SORT_KEYS, 'strength');
  return {
    offset: integerParam(params, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
    limit: integerParam(params, 'limit', LIMIT_DEFAULT, 1, LIMIT_MAX),
    sort,
    // Weakest first by default, like the mockup; retrievals starts with the most.
    dir: oneOf(params, 'dir', ['asc', 'desc'], sort === 'retrievals' ? 'desc' : 'asc'),
    chip: oneOf(params, 'chip', CHIPS, 'all'),
    layers: layersParam(params),
    brush: { amin, amax, smin, smax },
    q: optionalSearch(params),
  };
}

/** Search text for `GET /api/search`: 2 to 200 characters after trim, returned as typed (trimmed). */
export function parseSearchText(params: URLSearchParams): string {
  const q = (params.get('q') ?? '').trim();
  if (q.length < SEARCH_MIN || q.length > SEARCH_MAX) {
    throw new ParamError(`q must be ${SEARCH_MIN} to ${SEARCH_MAX} characters`);
  }
  return q;
}

/** A memory id from a path segment. */
export function parseMemoryId(raw: string): string {
  if (!MEMORY_ID.test(raw)) throw new ParamError('Invalid memory id');
  return raw;
}

/** The only fields a dashboard POST reads; a field of the wrong type arrives as undefined. */
export interface ActionBody {
  pinned?: boolean;
  keep?: string;
}

/** Parses a POST body once at the boundary; an empty body is `{}` and invalid JSON is a 400. */
export function parseActionBody(text: string): ActionBody {
  let raw;
  try {
    raw = JSON.parse(text === '' ? '{}' : text);
  } catch {
    throw new ParamError('Body is not valid JSON');
  }
  const pinned = raw?.pinned;
  const keep = raw?.keep;
  // String(x) === x is true only for a string, which is the check without a typeof.
  return {
    pinned: pinned === true || pinned === false ? pinned : undefined,
    keep: String(keep) === keep ? keep : undefined,
  };
}

/** A conflict id from a path segment: a positive integer. */
export function parseConflictId(raw: string): number {
  const n = INTEGER.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new ParamError('Invalid conflict id');
  return n;
}
