// `hippo capture --last-session` for a caller whose transcript was read on another machine: its project names the rows,
// never the store's folder.
import { BadRequestError } from '../../base/errors/api-errors.js';
import type { ContextWith, EntryContext } from '../../api/types.js';
import { assertCallerIds, type CallerProject } from '../../api/prompt-hook.js';
import { assertCallerProject, projectNames } from '../../base/scope/project-identity.js';
import { longestWord, storedTextKeys } from '../../base/util/same-text.js';
import { scrubForSharing } from './share-scrub.js';
import { captureExtractedItems, type CaptureTally } from './command.js';
import { folderIndex } from '../../domain/search/embed-memories.js';
import { extractFromTexts } from './extract.js';
import { withEntryInfra } from '../entry-infra.js';

/** A context whose store has the captures group, which a session's capture reads and writes. */
export type CaptureContext = EntryContext<ContextWith<'captures'>>;

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
  // A '' project would read every project's rows as its own and write user-global rows; a rewritten one would split a
  // project.
  assertCallerProject(req.project);
  if (req.texts.length > MAX_TEXTS) throw new BadRequestError(`texts: at most ${MAX_TEXTS}`);
  const sizes = req.texts.map((t) => Buffer.byteLength(t, 'utf8'));
  if (sizes.some((n) => n > MAX_TEXT_BYTES)) throw new BadRequestError(`each text: at most ${MAX_TEXT_BYTES} bytes`);
  if (sizes.reduce((a, b) => a + b, 0) > MAX_TOTAL_BYTES) {
    throw new BadRequestError(`texts: at most ${MAX_TOTAL_BYTES} bytes in all`);
  }
}

/**
 * Captures the session's statements into `ctx`'s tenant under the caller's project, skipping each text a row the caller
 * can see already holds. The write reads those rows again in its own transaction, so no other write lands between the
 * dedup and the write. No console output and no process.exit.
 */
export async function captureSessionTexts(
  given: CaptureContext,
  req: SessionCaptureRequest,
): Promise<SessionCaptureResult> {
  const ctx = withEntryInfra(given);
  assertSessionCapture(req);
  const extracted = extractFromTexts(req.texts.map(scrubForSharing));
  // The newest items win, since the end of a session states where it landed.
  const items = extracted.slice(-MAX_ITEMS);
  if (items.length === 0) return { captured: 0, skipped: 0, rejected: 0 };
  // The project filter is classifyOriginProject's in SQL: the caller's rows and user-global rows block a copy, other
  // projects' rows do not.
  const dedup = { tenantId: ctx.tenantId, project: projectNames(req.project) };
  const held = await ctx.store.captures.textsHolding(
    dedup.tenantId,
    items.map((i) => longestWord(i.content)),
    { project: dedup.project },
  );
  const { store, config } = ctx;
  const tally = await captureExtractedItems(
    { store, config, index: folderIndex({ store, config, embedderFor: ctx.infra.embedderFor }) },
    {
      tenantId: ctx.tenantId,
      originProject: req.project,
      sessionId: req.sessionId,
      actor: ctx.actor.subject,
      lean: true,
      dedup,
    },
    items,
    storedTextKeys(held),
  );
  return { ...tally, skipped: tally.skipped + extracted.length - items.length };
}
