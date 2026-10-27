// A claim's lifecycle after it is taken: put back for another try, set aside as `.bad`, or removed.
import { MINUTE_MS } from '../base/util/time.js';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { type Log, STALE_MS, type SpoolFs, done, settle, settleCode } from './spool-files.js';

export type BadCause = 'unreadable' | 'failed' | 'interrupted';

interface PutBackOptions {
  fsx: SpoolFs;
  dir: string;
  claim: string;
  stem: string;
  attempt: number;
  log: Log;
}

/** Returns a claim to the waiting files as `<stem>.a<attempt>.json`; one that stays busy is left
 * for stale recovery. */
export function putBack(options: PutBackOptions): void {
  const { fsx, dir, claim, stem, attempt, log } = options;
  const name = path.basename(claim);
  if (
    settle(
      () => fsx.renameSync(claim, path.join(dir, `${stem}.a${attempt}.json`)),
      log,
      `spool file ${name} not put back`,
    ) === 'busy'
  ) {
    log(
      `spool file ${name} could not be put back; it returns ${STALE_MS / MINUTE_MS} minutes after its claim`,
    );
  }
}

interface WriteBadOptions {
  readonly stem: string;
  readonly cause: BadCause;
  readonly text: string;
  readonly log: Log;
  readonly what: string;
}

/** Writes `<stem>.<cause>.bad` through a random temp file, so the rename replaces any torn
 * `.bad` a crash left. */
export function writeBad(fsx: SpoolFs, dir: string, options: WriteBadOptions): boolean {
  const { stem, cause, text, log, what } = options;
  const tmp = path.join(dir, `${stem}.${cause}.bad.${randomBytes(4).toString('hex')}.tmp`);
  const written = settle(
    () => fsx.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' }),
    log,
    what,
  );
  const moved =
    written === 'done'
      ? settle(() => fsx.renameSync(tmp, path.join(dir, `${stem}.${cause}.bad`)), log, what)
      : written;
  if (moved !== 'done' && written === 'done') settle(() => fsx.unlinkSync(tmp), log, what);
  return moved === 'done';
}

interface MoveBadOptions {
  readonly stem: string;
  readonly attempt: number;
  readonly cause: BadCause;
  readonly log: Log;
  readonly raw?: string;
}

/**
 * Sets a claim aside as `.bad` before the claim goes, so a crash between leaves a whole copy; a
 * busy write puts the claim back.
 */
export function moveBad(
  fsx: SpoolFs,
  dir: string,
  claim: string,
  options: MoveBadOptions,
): boolean {
  const { stem, attempt, cause, log, raw } = options;
  const what = `spool file ${path.basename(claim)} not set aside`;
  const read =
    raw === undefined ? settleCode(() => fsx.readFileSync(claim, 'utf8'), log, what) : done(raw);
  if (read.settled !== 'done') return false;
  if (!writeBad(fsx, dir, { stem, cause, text: read.value, log, what })) {
    putBack({ fsx, dir, claim, stem, attempt, log });
    return false;
  }
  settle(() => fsx.unlinkSync(claim), log, what);
  return true;
}

/** Removes a claim once the store holds its summary; a claim left behind is imported again, so
 * the log says so. */
export function removeClaim(fsx: SpoolFs, claim: string, name: string, log: Log): void {
  const removed = settleCode(
    () => fsx.unlinkSync(claim),
    log,
    `spool file ${name} claim not removed`,
  );
  if (removed.settled === 'busy') {
    log(
      `spool file ${name} saved; its claim could not be removed (${removed.code}); it will be imported again`,
    );
  }
}
