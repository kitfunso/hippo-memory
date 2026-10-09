import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  readClaudeCodePostCompact,
  readClaudeCodePreCompact,
  readSessionEnd,
  readVscodeStop,
  type CaptureReceipt,
} from '../src/capture-contract.js';
import { normaliseHookPayload } from '../src/stdin.js';

interface Fixture {
  readonly stdin: string | null;
  readonly timedOut: boolean;
  readonly expect: CaptureReceipt;
}

// A fixture directory without a reader here fails the suite, so no fixture can sit unexercised.
const READERS = new Map<string, (fixture: Fixture) => CaptureReceipt>([
  ['claude-code/pre-compact', (f) => readClaudeCodePreCompact(f.stdin ?? undefined, f.timedOut)],
  ['vscode/stop', (f) => readVscodeStop(f.stdin ?? undefined, f.timedOut)],
  ['claude-code/post-compact', (f) => readClaudeCodePostCompact(f.stdin ?? undefined, f.timedOut)],
  ['claude-code/session-end', (f) => readSessionEnd(f.stdin ?? undefined, f.timedOut)],
  // Normalised first, as the hook command does, so the fixture holds what the host sends.
  ['copilot/session-end', (f) => readSessionEnd(normaliseHookPayload(f.stdin ?? undefined), f.timedOut, 'copilot')],
]);

const ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'capture');
const subdirs = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const fixtureDirs = subdirs(ROOT).flatMap((runtime) => subdirs(path.join(ROOT, runtime)).map((event) => `${runtime}/${event}`));

describe('capture contract conformance', () => {
  it('maps every fixture directory to a reader, and every reader to fixtures', () => {
    expect(fixtureDirs.filter((dir) => !READERS.has(dir))).toEqual([]);
    expect([...READERS.keys()].filter((key) => !fixtureDirs.includes(key))).toEqual([]);
  });

  for (const dir of fixtureDirs) {
    const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.json'));
    it(`${dir} has fixtures`, () => expect(files.length).toBeGreaterThan(0));
    for (const file of files) {
      it(`${dir}/${file}`, () => {
        // SAFETY: fixtures are checked-in files in this shape; a wrong shape fails the toEqual below.
        const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, dir, file), 'utf8')) as Fixture;
        const read = READERS.get(dir);
        expect(read).toBeDefined();
        expect(read!(fixture)).toEqual(fixture.expect);
      });
    }
  }
});
