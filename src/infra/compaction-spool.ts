import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PostCompactPayload } from '../base/session/capture-contract.js';
import type { CompactionText } from '../base/ports/store/capture.js';
import { errorFields, errorMessage } from '../base/util/log.js';
import { takeFileLock } from '../host/file-lock.js';
import { PRIVATE_DIR } from '../host/private-dir.js';
import {
  type Log,
  SPOOL_DIR,
  type SpoolFs,
  retryBusy,
  stamp,
  waitingFiles,
} from './spool-files.js';
import { importFile } from './spool-import.js';
import { type SpoolImporter, spoolBody } from './spool-record.js';
import { promoteTmp, recoverStaleClaims } from './spool-recovery.js';

const LOCK = 'replay.lock.db';

function spoolFile(hippoRoot: string): string {
  return path.join(
    hippoRoot,
    SPOOL_DIR,
    `${stamp(Date.now())}-${randomBytes(4).toString('hex')}.a0.json`,
  );
}

export interface SpoolOptions {
  hippoRoot: string;
  tenantId: string;
  payload: PostCompactPayload;
  text: CompactionText;
  at: Date;
  fsx?: SpoolFs;
}

export function spool(options: SpoolOptions): void {
  const { hippoRoot, tenantId, payload, text, at, fsx = fs } = options;
  const file = spoolFile(hippoRoot);
  fsx.mkdirSync(path.dirname(file), PRIVATE_DIR);
  fsx.writeFileSync(`${file}.tmp`, spoolBody(tenantId, payload, text, at), {
    encoding: 'utf8',
    flag: 'wx',
  });
  retryBusy(() => fsx.renameSync(`${file}.tmp`, file));
}

export interface ImportSpoolOptions {
  hippoRoot: string;
  tenantId: string;
  log: Log;
  deadline: number;
  importOne: SpoolImporter;
  fsx?: SpoolFs;
}

/**
 * One replayer at a time holds `replay.lock.db`, so only one process claims a file even where
 * Windows lets two renames of it both land.
 */
export async function importSpool(options: ImportSpoolOptions): Promise<number> {
  const { hippoRoot, tenantId, log, deadline, importOne, fsx = fs } = options;
  const dir = path.join(hippoRoot, SPOOL_DIR);
  if (!fsx.existsSync(dir)) return 0;
  const take = takeFileLock(path.join(dir, LOCK));
  if (take.kind === 'held') {
    log('spool left to another replayer (lock held by another process)');
    return 0;
  }
  if (take.kind === 'unusable') {
    log(`spool lock not taken: ${errorMessage(take.cause)}`, errorFields(take.cause));
    return 0;
  }
  try {
    const names = fsx.readdirSync(dir);
    const promoted = promoteTmp(fsx, { dir, names, tenantId, log });
    const recovered = recoverStaleClaims(fsx, dir, names, log);
    let finished = 0;
    for (const entry of waitingFiles(promoted || recovered ? fsx.readdirSync(dir) : names)) {
      if (Date.now() > deadline) break;
      const outcome = await importFile({ fsx, dir, entry, tenantId, log, importOne });
      if (outcome === 'imported') finished++;
      if (outcome === 'stop') break;
    }
    return finished;
  } finally {
    take.lock.release();
  }
}
