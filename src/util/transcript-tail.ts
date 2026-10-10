// Transcript reads shared by src/capture/ and compaction-record.ts; a leaf so neither has to import the other.
import * as fs from 'fs';

/** Never read the whole transcript: PreCompact fires exactly when it's largest. */
export const PRE_COMPACT_TAIL_BYTES = 256 * 1024;

/** Cut to `maxChars` UTF-16 units, backing off one unit rather than leave half a surrogate pair in a stored field. */
export function truncateCodePointSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  if (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return text.slice(0, end);
}

/** The last `capBytes` of a JSONL transcript, read at an offset and starting on a whole line so every line parses. */
export function readTranscriptTail(transcriptPath: string, capBytes: number = PRE_COMPACT_TAIL_BYTES): string {
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    return readOpenTranscriptTail(fd, fs.fstatSync(fd).size, capBytes);
  } finally {
    fs.closeSync(fd);
  }
}

/** {@link readTranscriptTail} for a transcript the caller opened and sized, so the size and the bytes come from one file. */
export function readOpenTranscriptTail(fd: number, size: number, capBytes: number): string {
  const start = Math.max(0, size - capBytes);
  const length = size - start;
  if (length <= 0) return '';

  // A seek that lands just after '\n' already starts a whole line and must keep it.
  let onLineBoundary = start === 0;
  if (!onLineBoundary) {
    const prevByte = Buffer.alloc(1);
    fs.readSync(fd, prevByte, 0, 1, start - 1);
    onLineBoundary = prevByte[0] === 0x0a; // '\n'
  }

  const buf = Buffer.alloc(length);
  fs.readSync(fd, buf, 0, length, start);
  const text = buf.toString('utf8');
  if (onLineBoundary) return text;
  // A read that lands mid-line drops the partial first line, so every line left parses as complete JSON.
  const nl = text.indexOf('\n');
  return nl === -1 ? '' : text.slice(nl + 1);
}
