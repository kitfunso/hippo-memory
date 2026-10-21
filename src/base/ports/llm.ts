// The language-model port: domain writes the prompt and reads the reply; src/infra/anthropic-llm.ts makes the call.
import { errorCode, errorFields, type LogFields } from '../util/log.js';

export interface LlmRequest {
  /** The model the caller's config names; the adapter's own default when absent. */
  readonly model?: string;
  readonly maxTokens: number;
  readonly prompt: string;
}

// `cause` is the thrown value behind a message, kept so the site that logs the failure can write its class and chain.
export type LlmFailure =
  | { kind: 'request'; message: string; cause?: unknown }
  | { kind: 'http'; status: number; detail: string }
  | { kind: 'unreadable'; message: string }
  | { kind: 'empty' };

export type LlmReply = { ok: true; text: string } | { ok: false; failure: LlmFailure };

/** One user prompt in, the reply's first text block or a typed failure out. Never throws. */
export interface Llm {
  send(request: LlmRequest): Promise<LlmReply>;
}

// A bad or missing key, no credit, no permission, an unknown model: every later call gets the same answer.
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 404]);

/** True for a failure the next call would repeat, so a caller looping over items should stop rather than retry. */
export function isPermanentFailure(failure: LlmFailure): boolean {
  return failure.kind === 'http' && PERMANENT_STATUSES.has(failure.status);
}

/** The first errno name (ECONNRESET, ENOTFOUND) along a cause chain; fetch puts it one level down. */
function errnoOf(cause: unknown): string {
  for (let link = cause, depth = 0; link instanceof Error && depth < 5; link = link.cause, depth++) {
    const code = errorCode(link);
    if (code !== '') return code;
  }
  return '';
}

/** Log fields for any failure: its kind and status, plus the class, stack, cause chain and errno of a thrown error. */
export function llmFailureFields(failure: LlmFailure): LogFields {
  switch (failure.kind) {
    case 'http':
      return { llmFailure: 'http', status: failure.status };
    case 'request': {
      if (failure.cause === undefined) return { llmFailure: 'request' };
      const code = errnoOf(failure.cause);
      const fields = { llmFailure: 'request', ...errorFields(failure.cause) };
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
      return failure.detail ? `HTTP ${failure.status}: ${failure.detail}` : `HTTP ${failure.status}`;
    case 'unreadable':
      return `unparseable response: ${failure.message}`;
    case 'empty':
      return 'the reply held no text';
  }
}
