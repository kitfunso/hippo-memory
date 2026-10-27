// An imported row's source, `agent-memory:<tool>:<container>/<item>#<hash>`, and the stored text.
import type { Machine } from '../../base/util/agent-homes.js';
import { truncateCodePointSafe } from '../../base/util/code-point-cut.js';
import { maskEmails, redactSecretsStrict, storedSource } from '../../base/util/secret-detect.js';
import { itemHash, sha256Hex } from './keys.js';
import { toolSourcePrefix, type Scope, type ToolId } from '../../base/memory/agent-memory-tools.js';
import { ID_SUFFIX_CHARS } from '../../base/util/token-text.js';

export const CONTENT_CAP = 1500;
export const MIN_ITEM_CHARS = 10;

/** What a container's id reads of the machine: its platform folds case, its disk follows links. */
export type ContainerMachine = Pick<Machine, 'platform' | 'files'>;

/**
 * `p-`/`u-` and 12 hex of the real path, so no user path reaches a row; `origin` parts projects
 * sharing a folder in the global store.
 */
export function containerId(
  dir: string,
  scope: Scope,
  { platform, files }: ContainerMachine,
  origin = '',
): string {
  const real = files.realPath(dir).replace(/\\/g, '/');
  const folder = platform === 'win32' ? real.toLowerCase() : real;
  const prefix = scope === 'project' ? 'p' : 'u';
  const hash = sha256Hex(origin === '' ? folder : `${folder}\n${origin}`);
  return `${prefix}-${hash.slice(0, ID_SUFFIX_CHARS)}`;
}

export function containerPrefix(tool: ToolId, container: string): string {
  return `${toolSourcePrefix(tool)}${container}/`;
}

/** A note's key as a row's source holds it: the key part of its stored source. */
export function storedItemKey(key: string): string {
  return storedSource(`${key}#`).slice(0, -1);
}

export function itemSource(
  prefix: string,
  { key, text }: { readonly key: string; readonly text: string },
): string {
  return storedSource(`${prefix}${key}#${itemHash(text)}`);
}

/** The stored key and hash of a source under `prefix`; the hash follows the last `#`, since a file
 * name may hold one too. A raw older source is read in its stored form, so it matches its note. */
export function splitSource(
  source: string,
  prefix: string,
): { readonly key: string; readonly hash: string } {
  const rest = storedSource(source).slice(prefix.length);
  const cut = rest.lastIndexOf('#');
  return cut < 0 ? { key: rest, hash: '' } : { key: rest.slice(0, cut), hash: rest.slice(cut + 1) };
}

function capped(text: string): string {
  return text.length > CONTENT_CAP
    ? `${truncateCodePointSafe(text, CONTENT_CAP)} [truncated]`
    : text;
}

/**
 * The text as stored: emails masked as on every capture path, secrets redacted before the old
 * Claude import's cap so a token across it is never kept half raw; the hash still sees the raw note.
 */
export function storedText(text: string): string {
  return capped(redactSecretsStrict(maskEmails(text)));
}

/** The text as the old Claude import stored it, capped before any redaction, so legacy matching
 * keys the rows it wrote. */
export function legacyStoredText(text: string): string {
  return capped(maskEmails(text));
}
