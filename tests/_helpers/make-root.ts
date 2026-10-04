import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../../src/store.js';

export interface MakeRootOptions {
  /** Written to `<root>/config.json` (the store config, a sibling of `.hippo`). */
  config?: object;
}

/** Temp dir named `hippo-<label>-*` with an initialised `.hippo` store; the caller removes it. */
export function makeRoot(label: string, opts: MakeRootOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${label}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  if (opts.config) writeFileSync(join(root, 'config.json'), JSON.stringify(opts.config));
  return root;
}
