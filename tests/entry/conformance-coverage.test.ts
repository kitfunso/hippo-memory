// The conformance kit calls every core store method at least once, so a second store that passes it has run the whole port.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORE_EFFECTS } from '../../src/base/ports/store/store-effects.js';

const KIT = join(import.meta.dirname, '..', '..', 'src', 'entry', 'conformance');

describe('the store conformance kit', () => {
  it('calls every core method on the store under test', () => {
    const kit = readdirSync(KIT)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(join(KIT, file), 'utf8'))
      .join('\n');
    const calls = Object.entries(STORE_EFFECTS).flatMap(([group, methods]) =>
      Object.keys(methods).map((m) => (group === 'base' ? `store.${m}(` : `store.${group}.${m}(`)),
    );
    expect(calls).toContain('store.keyWrites.changeApiKey(');
    expect(calls.filter((call) => !kit.includes(call))).toEqual([]);
  });
});
