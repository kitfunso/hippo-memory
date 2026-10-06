// Which MCP tools run on a shared store, and which need the caller's project first.
import { isSharedStore } from '../config.js';
import type { McpContext } from './protocol.js';

// A shared store holds many repos' rows, so a memory tool needs the caller's project and four tools never run.
const OFF_ON_SHARED: ReadonlyMap<string, string> = new Map([
  ['hippo_learn', "reads the server's git history"],
  ['hippo_share', "copies into the server's global store"],
  ['hippo_resolve', 'tombstones across every project; the admin resolves with the CLI'],
  ['hippo_peers', "lists the server's own global store, not the repos that share this one"],
]);
const OPEN_WITHOUT_PROJECT: ReadonlySet<string> = new Set(['hippo_predict_baserate']);

/** The refusal text for this call, or undefined when it may run; stdio passes no context and is never gated. */
export function sharedStoreRefusal(name: string, ctx: McpContext | undefined): string | undefined {
  if (ctx === undefined || !isSharedStore(ctx.hippoRoot)) return undefined;
  const off = OFF_ON_SHARED.get(name);
  if (off !== undefined) return `${name} is off on a shared store: it ${off}`;
  if (OPEN_WITHOUT_PROJECT.has(name) || ctx.project !== undefined) return undefined;
  return `${name} needs the caller's project on a shared store; the client sends it in the X-Hippo-Project header`;
}
