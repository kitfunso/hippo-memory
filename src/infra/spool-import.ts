// Importing one waiting spool file: claim it, read it, hand it to the importer, settle the outcome.
import type { StepFailure } from '../base/ports/store/capture.js';
import { isStoreBusy } from '../base/ports/store.js';
import { errorFields, errorMessage } from '../base/util/log.js';
import { type Log, MAX_ATTEMPTS, type SpoolFs, type Waiting, settleCode } from './spool-files.js';
import { type SpoolImporter, parseSpooled } from './spool-record.js';
import { claimWaiting, moveBad, putBack, removeClaim } from './spool-claims.js';

type FileOutcome = 'imported' | 'skipped' | 'stop';

interface ImportFailedOptions {
  readonly dir: string;
  readonly claim: string;
  readonly entry: Waiting;
  readonly text: string;
  readonly recorded: boolean;
  readonly failure: StepFailure;
  readonly log: Log;
}

/**
 * After an importer failure: a busy store stops the run with the count unchanged, any other error
 * counts one try toward .bad.
 */
function importFailed(fsx: SpoolFs, options: ImportFailedOptions): FileOutcome {
  const { dir, claim, entry, text, recorded, failure, log } = options;
  const { name } = entry;
  const { busy, message, fields } = failure;
  if (recorded) {
    // The record stays `summarised`, so the stalled-record step of a later replay writes its items.
    log(
      busy
        ? `spool file ${name} saved; its memories wait for the next sleep (store busy)`
        : `spool file ${name} saved; writing its memories failed: ${message}`,
      fields,
    );
    return busy ? 'stop' : 'skipped';
  }
  if (busy) {
    putBack({ fsx, dir, claim, stem: entry.stem, attempt: entry.attempt, log });
    log(`spool file ${name} waits for the next run: the store is busy`);
    return 'stop';
  }
  const next = entry.attempt + 1;
  if (next < MAX_ATTEMPTS) {
    putBack({ fsx, dir, claim, stem: entry.stem, attempt: next, log });
    log(`spool file ${name} failed to import (try ${next} of ${MAX_ATTEMPTS}): ${message}`, fields);
  } else if (
    moveBad(fsx, dir, claim, {
      stem: entry.stem,
      attempt: entry.attempt,
      cause: 'failed',
      log,
      raw: text,
    })
  ) {
    log(`spool file ${name} set aside as .bad after ${MAX_ATTEMPTS} tries: ${message}`, fields);
  }
  return 'skipped';
}

interface ImportFileOptions {
  fsx: SpoolFs;
  dir: string;
  entry: Waiting;
  tenantId: string;
  log: Log;
  importOne: SpoolImporter;
}

/** Claims, reads and imports one waiting file; `stop` ends the run because the store is busy. */
export async function importFile(options: ImportFileOptions): Promise<FileOutcome> {
  const { fsx, dir, entry, tenantId, log, importOne } = options;
  const { name } = entry;
  const claim = claimWaiting(options.fsx, options.dir, options.entry, options.log);
  if (claim === null) return 'skipped';
  const text = readClaim(options, claim);
  if (text === null) return 'skipped';
  const spooled = parseSpooled(text, tenantId);
  if (spooled === null) {
    setAsideUnreadable(options, claim, text);
    return 'skipped';
  }
  let recorded = false;
  const markRecorded = (): void => {
    if (recorded) return;
    recorded = true;
    removeClaim(fsx, claim, name, log);
  };
  let failure: StepFailure | null;
  try {
    failure = await importOne(spooled, markRecorded);
  } catch (err) {
    failure = { busy: isStoreBusy(err), message: errorMessage(err), fields: errorFields(err) };
  }
  if (failure !== null) {
    return importFailed(fsx, { dir, claim, entry, text, recorded, failure, log });
  }
  markRecorded();
  return 'imported';
}

/** The claim's text; null when it vanished or stayed busy, and a busy one goes back. */
function readClaim({ fsx, dir, entry, log }: ImportFileOptions, claim: string): string | null {
  const { name } = entry;
  const read = settleCode(
    () => fsx.readFileSync(claim, 'utf8'),
    log,
    `spool file ${name} not read`,
  );
  if (read.settled === 'gone') log(`spool file ${name} vanished`);
  if (read.settled === 'busy') {
    putBack({ fsx, dir, claim, stem: entry.stem, attempt: entry.attempt, log });
  }
  return read.settled === 'done' ? read.value : null;
}

function setAsideUnreadable(
  { fsx, dir, entry, log }: ImportFileOptions,
  claim: string,
  text: string,
): void {
  const { stem, attempt } = entry;
  if (moveBad(fsx, dir, claim, { stem, attempt, cause: 'unreadable', log, raw: text })) {
    log(`spool file ${entry.name} is not readable, set aside as .bad`);
  }
}
