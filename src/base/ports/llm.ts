import { errorCode, errorFields, type LogFields } from '../util/log.js';

export interface LlmRequest {
  readonly model?: string;
  readonly maxTokens: number;
  readonly prompt: string;
  readonly signal?: AbortSignal | undefined;
}

export type LlmFailure =
  | { kind: 'request'; message: string; cause?: unknown }
  | { kind: 'http'; status: number; detail: string }
  | { kind: 'unreadable'; message: string; cause?: unknown }
  | { kind: 'config'; message: string }
  | { kind: 'empty' };

/** What the provider billed for one call; an empty reply is billed too. */
export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type LlmReply = ({ ok: true; text: string } | { ok: false; failure: LlmFailure }) & {
  readonly usage?: LlmUsage;
};

/** One user prompt in, the reply's first text block or a typed failure out. Never throws. */
export interface Llm {
  send(request: LlmRequest): Promise<LlmReply>;
}

const PERMANENT_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 404]);

/** True for a failure the next call would repeat, so a caller looping over items should stop
 * rather than retry. */
export function isPermanentFailure(failure: LlmFailure): boolean {
  if (failure.kind === 'config') return true;
  if (failure.kind !== 'http') return false;
  return PERMANENT_STATUSES.has(failure.status) || (failure.status >= 300 && failure.status < 400);
}

/** The first errno name (ECONNRESET, ENOTFOUND) along a cause chain; fetch puts it one level
 * down. */
function errnoOf(cause: unknown): string {
  for (
    let link = cause, depth = 0;
    link instanceof Error && depth < 5;
    link = link.cause, depth++
  ) {
    const code = errorCode(link);
    if (code !== '') return code;
  }
  return '';
}

/** Log fields for any failure: its kind and status, plus the class, stack, cause chain and errno
 * of a thrown error. */
export function llmFailureFields(failure: LlmFailure): LogFields {
  switch (failure.kind) {
    case 'http':
      return { llmFailure: 'http', status: failure.status };
    case 'request':
    case 'unreadable': {
      if (failure.cause === undefined) return { llmFailure: failure.kind };
      const code = errnoOf(failure.cause);
      const fields = { llmFailure: failure.kind, ...errorFields(failure.cause) };
      return code === '' ? fields : { ...fields, errno: code };
    }
    default:
      return { llmFailure: failure.kind };
  }
}

/** The text extraction and DAG summaries hand to their `onError` callback. */
export function describeLlmFailure(failure: LlmFailure): string {
  switch (failure.kind) {
    case 'request':
      return `request failed: ${failure.message}`;
    case 'http':
      return failure.detail
        ? `HTTP ${failure.status}: ${failure.detail}`
        : `HTTP ${failure.status}`;
    case 'unreadable':
      return `unparseable response: ${failure.message}`;
    case 'config':
      return failure.message;
    case 'empty':
      return 'the reply held no text';
  }
}
