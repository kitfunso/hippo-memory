// An embed failure, reported once.
import { errorCode, log } from '../../base/util/log.js';
import { redactSecretsStrict } from '../../base/util/secret-detect.js';
import type { FailureNotices } from '../../base/util/failure-notices.js';

/** A provider's `[]` row is a swallowed per-item failure; name the memory so the gap can
 * be traced. */
export function noteSkippedEmbedding(id: string): void {
  log.warn('memory not embedded; the next embed run retries it', { id });
}

function embedFailureKey(source: string, cause: unknown): string {
  const kind = errorCode(cause) || (cause instanceof Error ? cause.constructor.name : 'NonError');
  return `${source}:${kind}`;
}

// A loop, not /\.+$/: that regex retries from every dot, so a provider error with a long run of
// dots costs O(n^2).
function withoutTrailingDots(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '.') end -= 1;
  return text.slice(0, end);
}

export function warnEmbedFailureOnce(
  notices: FailureNotices,
  source: string,
  rawMessage: string,
  cause?: unknown,
): void {
  const notice = notices.note(embedFailureKey(source, cause), Date.now());
  if (notice === null) return;
  if (notice.kind === 'repeats') {
    log.warn(
      `${notice.count} more embedding errors from ${source} since ` +
        `the last notice; memories are still stored without embeddings.`,
    );
    return;
  }
  // Strict scrub: this line can land in a hook log file, and an API may echo the key back in its
  // error body.
  const message = withoutTrailingDots(redactSecretsStrict(rawMessage).replace(/\s+/g, ' '));
  log.warn(
    `embedding failed (${source}): ${message}. Memories are stored without embeddings until this is fixed.`,
  );
}

export const OTHER_MODEL_INDEX =
  "the vector index was built by another embedding model; run 'hippo embed' to rebuild it";
