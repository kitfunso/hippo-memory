/** `text` is set only when data arrived. `timedOut` distinguishes "stdin
 * ended empty" from "the wait window closed while stdin was still open". */
export interface BoundedStdin { text?: string; timedOut: boolean; }

function defaultWaitMs(): number {
  const parsed = Number.parseInt(process.env.HIPPO_STDIN_WAIT_MS ?? '', 10);
  return parsed > 0 ? parsed : 1000;
}

/** Never blocks: a TTY resolves at once, otherwise waits up to `waitMs`
 * (default 1000ms, or `HIPPO_STDIN_WAIT_MS`), refreshed on each chunk so
 * a slow but real write is not cut off mid-payload. */
export function readStdinBounded(waitMs: number = defaultWaitMs()): Promise<BoundedStdin> {
  let stdin: NodeJS.ReadStream;
  try { stdin = process.stdin; } catch { return Promise.resolve({ timedOut: false }); }
  if (stdin.isTTY) return Promise.resolve({ timedOut: false });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const finish = (timedOut: boolean): void => {
      clearTimeout(timer);
      stdin.off('data', onData); stdin.off('end', done); stdin.off('error', done);
      stdin.pause();
      stdin.unref?.();
      resolve({ text: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined, timedOut });
    };
    const done = (): void => finish(false);
    const onData = (c: Buffer): void => { chunks.push(c); timer.refresh(); };
    const timer = setTimeout(() => finish(true), waitMs);
    stdin.on('data', onData); stdin.once('end', done); stdin.once('error', done);
  });
}
