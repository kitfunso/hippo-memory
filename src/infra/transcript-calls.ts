import { open } from 'node:fs/promises';
import {
  isSyntheticMessage,
  type ApiCall,
  type TranscriptCalls,
} from '../base/session/transcript-calls.js';
import { isJsonString, isJsonObjectLiteral, tryParseJson } from '../base/util/json.js';

/** Main-thread model calls in a Claude Code transcript, in file order; rejects when the file
 * cannot be read. */
export async function readApiCalls(transcriptPath: string): Promise<TranscriptCalls> {
  const file = await open(transcriptPath);
  const calls: ApiCall[] = [];
  const seen = new Set<string>();
  let compactions = 0;
  let malformed = 0;
  try {
    for await (const line of file.readLines({ encoding: 'utf8' })) {
      if (!line.includes('"usage"') && !line.includes('"compact_boundary"')) continue;
      const entry = tryParseJson(line);
      if (entry === undefined) {
        malformed += 1;
        continue;
      }
      if (!isJsonObjectLiteral(entry) || entry.isSidechain === true) continue;
      if (entry.subtype === 'compact_boundary') {
        compactions += 1;
        continue;
      }
      // One call spans lines sharing a message id.
      const message = entry.message;
      if (entry.type !== 'assistant' || !isJsonObjectLiteral(message)) continue;
      if (
        !isJsonObjectLiteral(message.usage) ||
        isSyntheticMessage(message) ||
        !isJsonString(message.id)
      ) {
        continue;
      }
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
