import * as fs from 'fs';
import { errorMessage, log } from './log.js';

// Node's `write` is overloaded (`(chunk, cb?)` vs `(chunk, encoding, cb?)`); this is the union of both parameter lists.
type StreamWriteArgs = [
  chunk: string | Uint8Array,
  encodingOrCb?: BufferEncoding | ((err?: Error) => void),
  cb?: (err?: Error) => void,
];

/** Mirrors every stdout and stderr chunk to `logFile` until the returned restore runs; an append failure warns once and never stops the real write. */
export function teeStdStreams(logFile: string): () => void {
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  let warned = false;
  const tee = (chunk: string | Uint8Array): void => {
    try {
      fs.appendFileSync(logFile, chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : chunk, 'utf8');
    } catch (err) {
      if (warned) return;
      warned = true;
      log.warn(`log file ${logFile} is no longer writable; output continues without it: ${errorMessage(err)}`);
    }
  };
  const wrapWrite = (origWrite: typeof process.stdout.write): typeof process.stdout.write => {
    const wrapped = (...args: StreamWriteArgs): boolean => {
      tee(args[0]);
      // SAFETY: forwarding the exact arguments the real overloaded `write` received is safe; `StreamWriteArgs` is the union of both overloads' parameter lists.
      return (origWrite as (...args: StreamWriteArgs) => boolean)(...args);
    };
    // SAFETY: `wrapped` matches both real `write` overload shapes; TS cannot verify one implementation covers an overloaded type.
    return wrapped as typeof process.stdout.write;
  };
  process.stdout.write = wrapWrite(origStdoutWrite);
  process.stderr.write = wrapWrite(origStderrWrite);

  return () => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  };
}
