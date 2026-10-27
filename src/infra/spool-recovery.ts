// Putting spool files back in order: stale claims, torn tmp files and the `.bad` side folder.
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
import { moveBad, putBack, writeBad } from './spool-claims.js';
import { parseSpooled } from './spool-record.js';

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
  const next = claim.attempt + 1;
  if (next < MAX_ATTEMPTS) {
    if (!putBack({ fsx, dir, claim: file, stem: claim.stem, attempt: next, log })) return false;
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
