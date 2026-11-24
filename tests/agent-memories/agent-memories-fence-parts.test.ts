import { describe, expect, it } from 'vitest';
import { CONTENT_CAP } from '../../src/domain/agent-memories/source.js';
import { container, partsOf } from '../_helpers/agent-memories-parts.js';

const rows = Array.from({ length: 64 }, (_, i) => `row ${String(i).padStart(2, '0')}: ${'x'.repeat(40)}`);

describe('a fenced block whose fence uses up the part budget', () => {
  it('splits as plain lines: every part within the cap, few parts, the whole body kept', () => {
    const text = `\`\`\`${'a'.repeat(1490)}\n${rows.join('\n')}\n\`\`\``;
    expect(rows.join('\n').length).toBeGreaterThan(3000);
    const parts = partsOf(container([{ key: 'big.md', text, updatedAt: 0 }], false));

    for (const part of parts) expect(part.text.length).toBeLessThanOrEqual(CONTENT_CAP);
    expect(parts.length).toBeLessThanOrEqual(6);
    const joined = parts.map((p) => p.text).join('\n');
    for (const row of rows) expect(joined).toContain(row);
  });

  it('a fence that leaves room is still closed and reopened on each part', () => {
    const text = `\`\`\`ts\n${rows.join('\n')}\n\`\`\``;
    const parts = partsOf(container([{ key: 'big.md', text, updatedAt: 0 }], false));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.text).toContain('```ts\n');
      expect(part.text.endsWith('\n```')).toBe(true);
    }
  });
});
