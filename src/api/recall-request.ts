// The recall and context input rules in one copy, so MCP and HTTP reject the same inputs with the same messages.
import { BadRequestError } from '../core/api-errors.js';
import { MAX_ID_LEN } from '../util/limits.js';
import { type JsonValue, isJsonString } from '../util/json.js';
import type { ContextOpts } from './context-types.js';
import type { RecallOpts } from './recall-types.js';

const MAX_RECALL_LIMIT = 1000;
// recall() owns the shape rule for scorer_window (invalid_scorer_window); this cap bounds remote cost.
const MAX_SCORER_WINDOW = 1000;
// Bounds BM25 tokenisation cost while covering pasted error messages.
const MAX_CONTEXT_QUERY_LEN = 1024;
const RECALL_MODES = ['bm25', 'hybrid', 'physics'] as const;

/** A recall or context input the caller must fix; MCP answers it with an isError result, HTTP with a 400. */
export class RecallRequestError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = 'RecallRequestError';
  }
}

type ParamValue = JsonValue | undefined;

/** A request's named inputs; `queryName` is the surface's name for the query text. */
export interface RequestParams {
  readonly get: (name: string) => ParamValue;
  readonly queryName: 'q' | 'query';
}

export function httpParams(query: URLSearchParams): RequestParams {
  return { get: (name) => query.get(name) ?? undefined, queryName: 'q' };
}

export function toolParams(args: Readonly<Record<string, JsonValue>>): RequestParams {
  return { get: (name) => args[name], queryName: 'query' };
}

/** The recall options every surface passes through to retrieve(). */
export type SharedRecallOpts = Pick<
  RecallOpts,
  'query' | 'scope' | 'freshTailCount' | 'freshTailSessionId' | 'summarizeOverflow' | 'scorerWindow' | 'sessionId'
> & { includeContinuity: boolean };

export interface ParsedRecallRequest {
  readonly opts: SharedRecallOpts;
  readonly limit: number | undefined;
  readonly mode: RecallOpts['mode'];
  readonly explain: boolean;
}

export type ParsedContextRequest = Pick<ContextOpts, 'q' | 'budget' | 'limit' | 'pinnedOnly' | 'scope' | 'includeRecent' | 'crossProject'>;

function numberParam(params: RequestParams, name: string): number | undefined {
  const value = params.get(name);
  return value === undefined || value === null ? undefined : Number(value);
}

function nonNegativeParam(params: RequestParams, name: string): number | undefined {
  const n = numberParam(params, name);
  if (n !== undefined && (!Number.isFinite(n) || n < 0)) throw new RecallRequestError(`${name} must be a non-negative number`);
  return n;
}

// Only `true`, "1" and "true" turn a flag on, so `?summarize_overflow=banana` or an empty value stays off.
function flagParam(params: RequestParams, name: string): boolean {
  const value = params.get(name);
  return value === true || value === '1' || value === 'true';
}

function optionalFlagParam(params: RequestParams, name: string): boolean | undefined {
  const value = params.get(name);
  return value === undefined || value === null ? undefined : flagParam(params, name);
}

function stringParam(params: RequestParams, name: string): string | undefined {
  const value = params.get(name);
  return isJsonString(value) && value.length > 0 ? value : undefined;
}

/** An id-shaped string capped at MAX_ID_LEN; empty reads as absent. */
function idParam(params: RequestParams, name: string): string | undefined {
  const value = params.get(name);
  if (isJsonString(value) && value.length > MAX_ID_LEN) throw new RecallRequestError(`${name} exceeds ${MAX_ID_LEN}-character cap`);
  return stringParam(params, name);
}

function limitParam(params: RequestParams): number | undefined {
  const limit = numberParam(params, 'limit');
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > MAX_RECALL_LIMIT)) {
    throw new RecallRequestError(`limit must be a positive integer <= ${MAX_RECALL_LIMIT}`);
  }
  return limit;
}

function modeParam(params: RequestParams): RecallOpts['mode'] {
  const value = params.get('mode');
  if (value === undefined || value === null) return undefined;
  const mode = RECALL_MODES.find((m) => m === value);
  if (!mode) throw new RecallRequestError("mode must be 'bm25', 'hybrid', or 'physics'");
  return mode;
}

function scorerWindowParam(params: RequestParams): number | undefined {
  const scorerWindow = numberParam(params, 'scorer_window');
  if (scorerWindow !== undefined && scorerWindow > MAX_SCORER_WINDOW) {
    throw new RecallRequestError(`scorer_window must be <= ${MAX_SCORER_WINDOW}`);
  }
  return scorerWindow;
}

/** Trimmed, and absent when blank, so a whitespace id never keys a goal stack or a session ring. */
function sessionIdParam(params: RequestParams): string | undefined {
  const value = idParam(params, 'session_id');
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Checks in a fixed order, so the first bad input is the one reported. */
export function parseRecallRequest(params: RequestParams): ParsedRecallRequest {
  const query = params.get(params.queryName);
  if (!isJsonString(query) || query.length === 0) throw new RecallRequestError(`${params.queryName} is required`);
  const limit = limitParam(params);
  const mode = modeParam(params);
  const scope = stringParam(params, 'scope');
  const includeContinuity = flagParam(params, 'include_continuity');
  const freshTailCount = nonNegativeParam(params, 'fresh_tail_count');
  const freshTailSessionId = idParam(params, 'fresh_tail_session_id');
  const summarizeOverflow = optionalFlagParam(params, 'summarize_overflow');
  const scorerWindow = scorerWindowParam(params);
  const sessionId = sessionIdParam(params);
  const explain = flagParam(params, 'explain');
  return {
    opts: { query, scope, includeContinuity, freshTailCount, freshTailSessionId, summarizeOverflow, scorerWindow, sessionId },
    limit,
    mode,
    explain,
  };
}

export function parseContextRequest(params: RequestParams): ParsedContextRequest {
  const qValue = params.get(params.queryName);
  const q = isJsonString(qValue) ? qValue : undefined;
  if (q !== undefined && q.length > MAX_CONTEXT_QUERY_LEN) {
    throw new RecallRequestError(`${params.queryName} exceeds ${MAX_CONTEXT_QUERY_LEN}-character cap`);
  }
  const budget = nonNegativeParam(params, 'budget');
  const limit = numberParam(params, 'limit');
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) throw new RecallRequestError('limit must be a positive number');
  const pinnedOnly = flagParam(params, 'pinned_only');
  const scope = idParam(params, 'scope');
  const includeRecent = nonNegativeParam(params, 'include_recent');
  const crossProject = flagParam(params, 'cross_project');
  return { q, budget, limit, pinnedOnly, scope, includeRecent, crossProject };
}
