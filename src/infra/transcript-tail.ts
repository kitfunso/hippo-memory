import * as fs from 'node:fs';

/** Never read the whole transcript: PreCompact fires exactly when it's largest. */
export const PRE_COMPACT_TAIL_BYTES = 256 * 1024;

/** The last `capBytes` of a JSONL transcript, read at an offset and starting on a whole line so
 * every line parses. */
export function readTranscriptTail(
  transcriptPath: string,
  capBytes: number = PRE_COMPACT_TAIL_BYTES,
): string {
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    return readOpenTranscriptTail(fd, { size: fs.fstatSync(fd).size, capBytes });
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * {@link readTranscriptTail} for a transcript the caller opened and sized, so the size and the
 * bytes come from one file.
 */
export function readOpenTranscriptTail(
  fd: number,
  { size, capBytes }: { readonly size: number; readonly capBytes: number },
): string {
  const start = Math.max(0, size - capBytes);
  const length = size - start;
  if (length <= 0) return '';

  let onLineBoundary = start === 0;
  if (!onLineBoundary) {
    const prevByte = Buffer.alloc(1);
    fs.readSync(fd, prevByte, 0, 1, start - 1);
    onLineBoundary = prevByte[0] === 0x0a;
  }

  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, start);
  const text = buf.toString('utf8');
  if (onLineBoundary) return text;
  const nl = text.indexOf('\n');
  return nl === -1 ? '' : text.slice(nl + 1);
}
