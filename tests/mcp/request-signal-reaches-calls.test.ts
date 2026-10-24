// The request abort ends a running outbound call, not only the next step.
import { describe, expect, it } from 'vitest';
import { runWithRequestId, withRequestSignal } from '../../src/base/util/request-scope.js';
import { startQueryEmbedDeadline } from '../../src/domain/search/vector.js';

describe('withRequestSignal', () => {
  it('returns the own signal outside a request and undefined when there is none', () => {
    const own = new AbortController().signal;
    expect(withRequestSignal(own)).toBe(own);
    expect(withRequestSignal()).toBeUndefined();
  });

  it('aborts with the request, and the query embedding deadline with it', () => {
    const abort = new AbortController();
    runWithRequestId(
      'req-signal',
      () => {
        const joined = withRequestSignal();
        const embedDeadline = startQueryEmbedDeadline(60_000);
        expect(joined?.aborted).toBe(false);
        expect(embedDeadline.aborted).toBe(false);
        abort.abort(new Error('client left'));
        expect(joined?.aborted).toBe(true);
        expect(embedDeadline.aborted).toBe(true);
      },
      undefined,
      abort.signal,
    );
  });
});
