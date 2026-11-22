import { describe, expect, it } from 'vitest';
import { readCappedJson } from '../../src/base/util/capped-json.js';
import { chainText, tokenWindows } from '../_helpers/github-token-leak.js';

const CANARY = 'ghp_CANARYabcdefghijklmnopqrstuvwxyz0123';

async function failureOf(body: string): Promise<Error> {
  try {
    await readCappedJson(new Response(body, { status: 200 }), 1024);
  } catch (err) {
    if (err instanceof Error) return err;
  }
  throw new Error('expected an error');
}

describe('readCappedJson on a body that is not JSON', () => {
  it.each([
    ['text that starts with the secret', `${CANARY} not json`],
    ['an object cut short after the secret', `{"token":"${CANARY}"`],
    ['an HTML page that echoes the secret', `<html><body>${CANARY}</body></html>`],
  ])('names the failure without any part of the body for %s', async (_name, body) => {
    const err = await failureOf(body);

    expect(err.message).toBe('reply is not JSON');
    expect(err.cause).toBeUndefined();
    expect(tokenWindows(CANARY, 8).filter((w) => chainText(err).includes(w))).toEqual([]);
    expect(chainText(err)).not.toMatch(/SyntaxError|is not valid JSON|Unexpected token/);
  });
});
