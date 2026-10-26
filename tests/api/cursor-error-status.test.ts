// A malformed cursor is still a 400 with the text it always had, though the api now throws its own error class.
import { describe, expect, it } from 'vitest';
import { parseCursor } from '../../src/api/cursor.js';
import { mapApiError } from '../../src/api/error-reply.js';

describe('parseCursor refusal', () => {
  it('maps to the 400 and the text clients already read', () => {
    let thrown: unknown;
    try {
      parseCursor('not-a-cursor!', 'string', 'integer');
    } catch (err) {
      thrown = err;
    }
    expect(mapApiError(thrown)).toEqual({
      status: 400,
      message: 'cursor is malformed; pass next_cursor from the previous page unchanged',
    });
  });
});
