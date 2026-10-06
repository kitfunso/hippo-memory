import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostCompactPayload } from '../src/compaction-record.js';
import { __setSpoolFs, importSpool, spool, type SpoolImporter } from '../src/compaction-spool.js';

let root: string;
let logs: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-spool-'));
  logs = [];
});
afterEach(() => {
  __setSpoolFs(null);
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const log = (message: string): void => {
  logs.push(message);
};
const spoolDir = (): string => path.join(root, 'compactions-spool');
const payload = (sessionId: string): PostCompactPayload => ({ sessionId, trigger: 'auto', cwd: null, transcriptPath: null, compactSummary: null });

function put(name: string, sessionId: string): string {
  fs.mkdirSync(spoolDir(), { recursive: true });
  const file = path.join(spoolDir(), name);
  fs.writeFileSync(file, JSON.stringify({ tenantId: 'default', sessionId, trigger: 'auto', cwd: null, transcriptPath: null, at: new Date().toISOString(), summary: `summary of ${sessionId}`, items: [] }));
  return file;
}

/** An importer that notes each session id it is handed and finishes the file. */
function collector(): { seen: string[]; importer: SpoolImporter } {
  const seen: string[] = [];
  return { seen, importer: (spooled, recorded) => { seen.push(spooled.payload.sessionId); recorded(); } };
}

const replay = (importer: SpoolImporter): number => importSpool(root, 'default', log, Number.POSITIVE_INFINITY, importer);

describe('spool names and order', () => {
  it('imports oldest first across sessions and legacy names', () => {
    put('zz-1000.json', 'zz');
    put('0000000002000-aaaaaaaa.a0.json', 'b');
    put('aa-3000.json', 'aa');
    put('0000000000500-bbbbbbbb.a1.json', 'y');
    const { seen, importer } = collector();
    expect(replay(importer)).toBe(4);
    expect(seen).toEqual(['y', 'zz', 'b', 'aa']);
    expect(fs.readdirSync(spoolDir())).toEqual([]);
  });

  it('two spools for one session in one millisecond both land', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_760_000_000_000);
    spool(root, 'default', payload('s1'), { summary: 'first', items: [] }, new Date(1_760_000_000_000));
    spool(root, 'default', payload('s1'), { summary: 'second', items: [] }, new Date(1_760_000_000_000));
    vi.restoreAllMocks();
    expect(fs.readdirSync(spoolDir())).toHaveLength(2);
    const summaries: string[] = [];
    expect(replay((spooled, recorded) => { summaries.push(spooled.text.summary); recorded(); })).toBe(2);
    expect(summaries.sort()).toEqual(['first', 'second']);
  });
});
