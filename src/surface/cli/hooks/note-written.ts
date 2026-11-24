import { isClaudeMemoryNote } from '../../../api/agent-memories.js';
import { isJsonObjectLiteral, isJsonString, tryParseJson } from '../../../base/util/json.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { processHomes } from '../../../host/agent-homes.js';
import { currentMachine } from '../../../infra/machine.js';
import { defaultNoteWrittenLogPath } from '../../hooks-install/rules/shared.js';
import { readHookStdin } from '../stdin.js';
import { type CommandContext, stringFlag } from '../flag-values.js';
import { startNoteImport } from './note-import-worker.js';

interface WrittenFile {
  readonly file: string;
  readonly transcriptPath: string;
  readonly cwd: string | null;
}

function writtenFile(text: string | undefined): WrittenFile | null {
  const payload = tryParseJson((text ?? '').trim());
  if (!isJsonObjectLiteral(payload)) return null;
  const input = payload.tool_input;
  const file = isJsonObjectLiteral(input) ? input.file_path : undefined;
  const { transcript_path: transcriptPath, cwd } = payload;
  if (!isJsonString(file) || !isJsonString(transcriptPath)) return null;
  return { file, transcriptPath, cwd: isJsonString(cwd) ? cwd : null };
}

/** Every path exits 0, so a failure never blocks the session. */
export async function handleNoteWritten({ flags }: CommandContext): Promise<void> {
  try {
    const { text } = await readHookStdin();
    const written = writtenFile(text);
    if (written === null || !isClaudeMemoryNote(written.file, currentMachine())) return;
    startNoteImport({
      from: 'note-written',
      transcriptPath: written.transcriptPath,
      cwd: written.cwd,
      logFile: stringFlag(flags, 'log-file') ?? defaultNoteWrittenLogPath(processHomes()),
    });
  } catch (err) {
    log.warn(`note-written skipped: ${errorMessage(err)}`, errorFields(err));
  }
}
