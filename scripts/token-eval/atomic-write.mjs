/** Whole writes for every record and sealed file the harness writes (round 4 plan, Record model): a kill leaves the old file or none, never half of one. */
import * as fs from 'node:fs';
import * as path from 'node:path';

// compaction-spool.ts's busy retry: antivirus or the indexer can hold a file on Windows for a moment.
const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 50;
const idle = new Int32Array(new SharedArrayBuffer(4));

/** Runs one fs step, retrying a busy code briefly, and throws the busy error when it keeps coming; any other error throws at once. */
function retryBusy(step) {
  for (let retry = 0; ; retry++) {
    try {
      return step();
    } catch (err) {
      if (!BUSY_CODES.has(err.code) || retry === BUSY_RETRIES) throw err;
      Atomics.wait(idle, 0, 0, BUSY_WAIT_MS);
    }
  }
}

/** Writes `text` to `<name>.tmp-<pid>` beside `file` and renames it into place, after deleting older `<name>.tmp-*` files a killed write left.
 * `rename` is a parameter so a test can fail it between the write and the move. */
export function writeFileAtomic(file, text, rename = fs.renameSync) {
  const { dir, base } = path.parse(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) if (name.startsWith(`${base}.tmp-`)) fs.rmSync(path.join(dir, name), { force: true });
  const temp = path.join(dir, `${base}.tmp-${process.pid}`);
  fs.writeFileSync(temp, text);
  retryBusy(() => rename(temp, path.join(dir, base)));
}

/** Appends one JSON line, first dropping a torn last line (a write cut off mid-line) as `regrade.mjs` does before its own append. */
export function appendJsonLine(file, value) {
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    const whole = text.lastIndexOf('\n') + 1;
    if (whole < text.length) fs.truncateSync(file, Buffer.byteLength(text.slice(0, whole)));
  }
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

/** The parsed JSON of a sealed file, null when it is absent; a file that exists and does not parse was changed by hand, so nothing rebuilds it. */
export function readSealed(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: sealed file does not parse; the harness never rebuilds it`, { cause: err });
  }
}
