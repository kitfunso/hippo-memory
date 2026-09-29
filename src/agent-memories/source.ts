// An imported row's source, `agent-memory:<tool>:<container>/<item>#<hash>`, and the stored text: plan design 3 and 4.
import { realpathOrResolve } from '../project-identity.js';
import { truncateCodePointSafe } from '../capture.js';
import { itemHash, sha256Hex } from './keys.js';
import { toolSourcePrefix, type ToolId } from './tools.js';
import type { Scope } from './types.js';

export const CONTENT_CAP = 1500;
export const MIN_ITEM_CHARS = 10;

/** `p-`/`u-` and 12 hex of the real path, so no user path reaches a row and two config folders stay apart. */
export function containerId(dir: string, scope: Scope, platform: NodeJS.Platform): string {
  const real = realpathOrResolve(dir).replace(/\\/g, '/');
  return `${scope === 'project' ? 'p' : 'u'}-${sha256Hex(platform === 'win32' ? real.toLowerCase() : real).slice(0, 12)}`;
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

/** The text as stored: the cap is unchanged from the old Claude import, and the hash still sees past it. */
export function storedText(text: string): string {
  return text.length > CONTENT_CAP ? `${truncateCodePointSafe(text, CONTENT_CAP)} [truncated]` : text;
}
