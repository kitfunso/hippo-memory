// The request abort ends a running outbound call, not only the next step.
import { describe, expect, it } from 'vitest';
import { startQueryEmbedDeadline } from '../../src/domain/search/vector.js';

describe('startQueryEmbedDeadline', () => {
  it("aborts with the request's signal", () => {
    const abort = new AbortController();
    const embedDeadline = startQueryEmbedDeadline({ signal: abort.signal });
    expect(embedDeadline.aborted).toBe(false);
    abort.abort(new Error('client left'));
    expect(embedDeadline.aborted).toBe(true);
  });

  it('with no request signal, runs on its own budget', () => {
    expect(startQueryEmbedDeadline({}).aborted).toBe(false);
  });
});
