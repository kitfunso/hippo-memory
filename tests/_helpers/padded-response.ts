// A real Response whose JSON body is valid but padded with whitespace, streamed so a body of tens of MiB costs one chunk of memory.

const CHUNK_BYTES = 1024 * 1024;

/** `head`, then at least `paddingBytes` of spaces, then `tail`: JSON that parses to `head + tail` and is longer than a byte cap. */
export function paddedJsonResponse(head: string, tail: string, paddingBytes: number): Response {
  const encoder = new TextEncoder();
  const chunk = new Uint8Array(CHUNK_BYTES).fill(0x20);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(head)); },
    pull(controller) {
      if (sent < paddingBytes) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        return;
      }
      controller.enqueue(encoder.encode(tail));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}
