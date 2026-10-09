// On macOS and Linux this cannot fail; on Windows the code before the lock fails it at 100 files, a lock revert alone only by chance,
// so the probe in docs/incidents.md is the measured red. 100 files, not more, so two busy children do not starve the suite.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spool } from '../src/capture/compaction-spool.js';

const DIST = path.resolve(__dirname, '..', 'dist', 'capture/compaction-spool.js');
const FILES = 100;

const CHILD = `
import { appendFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [, , dist, root, out] = process.argv;
const { importSpool } = await import(pathToFileURL(dist).href);
const dir = join(root, 'compactions-spool');
const lines = [];
const log = (message) => lines.push(message);
const pending = () => readdirSync(dir).some((n) => n.endsWith('.json') || n.includes('.claim'));
const until = Date.now() + 20000;
while (pending() && Date.now() < until) {
  const before = lines.length;
  importSpool(root, 'default', log, Date.now() + 20, (spooled, recorded) => {
    appendFileSync(out, spooled.payload.sessionId + '\\n');
    recorded();
  });
  if (lines.length > before) await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 5));
}
writeFileSync(out + '.log', lines.join('\\n'));
`;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-spool-race-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function child(script: string, root: string, out: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [script, DIST, root, out], { stdio: 'ignore' });
    proc.on('error', reject);
    proc.on('close', resolve);
  });
}

const readLines = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

describe('two processes replay one spool', () => {
  it('imports every file exactly once and leaves no lock', async () => {
    const root = path.join(dir, 'store');
    const ids = Array.from({ length: FILES }, (_, i) => `s${String(i).padStart(4, '0')}`);
    for (const id of ids) {
      spool(root, 'default', { sessionId: id, trigger: 'auto', cwd: null, transcriptPath: null, compactSummary: null }, { summary: id, items: [] }, new Date());
    }
    const script = path.join(dir, 'child.mjs');
    fs.writeFileSync(script, CHILD);
    const outs = [path.join(dir, 'a.txt'), path.join(dir, 'b.txt')];
    expect(await Promise.all(outs.map((out) => child(script, root, out)))).toEqual([0, 0]);

    const imported = outs.flatMap(readLines);
    expect(imported.length).toBe(FILES);
    expect([...imported].sort()).toEqual(ids);
    expect(fs.readdirSync(path.join(root, 'compactions-spool'))).toEqual([]);
    const unexpected = outs.flatMap((out) => readLines(`${out}.log`)).filter((l) => !l.startsWith('spool left to another replayer'));
    expect(unexpected).toEqual([]);
  }, 60_000);
});
