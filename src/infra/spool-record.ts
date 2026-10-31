// A spooled compaction on disk, both directions: writing a record (spoolBody) and reading one back (parseSpooled).
import {
  isObjectLike,
  isStringValue,
  type PostCompactPayload,
} from '../base/session/capture-contract.js';
import type { CompactionText, StepFailure } from '../base/records/capture.js';
import { tryParseJson } from '../base/util/json.js';

export interface SpooledCompaction {
  tenantId: string;
  payload: PostCompactPayload;
  text: CompactionText;
  at: Date;
}

/**
 * Records one spooled compaction; it calls `recorded` once the store holds the summary, so the file
 * is done even if a later step fails. Answers why a step failed, or null; a throw counts as a
 * failure too.
 */
export type SpoolImporter = (
  spooled: SpooledCompaction,
  recorded: () => void,
) => Promise<StepFailure | null>;

/** The JSON text of one spooled compaction, which parseSpooled reads back. */
export function spoolBody(
  tenantId: string,
  payload: PostCompactPayload,
  text: CompactionText,
  at: Date,
): string {
  return JSON.stringify({
    tenantId,
    sessionId: payload.sessionId,
    trigger: payload.trigger,
    cwd: payload.cwd,
    transcriptPath: payload.transcriptPath,
    at: at.toISOString(),
    summary: text.summary,
    items: text.items,
  });
}

/** null when the text is not a spooled compaction. */
export function parseSpooled(text: string, fallbackTenantId: string): SpooledCompaction | null {
  // A half-written spool file holds no compaction; the caller treats null as unreadable.
  const raw: unknown = tryParseJson(text);
  if (
    !isObjectLike(raw) ||
    !('sessionId' in raw) ||
    !isStringValue(raw.sessionId) ||
    !('summary' in raw) ||
    !isStringValue(raw.summary)
  ) {
    return null;
  }
  if (!('at' in raw) || !isStringValue(raw.at) || Number.isNaN(Date.parse(raw.at))) return null;
  const items: string[] =
    'items' in raw && Array.isArray(raw.items) ? raw.items.filter(isStringValue) : [];
  return {
    tenantId:
      'tenantId' in raw && isStringValue(raw.tenantId) && raw.tenantId !== ''
        ? raw.tenantId
        : fallbackTenantId,
    payload: {
      sessionId: raw.sessionId,
      trigger: 'trigger' in raw && isStringValue(raw.trigger) ? raw.trigger : null,
      cwd: 'cwd' in raw && isStringValue(raw.cwd) ? raw.cwd : null,
      transcriptPath:
        'transcriptPath' in raw && isStringValue(raw.transcriptPath) ? raw.transcriptPath : null,
      compactSummary: null,
    },
    text: { summary: raw.summary, items },
    at: new Date(raw.at),
  };
}
