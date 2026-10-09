// Sleep may reuse a person's text and hippo's own sound text; hippo's text with a certain defect never feeds a summary or the global store.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consolidate } from '../src/consolidate/sleep.js';
import { Layer } from '../src/core/memory.js';
import { autoShare, transferScore } from '../src/sharing/shared.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

const DEFECT = 'Found local migration files to be';

let scratch: string;
let root: string;
const saved = { home: process.env.HIPPO_HOME, key: process.env.ANTHROPIC_API_KEY };
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'hippo-defects-local-'));
  root = join(scratch, 'project', '.hippo');
  initStore(root);
  writeFileSync(join(root, 'config.json'), JSON.stringify({ replay: { count: 0 } }));
  process.env.HIPPO_HOME = join(scratch, 'global');
});
afterEach(() => {
  for (const [name, value] of [['HIPPO_HOME', saved.home], ['ANTHROPIC_API_KEY', saved.key]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe('automatic rows with a certain defect stay local', () => {
  it('auto-share passes over a captured defect but shares the same text a person wrote', () => {
    const captured = createMemory(DEFECT, { tags: ['error', 'captured'], source: 'capture', confidence: 'observed', layer: Layer.Episodic });
    const typed = createMemory(DEFECT, { tags: ['error'], layer: Layer.Episodic });
    for (const entry of [captured, typed]) writeEntry(root, entry);
    expect(transferScore(captured)).toBeGreaterThanOrEqual(0.6);
    expect(autoShare(root, { dryRun: true }).map((entry) => entry.id)).toEqual([typed.id]);
  });

  it('the DAG pass summarises sound extracted facts and leaves a defective one out', async () => {
    process.env.ANTHROPIC_API_KEY = 'test';
    const source = createMemory('Notes on the uploader and its storage token handling.', { layer: Layer.Episodic });
    writeEntry(root, source);
    const fact = (content: string) => ({
      ...createMemory(content, { layer: Layer.Semantic, tags: ['extracted', 'topic:upload'], source: 'capture', confidence: 'inferred', extracted_from: source.id }),
      dag_level: 1,
    });
    for (const content of [1, 2, 3].map((n) => `Upload fact ${n}: the storage token can expire mid-transfer.`).concat(DEFECT)) writeEntry(root, fact(content));
    const prompts: string[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      prompts.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ content: [{ text: 'Upload retries cover a storage token that expires mid-transfer.' }] }), { status: 200 });
    };
    await consolidate(root, { fetcher });
    expect(prompts.some((body) => body.includes('Upload fact 1'))).toBe(true);
    expect(prompts.filter((body) => body.includes(DEFECT))).toEqual([]);
  });
});
