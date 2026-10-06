// Summaries post-compact could not record because the store was busy, waiting on disk for the next replay.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isObjectLike, isStringValue } from './capture-contract.js';
import type { CompactionText, Log, PostCompactPayload } from './compaction-record.js';
import { errorMessage } from './log.js';

export const SPOOL_DIR = 'compactions-spool';
const CLAIMED_SUFFIX = '.claimed';
/** Long enough that a live replayer has finished with its claim. */
const STALE_MS = 10 * 60_000;

// A stem is `<ms13>-<rand8hex>`, so name order is age order; legacy files are `<session>-<ms>.json`.
const WAITING = /^([\w-]+)(?:\.a(\d+))?\.json$/;
const NEW_STEM = /^(\d{13})-[0-9a-f]{8}$/;
const LEGACY_STEM_TIME = /-(\d+)$/;

interface Waiting {
  name: string;
  stem: string;
  attempt: number;
  created: number;
}

const stamp = (ms: number): string => String(Math.trunc(ms)).padStart(13, '0');

/** When a stem was spooled: the time that leads a new stem, else the time that ends a legacy one, else 0. */
function created(stem: string): number {
  const m = NEW_STEM.exec(stem) ?? LEGACY_STEM_TIME.exec(stem);
  return m === null ? 0 : Number(m[1]);
}

/** Files waiting for import, oldest first across new and legacy names. */
function waitingFiles(dir: string): Waiting[] {
  const found = fsx.readdirSync(dir).flatMap((name) => {
    const m = WAITING.exec(name);
    return m === null ? [] : [{ name, stem: m[1], attempt: Number(m[2] ?? 0), created: created(m[1]) }];
  });
  return found.sort((a, b) => a.created - b.created || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export type SpoolFs = Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'readdirSync' | 'readFileSync' | 'renameSync' | 'rmSync' | 'statSync' | 'utimesSync' | 'writeFileSync'>;

let fsx: SpoolFs = fs;

/** Test-only seam, so a test can make one fs call fail; null restores the real fs. */
export function __setSpoolFs(next: SpoolFs | null): void {
  fsx = next ?? fs;
}

export interface SpooledCompaction {
  tenantId: string;
  payload: PostCompactPayload;
  text: CompactionText;
  at: Date;
}

/** Records one spooled compaction; it calls `recorded` once the store holds the summary, so the file is done even if a later step throws. */
export type SpoolImporter = (spooled: SpooledCompaction, recorded: () => void) => void;

// The session id stays in the body only, and the random part keeps two spools of one millisecond apart.
function spoolFile(hippoRoot: string): string {
  return path.join(hippoRoot, SPOOL_DIR, `${stamp(Date.now())}-${randomBytes(4).toString('hex')}.a0.json`);
}

export function spool(hippoRoot: string, tenantId: string, payload: PostCompactPayload, text: CompactionText, at: Date): void {
  const file = spoolFile(hippoRoot);
  fsx.mkdirSync(path.dirname(file), { recursive: true });
  const body = { tenantId, sessionId: payload.sessionId, trigger: payload.trigger, cwd: payload.cwd, transcriptPath: payload.transcriptPath, at: at.toISOString(), summary: text.summary, items: text.items };
  // Renamed into place so a replayer listing `.json` files never reads half a file.
  fsx.writeFileSync(`${file}.tmp`, JSON.stringify(body), 'utf8');
  fsx.renameSync(`${file}.tmp`, file);
}

/** null when the text is not a spooled compaction. */
export function parseSpooled(text: string, fallbackTenantId: string): SpooledCompaction | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null; // a half-written spool file holds no compaction; the caller treats null as unreadable
  }
  if (!isObjectLike(raw) || !('sessionId' in raw) || !isStringValue(raw.sessionId) || !('summary' in raw) || !isStringValue(raw.summary)) return null;
  if (!('at' in raw) || !isStringValue(raw.at) || Number.isNaN(Date.parse(raw.at))) return null;
  const items: string[] = 'items' in raw && Array.isArray(raw.items) ? raw.items.filter(isStringValue) : [];
  return {
    tenantId: 'tenantId' in raw && isStringValue(raw.tenantId) && raw.tenantId !== '' ? raw.tenantId : fallbackTenantId,
    payload: {
      sessionId: raw.sessionId,
      trigger: 'trigger' in raw && isStringValue(raw.trigger) ? raw.trigger : null,
      cwd: 'cwd' in raw && isStringValue(raw.cwd) ? raw.cwd : null,
      transcriptPath: 'transcriptPath' in raw && isStringValue(raw.transcriptPath) ? raw.transcriptPath : null,
      compactSummary: null,
    },
    text: { summary: raw.summary, items },
    at: new Date(raw.at),
  };
}

export function readSpooled(file: string, fallbackTenantId: string): SpooledCompaction | null {
  let text: string;
  try {
    text = fsx.readFileSync(file, 'utf8');
  } catch {
    return null; // a vanished spool file is skipped; the caller treats null as unreadable
  }
  return parseSpooled(text, fallbackTenantId);
}

export function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

/** A live replayer refreshes its claim's mtime when it takes it, so an old claim means the replayer died. */
export function recoverStaleClaims(dir: string, log: Log): void {
  const staleBefore = Date.now() - STALE_MS;
  for (const name of fsx.readdirSync(dir).filter((n) => n.endsWith(`.json${CLAIMED_SUFFIX}`))) {
    const claimed = path.join(dir, name);
    try {
      if (fsx.statSync(claimed).mtimeMs >= staleBefore) continue;
      fsx.renameSync(claimed, claimed.slice(0, -CLAIMED_SUFFIX.length));
      log(`spool file ${name} was claimed by a replayer that never finished, put back`);
    } catch (err) {
      if (!isMissingFile(err)) log(`spool file ${name} not recovered: ${errorMessage(err)}`);
    }
  }
}

export function releaseClaim(claimed: string, file: string, log: Log): void {
  try {
    fsx.renameSync(claimed, file);
  } catch (err) {
    log(`spool file ${path.basename(file)} could not be put back: ${errorMessage(err)}`);
  }
}

/** Each file is claimed by rename before it is read, so two replayers never import the same one. */
export function importSpool(hippoRoot: string, tenantId: string, log: Log, deadline: number, importOne: SpoolImporter): number {
  const dir = path.join(hippoRoot, SPOOL_DIR);
  if (!fsx.existsSync(dir)) return 0;
  recoverStaleClaims(dir, log);
  let finished = 0;
  for (const { name } of waitingFiles(dir)) {
    if (Date.now() > deadline) break;
    const file = path.join(dir, name);
    const claimed = `${file}${CLAIMED_SUFFIX}`;
    try {
      fsx.renameSync(file, claimed);
      const now = new Date();
      fsx.utimesSync(claimed, now, now);
    } catch (err) {
      if (!isMissingFile(err)) log(`spool file ${name} not claimed: ${errorMessage(err)}`);
      continue;
    }
    const spooled = readSpooled(claimed, tenantId);
    if (!spooled) {
      log(`spool file ${name} is not readable, set aside`);
      fsx.renameSync(claimed, `${file}.bad`);
      continue;
    }
    let removed = false;
    try {
      importOne(spooled, () => {
        fsx.rmSync(claimed, { force: true });
        removed = true;
      });
      finished++;
    } catch (err) {
      log(`spool file ${name} not imported: ${errorMessage(err)}`);
      if (!removed) releaseClaim(claimed, file, log);
    }
  }
  return finished;
}
