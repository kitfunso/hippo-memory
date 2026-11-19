// The PostToolUse hook for Claude Code's memory notes: a write of one starts the import in a
// detached worker; any other write ends here, before a store opens.
import { isClaudeMemoryNote } from '../../../api/agent-memories.js';
import { isJsonObjectLiteral, isJsonString, tryParseJson } from '../../../base/util/json.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { processHomes } from '../../../host/agent-homes.js';
import { currentMachine } from '../../../infra/machine.js';
import { defaultNoteWrittenLogPath } from '../../hooks-install/rules/shared.js';
import { readHookStdin } from '../stdin.js';
import { type CommandContext, stringFlag } from '../flag-values.js';
import { startNoteImport } from './note-import-worker.js';

/** What a Write or Edit payload names: the file written and the session it came from. */
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
