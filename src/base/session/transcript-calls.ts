// The model calls of a Claude Code transcript, as the re-read count and the session digest see them;
// src/infra/transcript-calls.ts reads the file.

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

/** Reads a transcript's main-thread model calls; rejects when the file cannot be read. */
export type ReadApiCalls = (transcriptPath: string) => Promise<TranscriptCalls>;
