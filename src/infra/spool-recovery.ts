// Putting spool files back in order: stale claims, torn tmp files and the `.bad` side folder.
import { MINUTE_MS } from '../base/util/time.js';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import {
  BAD,
  BAD_TMP,
  type Claim,
  type Log,
  MAX_ATTEMPTS,
  STALE_MS,
  type SpoolFs,
  TMP,
  claimOf,
  done,
  settle,
  settleCode,
} from './spool-files.js';
import { parseSpooled } from './spool-record.js';

type BadCause = 'unreadable' | 'failed' | 'interrupted';

/**
 * Claim time sits in the claim's name, so a claim over STALE_MS away from now belongs to a replayer
 * that never finished. True when one was put back.
 */
export function recoverStaleClaims(
  fsx: SpoolFs,
  dir: string,
  names: readonly string[],
  log: Log,
): boolean {
  const now = Date.now();
  // A claim whose unlink stayed busy after its `.bad` landed is a spare copy, not a second failure.
  const setAside = new Set(names.flatMap((name) => BAD.exec(name)?.[1] ?? []));
  let putBackOne = false;
  for (const claim of names.flatMap((name) => claimOf(name) ?? [])) {
    const file = path.join(dir, claim.name);
    const what = `spool file ${claim.name} not recovered`;
    const at =
      claim.claimedAt === null
        ? settleCode(() => fsx.statSync(file).mtimeMs, log, what)
        : done(claim.claimedAt);
    if (at.settled !== 'done' || Math.abs(now - at.value) <= STALE_MS) continue;
    if (setAside.has(claim.stem)) {
      settle(() => fsx.unlinkSync(file), log, what);
    } else if (putBackStale(fsx, dir, claim, log)) {
      putBackOne = true;
    }
  }
  return putBackOne;
}

/** Puts a stale claim back for another try, or sets it aside after its last; true when put back. */
function putBackStale(fsx: SpoolFs, dir: string, claim: Claim, log: Log): boolean {
  const file = path.join(dir, claim.name);
  const what = `spool file ${claim.name} not recovered`;
  const next = claim.attempt + 1;
  if (next < MAX_ATTEMPTS) {
    const moved = settle(
      () => fsx.renameSync(file, path.join(dir, `${claim.stem}.a${next}.json`)),
      log,
      what,
    );
    if (moved !== 'done') return false;
    log(
      `spool file ${claim.name} was claimed by a replayer that never finished, put back (try ${next} of ` +
        `${MAX_ATTEMPTS})`,
    );
    return true;
  }
  if (
    moveBad(fsx, dir, file, { stem: claim.stem, attempt: claim.attempt, cause: 'interrupted', log })
  ) {
    log(
      `spool file ${claim.name} was claimed by a replayer that never finished ${MAX_ATTEMPTS} times, set aside as ` +
        `.bad`,
    );
  }
  return false;
}

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
function writeBad(fsx: SpoolFs, dir: string, options: WriteBadOptions): boolean {
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

interface PromoteTmpOptions {
  readonly dir: string;
  readonly names: readonly string[];
  readonly tenantId: string;
  readonly log: Log;
}

/**
 * A tmp over STALE_MS old belongs to a spool that never renamed it: a whole one joins the waiting
 * files, a torn one is set aside. True when one joined.
 */
export function promoteTmp(
  fsx: SpoolFs,
  { dir, names, tenantId, log }: PromoteTmpOptions,
): boolean {
  const now = Date.now();
  let promoted = false;
  for (const name of names) {
    const m = TMP.exec(name);
    if (m === null && !BAD_TMP.test(name)) continue;
    const file = path.join(dir, name);
    const what = `spool file ${name} not promoted`;
    const stat = settleCode(() => fsx.statSync(file).mtimeMs, log, what);
    if (stat.settled !== 'done' || Math.abs(now - stat.value) <= STALE_MS) continue;
    if (m === null) {
      // A `.bad` write cut off before its rename: its source goes only after that rename lands, so
      // this copy is spare.
      settle(() => fsx.unlinkSync(file), log, `spool file ${name} not removed`);
      continue;
    }
    const read = settleCode(() => fsx.readFileSync(file, 'utf8'), log, what);
    if (read.settled !== 'done') continue;
    const text = read.value;
    if (parseSpooled(text, tenantId) !== null) {
      if (settle(() => fsx.renameSync(file, file.slice(0, -'.tmp'.length)), log, what) === 'done') {
        log(`spool file ${name} was never renamed into place, promoted`);
        promoted = true;
      }
    } else if (writeBad(fsx, dir, { stem: m[1], cause: 'unreadable', text, log, what })) {
      settle(() => fsx.unlinkSync(file), log, what);
      log(`spool file ${name} was never finished, set aside as .bad`);
    }
  }
  return promoted;
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
