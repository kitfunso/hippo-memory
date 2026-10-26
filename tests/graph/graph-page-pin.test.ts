import { createHash } from 'node:crypto';
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

const hashOf = (text: string): string =>
  `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

it('carries a policy that runs only its own script and style block, which the page fits, so it still renders', () => {
  const html = renderGraphHtml(MODEL);
  const policy =
    /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? '';
  const directives = new Map(
    policy.split('; ').map((d) => [d.split(' ')[0]!, d.split(' ').slice(1)]),
  );
  // A data block never runs, so only the scripts a browser executes need the policy's leave.
  const scripts = [...html.matchAll(/<script(\b[^>]*)>([\s\S]*?)<\/script>/g)].filter(
    (m) => !/type=/.test(m[1]!),
  );
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  expect([directives.get('default-src'), scripts.length, styles.length]).toEqual([
    ["'none'"],
    1,
    1,
  ]);
  expect(directives.get('script-src')).toEqual([hashOf(scripts[0]![2]!)]);
  expect(directives.get('style-src')).toEqual([hashOf(styles[0]![1]!)]);
  expect(html).not.toMatch(/\sstyle=|\son\w+=/);
  expect(policy).not.toMatch(/unsafe|\*|https?:/);
});
