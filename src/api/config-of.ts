import { type HippoConfig, loadConfig } from '../core/config.js';
import type { Context } from './types.js';

/** The config a composition root set on the Context, else the store's own file; roots set it per command or request. */
export function configOf(ctx: Context): HippoConfig {
  return ctx.config ?? loadConfig(ctx.hippoRoot);
}

/** The caller's own config when `root` is its store, else that root's file (a ledger can sit on the global store). */
export function configAtRoot(own: Pick<Context, 'hippoRoot' | 'config'>, root: string): HippoConfig {
  return root === own.hippoRoot && own.config ? own.config : loadConfig(root);
}
