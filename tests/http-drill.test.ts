/**
 * HTTP `GET /v1/recall/drill/:id` — surface check for v1.5.0 drillDown.
 *
 * Verifies: 200 with summary + children for a real summary, 404 for an
 * unknown id, 404 for a leaf id, 400 on bad query params.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-drill-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot();
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  safeRmSync(home);
});

describe('GET /v1/recall/drill/:id', () => {
  it('200 with summary + children for a real level-2 summary', async () => {
    const summary: MemoryEntry = createMemory('topic alpha rollup http', {
      layer: Layer.Semantic,
      tags: ['dag-summary'],
      confidence: 'inferred',
      dag_level: 2,
    });
    summary.descendant_count = 3;
    writeEntry(home, summary);
    for (let i = 0; i < 3; i++) {
      writeEntry(home, createMemory(`alpha detail event ${i}`, {
        layer: Layer.Episodic,
        confidence: 'observed',
        dag_level: 1,
        dag_parent_id: summary.id,
      }));
    }

    const res = await fetch(`${handle.url}/v1/recall/drill/${summary.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      summary: { id: string; descendantCount: number };
      children: Array<{ id: string; content: string }>;
      totalChildren: number;
      truncated: boolean;
    };
    expect(body.summary.id).toBe(summary.id);
    expect(body.summary.descendantCount).toBe(3);
    expect(body.children.length).toBe(3);
    expect(body.totalChildren).toBe(3);
    expect(body.truncated).toBe(false);
  });

  it('404 for an unknown id', async () => {
    const res = await fetch(`${handle.url}/v1/recall/drill/m_does_not_exist`);
    expect(res.status).toBe(404);
  });

  it('422 for a leaf id (v1.6.4: distinguishable from missing)', async () => {
    const leaf = createMemory('plain leaf body', {
      layer: Layer.Buffer,
      confidence: 'observed',
      dag_level: 0,
    });
    writeEntry(home, leaf);
    const res = await fetch(`${handle.url}/v1/recall/drill/${leaf.id}`);
    expect(res.status).toBe(422);
  });

  it('400 on bad limit', async () => {
    const summary: MemoryEntry = createMemory('any summary', {
      layer: Layer.Semantic, dag_level: 2, confidence: 'inferred',
    });
    writeEntry(home, summary);
    const res = await fetch(`${handle.url}/v1/recall/drill/${summary.id}?limit=0`);
    expect(res.status).toBe(400);
  });

  it('400 on bad budget', async () => {
    const summary: MemoryEntry = createMemory('any summary', {
      layer: Layer.Semantic, dag_level: 2, confidence: 'inferred',
    });
    writeEntry(home, summary);
    const res = await fetch(`${handle.url}/v1/recall/drill/${summary.id}?budget=-1`);
    expect(res.status).toBe(400);
  });

  it('budget truncates and sets truncated=true', async () => {
    const summary: MemoryEntry = createMemory('topic budget', {
      layer: Layer.Semantic, dag_level: 2, confidence: 'inferred',
    });
    writeEntry(home, summary);
    for (let i = 0; i < 8; i++) {
      writeEntry(home, createMemory(`detail row content ${i} `.repeat(15), {
        layer: Layer.Episodic, dag_level: 1, dag_parent_id: summary.id, confidence: 'observed',
      }));
    }
    const res = await fetch(`${handle.url}/v1/recall/drill/${summary.id}?budget=80`);
    expect(res.status).toBe(200);
    const body = await res.json() as { children: unknown[]; truncated: boolean };
    expect(body.truncated).toBe(true);
    expect(body.children.length).toBeLessThan(8);
  });
});
