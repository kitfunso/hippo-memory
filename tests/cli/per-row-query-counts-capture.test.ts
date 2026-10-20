// Per-row query counts of the capture verbs: remember, trace, capture and the session digest.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { recordStatements, recordStatementsAsync, countMatching, STORE_OPEN } from '../_helpers/count-statements.js';
import { cliRequest } from '../../src/surface/cli/api-context.js';
import { handleRemember, handleTrace } from '../../src/surface/cli/remember.js';
import { cmdCapture } from '../../src/surface/capture/command.js';
import { recordSessionDigest } from '../../src/surface/capture/session-digest.js';
import { captureTarget, hookStore } from '../_helpers/cli-stores.js';
import { loadConfig } from '../../src/base/config/config.js';
import {
  ROW_READ,
  SIZES,
  TENANT_READ,
  ctxFor,
  freshRoot,
  memory,
  rows,
  seed,
  useQueryCountRoots,
} from '../_helpers/query-count-seeds.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

useQueryCountRoots();

describe('cmdRemember', () => {
  async function remember(root: string, text: string) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { statements } = await recordStatementsAsync(() =>
        handleRemember({ hippoRoot: root, tenantId: 'default', args: [text], flags: { tag: ['topic:cache'] } }),
      );
      return { statements, printed: log.mock.calls.map((call) => String(call[0])) };
    } finally {
      log.mockRestore();
    }
  }

  it('scores schema fit without reading a stored row, and reads back only the row it wrote', async () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-remember');
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { enabled: false } }));
      seed(ctxFor(root), rows(n, 'remember', { tags: ['topic:cache'] }));
      const { statements, printed } = await remember(root, 'a new note about the zephyrine cache');
      expect(printed[0]).toMatch(/^Remembered \[/);
      // The write goes through the api, which answers an id, so the printout reads that one row by id.
      expect(countMatching(statements, ROW_READ)).toBe(1);
      expect(countMatching(statements, /FROM memories WHERE id IN \(SELECT value FROM json_each\(\?\)\) AND /)).toBe(1);
    }
  });

  it('reads only the salience window when the gate runs, and judges as the whole list did', async () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-remember-salience');
      fs.writeFileSync(
        path.join(root, 'config.json'),
        JSON.stringify({ embeddings: { enabled: false }, salience: { enabled: true, recentWindow: 3 } }),
      );
      const stored = rows(n, 'salience').map((e, i) => ({
        ...e,
        created: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      }));
      seed(ctxFor(root), stored);

      const inWindow = await remember(root, stored[n - 1].content);
      expect(inWindow.printed[0]).toMatch(/^Skipped \(salience: duplicate/);
      expect(countMatching(inWindow.statements, ROW_READ)).toBe(1);
      expect(countMatching(inWindow.statements, /ORDER BY created DESC, id DESC LIMIT \?$/)).toBe(1);

      const beforeWindow = await remember(root, stored[n - 4].content);
      expect(beforeWindow.printed[0]).toMatch(/^Remembered \[/);
    }
  });
});

describe('trace lineage', () => {
  it('reads every parent in one query, however many there are', async () => {
    const reads: number[] = [];
    for (const parents of [1, 20]) {
      const root = freshRoot('qc-trace-lineage');
      vi.stubEnv('HIPPO_HOME', path.join(root, 'global'));
      const sources = rows(parents, 'parent');
      const child = memory('a child merged from the parents', { parents: sources.map((p) => p.id) });
      seed(ctxFor(root), [...sources, child]);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        const { statements } = await recordStatementsAsync(() =>
          cliRequest(() => handleTrace({ hippoRoot: root, tenantId: 'default', args: [child.id], flags: {} })),
        );
        expect(log.mock.calls.map((call) => String(call[0])).join(' ')).toContain('parent memory number 0');
        reads.push(countMatching(statements, ROW_READ));
      } finally {
        log.mockRestore();
      }
    }
    expect(reads[1]).toBe(reads[0]);
  });
});

describe('cmdCapture', () => {
  it('reads no full row for its copy check and keeps every write on one handle', () => {
    const counts = SIZES.flatMap((n) =>
      [1, 10].map((items) => {
        const root = freshRoot('qc-capture');
        fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { enabled: false } }));
        const held = 'Never deploy service 0 on Fridays because the on-call rota is thin';
        seed(ctxFor(root), [...rows(n, 'capture'), memory(held)]);
        const sessionTurns = Array.from({ length: items + 1 }, (_, i) => ({
          role: 'user' as const,
          text: `Never deploy service ${i} on Fridays because the on-call rota is thin.`,
        }));
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
          const { statements } = recordStatements(() =>
            cmdCapture(captureTarget(root), {
              source: 'last-session',
              sessionTurns,
              dryRun: false,
              global: false,
              tenantId: 'default',
            }),
          );
          expect(log.mock.calls.at(-1)?.[0]).toContain(`Captured ${items} items (1 skipped as duplicates)`);
          expect(countMatching(statements, ROW_READ)).toBe(0);
          return countMatching(statements, STORE_OPEN);
        } finally {
          log.mockRestore();
        }
      }),
    );
    expect(new Set(counts).size).toBe(1);
  });
});

describe('recordSessionDigest', () => {
  it('reads no full row to find the text hippo could have injected', async () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-digest');
      seed(ctxFor(root), rows(n, 'digest'));
      const scan = {
        turns: [{ role: 'user' as const, text: 'the upload keeps failing overnight' }],
        finalText: 'Retry `upload()` with backoff because the storage token expires mid-transfer.',
        cwd: path.dirname(root),
        edits: [],
      };
      const log: string[] = [];
      const { statements } = await recordStatementsAsync(() =>
        recordSessionDigest(root, hookStore(root), scan, {
          key: 's1',
          tenantId: 'default',
          config: loadConfig(root),
          log: (line) => log.push(line),
        }),
      );
      expect(log.join('\n')).toMatch(/^digest: wrote /);
      expect(countMatching(statements, TENANT_READ)).toBe(0);
    }
  });
});
