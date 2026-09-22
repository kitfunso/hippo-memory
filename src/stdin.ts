/** `timedOut` means the window closed with stdin still open, so absent
 * `text` is "unknown", not "none", and present `text` may be truncated.
 * Treating absence as a manual run is only safe when it is false. */
export interface BoundedStdin { text?: string; timedOut: boolean; }

function defaultWaitMs(): number {
  const parsed = Number.parseInt(process.env.HIPPO_STDIN_WAIT_MS ?? '', 10);
  return parsed > 0 ? parsed : 1000;
}

/** Never blocks: a TTY resolves at once, otherwise waits up to `waitMs` of
 * idle (default 1000ms, or `HIPPO_STDIN_WAIT_MS`), refreshed on each chunk
 * so a slow but real write is not cut off, and capped at `waitMs * 10`. */
export function readStdinBounded(waitMs: number = defaultWaitMs()): Promise<BoundedStdin> {
  let stdin: NodeJS.ReadStream;
  try { stdin = process.stdin; } catch { return Promise.resolve({ timedOut: false }); }
  if (stdin.isTTY) return Promise.resolve({ timedOut: false });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const finish = (timedOut: boolean): void => {
      clearTimeout(timer); clearTimeout(hardCap);
      stdin.off('data', onData); stdin.off('end', done); stdin.off('error', done);
      stdin.pause();
      stdin.unref?.();
      resolve({ text: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined, timedOut });
    };
    const done = (): void => finish(false);
    const onData = (c: Buffer): void => { chunks.push(c); timer.refresh(); };
    const timer = setTimeout(() => finish(true), waitMs);
    // The idle timer refreshes per chunk, so a host that dribbles bytes
    // forever without ending would never resolve without this ceiling.
    const hardCap = setTimeout(() => finish(true), waitMs * 10);
    stdin.on('data', onData); stdin.once('end', done); stdin.once('error', done);
  });
}
