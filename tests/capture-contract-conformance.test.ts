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
} from '../src/core/capture-contract.js';
import { normalizeHookPayload } from '../src/cli/stdin.js';

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
  // Normalized first, as the hook command does, so the fixture holds what the host sends.
  ['copilot/session-end', (f) => readSessionEnd(normalizeHookPayload(f.stdin ?? undefined), f.timedOut, 'copilot')],
]);

// Pinned so a deleted fixture fails here instead of quietly shrinking what each reader is checked against.
const FIXTURE_COUNTS = new Map<string, number>([
  ['claude-code/pre-compact', 17],
  ['vscode/stop', 10],
  ['claude-code/post-compact', 14],
  ['claude-code/session-end', 16],
  ['copilot/session-end', 3],
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
    it(`${dir} has fixtures`, () => expect(files.length).toBe(FIXTURE_COUNTS.get(dir)));
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
