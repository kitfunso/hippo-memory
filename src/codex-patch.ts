// Files named by a Codex apply_patch call, read the way openai/codex codex-rs/apply-patch reads them
// (parser.rs for the body, invocation.rs for the shell forms it runs as apply_patch).
import * as path from 'path';
import { isStringValue } from './capture.js';

/** Codex prints this line only when a patch applied (apply-patch lib.rs). */
export const PATCH_SUCCESS_LINE = 'Success. Updated the following files:';

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const MOVE_TO = '*** Move to: ';
const FILE_HEADER = /^\*\*\* (Add|Delete|Update) File: (.+)$/;

/** Paths a patch body adds, deletes, updates or moves to, in patch order; [] when the text holds no patch. */
export function patchPaths(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === BEGIN_PATCH);
  if (start < 0) return [];
  const paths: string[] = [];
  let updating = false;
  let canMove = false;
  for (const line of lines.slice(start + 1)) {
    // Inside an update hunk a leading space marks a context line, so headers match on trimEnd only there.
    const head = updating ? line.trimEnd() : line.trim();
    if (head === END_PATCH) break;
    const header = FILE_HEADER.exec(head);
    if (header) {
      paths.push(header[2].trim());
      updating = header[1] === 'Update';
      canMove = updating;
      continue;
    }
    if (canMove && head.startsWith(MOVE_TO)) paths.push(head.slice(MOVE_TO.length).trim());
    canMove = false;
  }
  return paths.filter(Boolean);
}

export interface ShellPatch {
  body: string;
  /** The `cd <dir> &&` target, relative to the call's working directory. */
  cd: string | null;
}

const HEREDOC =
  /^\s*(?:cd\s+(?<cd>'[^']*'|"[^"]*"|[^\s'"&|;]+)\s+&&\s+)?(?:apply_patch|applypatch)\s+<<\s*(?<q>['"]?)(?<tag>\w+)\k<q>[ \t]*\r?\n(?<body>[\s\S]*?)\r?\n\s*\k<tag>\s*$/;

/** The script a shell argv runs, for the shells Codex checks for an apply_patch heredoc. */
function shellScript(argv: readonly string[]): string | null {
  const exe = path.basename(argv[0] ?? '').toLowerCase().replace(/\.exe$/, '');
  if ((exe === 'bash' || exe === 'zsh' || exe === 'sh') && argv.length === 3 && (argv[1] === '-lc' || argv[1] === '-c')) return argv[2];
  if (exe === 'pwsh' || exe === 'powershell') {
    const rest = argv.slice(1).filter((a) => a.toLowerCase() !== '-noprofile');
    if (rest.length === 2 && rest[0].toLowerCase() === '-command') return rest[1];
  }
  if (exe === 'cmd' && argv.length === 3 && argv[1].toLowerCase() === '/c') return argv[2];
  return null;
}

/** The patch a shell call hands to apply_patch, or null for any other command. */
export function shellPatch(command: readonly string[] | string): ShellPatch | null {
  let script: string | null;
  if (isStringValue(command)) {
    script = command;
  } else {
    const exe = path.basename(command[0] ?? '').toLowerCase();
    if (command.length === 2 && (exe === 'apply_patch' || exe === 'applypatch')) return { body: command[1], cd: null };
    script = shellScript(command);
  }
  const match = script === null ? null : HEREDOC.exec(script);
  if (!match?.groups) return null;
  const cd = match.groups.cd ?? null;
  return { body: match.groups.body, cd: cd === null ? null : cd.replace(/^(['"])(.*)\1$/, '$2') };
}
