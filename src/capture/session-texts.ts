// `hippo capture --last-session` for a caller whose transcript was read on another machine: its project names the rows, never the store's folder.
import { BadRequestError } from '../core/api-errors.js';
import type { Context } from '../api/types.js';
import { assertCallerIds, type CallerProject } from '../api/prompt-hook.js';
import { assertCallerProject, projectNames } from '../core/project-identity.js';
import { longestWord, storedTextKeys } from '../util/same-text.js';
import { scrubForSharing } from './share-scrub.js';
import { loadTextsHoldingWords } from '../store/candidates.js';
import { captureExtractedItems, type CaptureTally } from './command.js';
import { extractFromTexts } from './extract.js';

const MAX_TEXTS = 30;
const MAX_TEXT_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_ITEMS = 50;

export interface SessionCaptureRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  /** The session's turns, as sessionTail returns them; scrubbed again here, since the caller's scrub is not trusted. */
  readonly texts: readonly string[];
}

export type SessionCaptureResult = Readonly<CaptureTally>;

function assertSessionCapture(req: SessionCaptureRequest): void {
  assertCallerIds(req.sessionId, req.project);
  if (req.sessionId.trim() === '') throw new BadRequestError('session id: required');
  // A '' project would read every project's rows as its own and write user-global rows; a rewritten one would split a project.
  assertCallerProject(req.project);
  if (req.texts.length > MAX_TEXTS) throw new BadRequestError(`texts: at most ${MAX_TEXTS}`);
  const sizes = req.texts.map((t) => Buffer.byteLength(t, 'utf8'));
  if (sizes.some((n) => n > MAX_TEXT_BYTES)) throw new BadRequestError(`each text: at most ${MAX_TEXT_BYTES} bytes`);
  if (sizes.reduce((a, b) => a + b, 0) > MAX_TOTAL_BYTES) throw new BadRequestError(`texts: at most ${MAX_TOTAL_BYTES} bytes in all`);
}

/** Captures the session's statements into `ctx`'s tenant under the caller's project, skipping each text a row the caller can see already holds.
 *  Synchronous from the dedup read to the last write, so no other write lands between them. No console output and no process.exit. */
export function captureSessionTexts(ctx: Context, req: SessionCaptureRequest): SessionCaptureResult {
  assertSessionCapture(req);
  const extracted = extractFromTexts(req.texts.map(scrubForSharing));
  // The newest items win, since the end of a session states where it landed.
  const items = extracted.slice(-MAX_ITEMS);
  if (items.length === 0) return { captured: 0, skipped: 0, rejected: 0 };
  // The project filter is classifyOriginProject's in SQL: the caller's rows and user-global rows block a copy, other projects' rows do not.
  const held = loadTextsHoldingWords(ctx.hippoRoot, ctx.tenantId, items.map((i) => longestWord(i.content)), projectNames(req.project));
  const tally = captureExtractedItems(
    ctx.hippoRoot,
    { dryRun: false, tenantId: ctx.tenantId, originProject: req.project, sessionId: req.sessionId, actor: ctx.actor.subject, lean: true },
    items,
    storedTextKeys(held),
  );
  return { ...tally, skipped: tally.skipped + extracted.length - items.length };
}
