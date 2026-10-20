import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { renderGraphHtml } from '../../src/surface/cli/graph-page.js';
import type { GraphModel } from '../../src/domain/graph/view.js';

const MODEL: GraphModel = {
  nodes: [
    { id: 1, type: 'decision', name: 'Use <b>SQLite</b> & friends' },
    {
      id: 2,
      type: 'policy',
      name: 'A very long policy name that is truncated',
    },
    { id: 3, type: 'customer', name: 'Acme' },
  ],
  edges: [
    { from: 1, to: 2, relType: 'owns' },
    { from: 2, to: 3, relType: 'references' },
  ],
  truncated: true,
};
const FIXTURE = new URL('./fixtures/graph-page.html.txt', import.meta.url);

it('renders the graph page byte-identical to the pinned fixture', () => {
  const html = renderGraphHtml(MODEL);
  if (process.env.PIN_WRITE === '1') writeFileSync(FIXTURE, html);
  expect(html).toBe(readFileSync(FIXTURE, 'utf8'));
});
