/** The shell the round 4 free commands share: flag parsing, the exit codes (0 pass, 1 bad input with its usage, 3 a listed stop) and the main guard. */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A stop the plan lists by name: exit 3, its message on stderr, and any stdout the command had already produced. */
export class Stop extends Error {
  constructor(message, stdout = '') {
    super(message);
    this.stdout = stdout;
  }
}

const camel = (flag) => flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());

/** `argv` read against a spec of flag names with their `--`: `values` take one value each, `lists` repeat, `switches` take none.
 * A flag outside the spec, a missing value, a repeated single flag or a missing `required` flag throws with `usage`.
 * @param {string[]} argv @param {{values?: string[], lists?: string[], switches?: string[], required?: string[]}} spec @param {string} usage */
export function parseFlags(argv, { values = [], lists = [], switches = [], required = [] }, usage) {
  const out = { ...Object.fromEntries(values.map((f) => [camel(f), null])), ...Object.fromEntries(lists.map((f) => [camel(f), []])), ...Object.fromEntries(switches.map((f) => [camel(f), false])) };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (switches.includes(flag)) {
      out[camel(flag)] = true;
      continue;
    }
    if (!values.includes(flag) && !lists.includes(flag)) throw new Error(`unknown flag ${flag}\n${usage}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value\n${usage}`);
    if (lists.includes(flag)) out[camel(flag)].push(value);
    else if (out[camel(flag)] !== null) throw new Error(`${flag} given twice\n${usage}`);
    else out[camel(flag)] = value;
  }
  const missing = required.find((f) => (lists.includes(f) ? out[camel(f)].length === 0 : out[camel(f)] === null));
  if (missing !== undefined) throw new Error(`${missing} is required\n${usage}`);
  return out;
}

/** Runs `body`, which returns its stdout text; a `Stop` becomes exit 3 and any other error exit 1. */
export function runCommand(body) {
  try {
    return { code: 0, stdout: body(), stderr: '' };
  } catch (e) {
    return { code: e instanceof Stop ? 3 : 1, stdout: e instanceof Stop ? e.stdout : '', stderr: `${e.message}\n` };
  }
}

/** The parsed JSON of `text`, or null when it does not parse; each caller names or skips the line on purpose, as a torn last line is expected in a live log. */
export function parseOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The parsed JSON of a file; a file that does not parse is bad input, named. */
export function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  const value = parseOrNull(text);
  if (value === null) throw new Error(`${file}: not JSON, or null`);
  return value;
}

/** The non-empty lines of `text`. */
export const linesOf = (text) => text.split('\n').filter((l) => l.trim() !== '');

/** Runs `runCli` on the process arguments when this file is the entry point. */
export function runMain(metaUrl, runCli) {
  if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(metaUrl)) {
    const { code, stdout, stderr } = runCli(process.argv.slice(2));
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    process.exitCode = code;
  }
}
