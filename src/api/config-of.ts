import { type HippoConfig, loadConfig } from '../core/config.js';
import type { Context } from './types.js';

/** The config a composition root set on the Context, else the store's own file; roots set it per command or request. */
export function configOf(ctx: Context): HippoConfig {
  return ctx.config ?? loadConfig(ctx.hippoRoot);
}
