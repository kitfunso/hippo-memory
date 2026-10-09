// An imported row's source, `agent-memory:<tool>:<container>/<item>#<hash>`, and the stored text: plan design 3 and 4.
import { realpathOrResolve } from '../util/real-path.js';
import { truncateCodePointSafe } from '../transcript-tail.js';
import { maskEmails } from '../secret-detect.js';
import { itemHash, sha256Hex } from './keys.js';
import { toolSourcePrefix, type ToolId } from '../core/agent-memory-tools.js';
import type { Scope } from './types.js';
import { ID_SUFFIX_CHARS } from '../util/token-text.js';

export const CONTENT_CAP = 1500;
export const MIN_ITEM_CHARS = 10;

/** `p-`/`u-` and 12 hex of the real path, so no user path reaches a row; `origin` parts projects sharing a folder in the global store. */
export function containerId(dir: string, scope: Scope, platform: NodeJS.Platform, origin = ''): string {
  const real = realpathOrResolve(dir).replace(/\\/g, '/');
  const folder = platform === 'win32' ? real.toLowerCase() : real;
  return `${scope === 'project' ? 'p' : 'u'}-${sha256Hex(origin === '' ? folder : `${folder}\n${origin}`).slice(0, ID_SUFFIX_CHARS)}`;
}

export function containerPrefix(tool: ToolId, container: string): string {
  return `${toolSourcePrefix(tool)}${container}/`;
}

export function itemSource(prefix: string, key: string, text: string): string {
  return `${prefix}${key}#${itemHash(text)}`;
}

/** The key and hash of a source under `prefix`; the hash follows the last `#`, since a file name may hold one too. */
export function splitSource(source: string, prefix: string): { readonly key: string; readonly hash: string } {
  const rest = source.slice(prefix.length);
  const cut = rest.lastIndexOf('#');
  return cut < 0 ? { key: rest, hash: '' } : { key: rest.slice(0, cut), hash: rest.slice(cut + 1) };
}

/** The text as stored: emails masked as on every capture path, then the old Claude import's cap; the hash still sees the raw note. */
export function storedText(text: string): string {
  const masked = maskEmails(text);
  return masked.length > CONTENT_CAP ? `${truncateCodePointSafe(masked, CONTENT_CAP)} [truncated]` : masked;
}
