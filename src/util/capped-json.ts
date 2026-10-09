import type { JsonValue } from './json.js';

// The timeout bounds time, not bytes: a hostile endpoint could stream a huge 2xx body into memory.
/** Reads a reply body as JSON and stops with an error as soon as it passes `maxBytes`. */
export async function readCappedJson(resp: Response, maxBytes: number): Promise<JsonValue> {
  if (!resp.body) throw new Error('reply has no body');
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`reply over ${maxBytes} bytes`);
    }
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('reply is not JSON');
  }
}
