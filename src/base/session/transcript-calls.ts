// The model calls of a Claude Code transcript, read for the re-read count and the session digest.
import { open } from 'node:fs/promises';
import { isJsonString, isJsonObjectLiteral, tryParseJson } from '../util/json.js';

/** One model API call in a host transcript, for `recordRereads`. */
export interface ApiCall {
  /** Epoch milliseconds of the call's first transcript line. */
  at: number;
  /** Compactions before the call, in file order. */
  compactions: number;
}

interface ModelTagged {
  model?: unknown;
}

/**
 * Claude Code writes its own API errors and limit notices as assistant lines from this model; no model call made them.
 */
export function isSyntheticMessage(message: ModelTagged): boolean {
  return message.model === '<synthetic>';
}

/** What `readApiCalls` found in a transcript. */
export interface TranscriptCalls {
  calls: ApiCall[];
  /** Candidate lines that were not valid JSON, skipped. */
  malformed: number;
}

/** Main-thread model calls in a Claude Code transcript, in file order; rejects when the file cannot be read. */
export async function readApiCalls(transcriptPath: string): Promise<TranscriptCalls> {
  const file = await open(transcriptPath);
  const calls: ApiCall[] = [];
  const seen = new Set<string>();
  let compactions = 0;
  let malformed = 0;
  try {
    for await (const line of file.readLines({ encoding: 'utf8' })) {
      // Transcripts can pass 100 MB, so only lines that can be a call or a boundary are parsed.
      if (!line.includes('"usage"') && !line.includes('"compact_boundary"')) continue;
      const entry = tryParseJson(line);
      if (entry === undefined) {
        malformed += 1; // reported by the caller: one torn line must not void the session
        continue;
      }
      // Sidechain calls, sidechain compactions and `<synthetic>` messages never touch the main context.
      if (!isJsonObjectLiteral(entry) || entry.isSidechain === true) continue;
      if (entry.subtype === 'compact_boundary') {
        compactions += 1;
        continue;
      }
      // One call spans lines sharing a message id.
      const message = entry.message;
      if (entry.type !== 'assistant' || !isJsonObjectLiteral(message)) continue;
      if (!isJsonObjectLiteral(message.usage) || isSyntheticMessage(message) || !isJsonString(message.id)) continue;
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      const at = isJsonString(entry.timestamp) ? Date.parse(entry.timestamp) : Number.NaN;
      if (!Number.isNaN(at)) calls.push({ at, compactions });
    }
  } finally {
    await file.close();
  }
  return { calls, malformed };
}
