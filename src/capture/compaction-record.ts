// What turns a compaction's summary into text the store keeps; the SQL is src/store/compactions-record.ts.
import * as fs from 'fs';
import { isStringValue } from '../core/capture-contract.js';
import { COMPACTION_ITEM_MAX_CHARS, compactSummaryBody, parseCompactionItems } from '../util/compaction-items.js';
import { importSpool, spool } from './compaction-spool.js';
import {
  replayStoredCompactions, saveCompactionAt, type CompactionSaveResult, type CompactionText, type Log, type ReplayOptions, type ReplaySources,
} from '../store/compactions-record.js';
import { resolveTenantId } from '../store/tenant.js';
import { maskEmails, redactSecretsStrict } from '../util/secret-detect.js';
import { errorMessage, reportCompactionFailure } from '../util/log.js';
import { readTranscriptTail, truncateCodePointSafe } from '../util/transcript-tail.js';

/** Tested verbatim: Claude Code hands PreCompact stdout to the summariser as instructions. */
export const PRE_COMPACT_INSTRUCTION =
  "In your summary, add a last section titled 'Memories for hippo'. List, one per line starting with '- ', each lesson learned, decision made (with its reason) and correction the user gave in this session that should outlive it. Write each as a standalone sentence that names its subject. Leave out anything an earlier summary already listed under 'Memories for hippo', and anything this session already saved with `hippo remember`. Write '- none' if nothing new remains.";

const SUMMARY_MAX_CHARS = 256 * 1024;
const TRANSCRIPT_TAIL_CAPS = [1 << 20, 8 << 20, 64 << 20];

function scrub(text: string): string {
  return maskEmails(redactSecretsStrict(text));
}

interface ScrubbedSummary {
  summary: string;
  items: string[];
  /** False when the summary has no memories section. */
  found: boolean;
}

/** What the record keeps of a compact_summary: the scrubbed body, and every parsed item scrubbed. */
export function readCompactionText(compactSummary: string): ScrubbedSummary {
  const body = compactSummaryBody(compactSummary);
  const parsed = parseCompactionItems(body);
  return { summary: truncateCodePointSafe(scrub(body), SUMMARY_MAX_CHARS), items: parsed.items.map(scrub), found: parsed.found };
}

/** A caller's items scrubbed as readCompactionText scrubs a summary's, since another machine's scrub is not trusted; cut after it, as a mask can run longer than what it hides. */
export function scrubCompactionItems(items: readonly string[]): string[] {
  return items.map((item) => truncateCodePointSafe(scrub(item), COMPACTION_ITEM_MAX_CHARS));
}

export interface PostCompactPayload {
  sessionId: string;
  trigger: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  /** null when Claude Code sent none; the transcript fills the record later. */
  compactSummary: string | null;
}

function spoolSummary(hippoRoot: string, payload: PostCompactPayload, text: CompactionText, at: Date, reason: string, result: CompactionSaveResult, log: Log): void {
  try {
    spool(hippoRoot, resolveTenantId({}), payload, text, at);
    result.deferred = true;
    log(`store busy, summary spooled: ${reason}`);
  } catch (spoolErr) {
    reportCompactionFailure(log, 'spool', errorMessage(spoolErr));
  }
}

/** The PostCompact work: record the summary, then write its items. Each step is independent; a busy store spools or defers. Never throws. */
export function saveCompaction(hippoRoot: string, payload: PostCompactPayload, log: Log): CompactionSaveResult {
  if (payload.compactSummary === null) {
    log('skip: payload has no compact_summary');
    return { written: null, deferred: false, snapshotSaved: false };
  }
  const at = new Date();
  const { found, ...text } = readCompactionText(payload.compactSummary);
  if (!found) log('no memories section');

  const { result, spoolReason } = saveCompactionAt(hippoRoot, payload, text, at, log);
  if (spoolReason !== null) spoolSummary(hippoRoot, payload, text, at, spoolReason, result, log);
  return result;
}

/** The one line PostCompact prints, or null when nothing was saved. */
export function postCompactLine(result: CompactionSaveResult): string | null {
  if (result.deferred) return 'Hippo will finish saving this compaction at the next sleep.';
  if (result.written === null) return null;
  if (result.written === 0) return "Hippo kept this compaction's summary; it listed no new memories.";
  const noun = result.written === 1 ? 'memory' : 'memories';
  return `Hippo saved ${result.written} ${noun} from this compaction${result.snapshotSaved ? ' and restored your task snapshot' : ''}.`;
}

interface TranscriptLine {
  isCompactSummary?: boolean;
  timestamp?: string;
  message?: { content?: string | Array<{ type?: string; text?: string }> };
}

function lineText(line: TranscriptLine): string {
  const content = line.message?.content;
  if (isStringValue(content)) return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (isStringValue(block.text) ? block.text : '')).join('\n');
}

/** The summary Claude Code wrote into a transcript between two moments; null when it is not (yet) there or the window cannot reach back that far. */
function transcriptSummary(transcriptPath: string, afterMs: number, beforeMs: number): string | null {
  const size = fs.statSync(transcriptPath).size;
  for (const cap of TRANSCRIPT_TAIL_CAPS) {
    const lines: TranscriptLine[] = [];
    for (const raw of readTranscriptTail(transcriptPath, cap).split('\n')) {
      try {
        lines.push(JSON.parse(raw));
      } catch {
        continue; // the tail can start mid-line; a torn line holds no summary
      }
    }
    const stamp = (line: TranscriptLine): number => (isStringValue(line.timestamp) ? Date.parse(line.timestamp) : Number.NaN);
    const first = lines.map(stamp).find((ms) => !Number.isNaN(ms));
    const hit = lines.find((line) => line.isCompactSummary === true && stamp(line) > afterMs && stamp(line) < beforeMs);
    if (hit) return lineText(hit);
    if (size <= cap || (first !== undefined && first <= afterMs)) return null;
  }
  return null;
}

function replaySources(hippoRoot: string, log: Log): ReplaySources {
  return {
    importSpool: (tenantId, deadline, record) => importSpool(hippoRoot, tenantId, log, deadline, record),
    transcriptExists: (transcriptPath) => fs.existsSync(transcriptPath),
    transcriptText: (transcriptPath, afterMs, beforeMs) => {
      const found = transcriptSummary(transcriptPath, afterMs, beforeMs);
      if (found === null) return null;
      const { found: listed, ...text } = readCompactionText(found);
      return { text, listed };
    },
  };
}

/** For `hippo sleep` and post-compact: finishes what a killed hook or a busy store left, never throws. */
export function replayCompactionsAt(hippoRoot: string, log: Log, opts: ReplayOptions = {}): number {
  return replayStoredCompactions(hippoRoot, replaySources(hippoRoot, log), log, opts);
}
