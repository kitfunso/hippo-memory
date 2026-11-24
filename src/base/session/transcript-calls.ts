/** One model API call in a host transcript, for `recordRereads`. */
export interface ApiCall {
  at: number;
  compactions: number;
}

interface ModelTagged {
  model?: unknown;
}

/**
 * Claude Code writes its own API errors and limit notices as assistant lines from this model; no
 * model call made them.
 */
export function isSyntheticMessage(message: ModelTagged): boolean {
  return message.model === '<synthetic>';
}

/** What `readApiCalls` found in a transcript. */
export interface TranscriptCalls {
  calls: ApiCall[];
  malformed: number;
}

/** Reads a transcript's main-thread model calls; rejects when the file cannot be read. */
export type ReadApiCalls = (transcriptPath: string) => Promise<TranscriptCalls>;
