/** Real-cost replay: synthetic session transcripts priced per arm, every expected cost derived by hand from the window rules. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simulate } from '../scripts/token-eval/real-cost.mjs';

const WRITE = 8e-6;
const READ = 0.2e-6;
const PIN_REFRESH = 10;

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const tok = (chars: number) => chars / 4;
const near = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 12);
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 15, 10, 0, 0) + minutes * 60e3).toISOString();

interface Flags { isSidechain?: boolean }
interface Line extends Flags {
  type: string;
  subtype?: string;
  timestamp?: string;
  message?: { id: string; model: string; content: Array<{ type: string; text: string }> };
  attachment?: { type: string; content: string[] };
}

const call = (id: string, minutes: number, flags: Flags = {}): Line => ({
  type: 'assistant', timestamp: at(minutes), message: { id, model: 'm', content: [{ type: 'text', text: 'x' }] }, ...flags,
});
const inject = (text: string, flags: Flags = {}): Line => ({
  type: 'attachment', attachment: { type: 'hook_additional_context', content: [text] }, ...flags,
});
const compact = (flags: Flags = {}): Line => ({ type: 'system', subtype: 'compact_boundary', ...flags });

function session(records: Line[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'real-cost-'));
  dirs.push(dir);
  const file = join(dir, 's.jsonl');
  writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}

const HEADER = '## Project Memory (Hippo)';
const ENTRY = '- **rule** keep it short';
const PINNED = `${HEADER}\n${ENTRY}`;
// Plan charges the header line on every injection, and the entry line again once PIN_REFRESH injections have passed.
const h = HEADER.length + 1;
const e = ENTRY.length + 1;

function pinnedSession(injections: number): string {
  return session(Array.from({ length: injections }, (_, i) => [inject(PINNED), call(`m${i}`, i)]).flat());
}

describe('real-cost replay', () => {
  it('charges a repeated pinned memory entry once under plan until PIN_REFRESH injections pass, every time under now', () => {
    const early = simulate(pinnedSession(PIN_REFRESH), 0, 0);
    expect(early.injections).toBe(PIN_REFRESH);
    expect(early.keptChars).toBe(PIN_REFRESH * h + e);
    expect(early.injChars).toBe(PIN_REFRESH * PINNED.length);

    const n = PIN_REFRESH + 1;
    const r = simulate(pinnedSession(n), 0, 0);
    expect(r.injections).toBe(n);
    expect(r.keptChars).toBe(n * h + 2 * e);
    expect(r.injChars).toBe(n * PINNED.length);
    // now: each call writes one copy and reads the k-1 before it, 0 + 1 + ... + 10 = 55 copies read.
    near(r.cost.now, WRITE * tok(n * PINNED.length) + READ * tok(55 * PINNED.length));
    // plan: the entry is live from call 1 and rewritten at call 11, so calls 2 to 11 read it once each.
    near(r.cost.plan, WRITE * tok(n * h + 2 * e) + READ * tok(55 * h + 10 * e));
  });

  it('reopens the window at a compact_boundary, so plan and builtin pay their write again', () => {
    const file = session([call('a', 0), call('b', 1), compact(), call('c', 2), call('d', 3)]);
    const r = simulate(file, 400, 1000);
    expect(r.compactions).toBe(1);
    near(r.cost.plan, 2 * (WRITE + READ) * tok(1000));
    near(r.cost.now, 2 * (WRITE + READ) * tok(1000));
    near(r.cost.builtin, 2 * (WRITE + READ) * tok(400));
    near(r.cost.unit, 2 * (WRITE + READ) * tok(1));
  });

  it('counts one expiry for a gap over 1 hour and rewrites what was live; exactly 1 hour is still a hit', () => {
    const file = session([call('a', 0), call('b', 10), call('c', 71), call('d', 131)]);
    const r = simulate(file, 0, 1000);
    expect(r.expiries).toBe(1);
    expect(r.compactions).toBe(0);
    // a writes, b reads, c (61 min after b) rewrites the live block, d (60 min after c) reads.
    near(r.cost.now, (2 * WRITE + 2 * READ) * tok(1000));
  });

  it('charges builtin its MEMORY.md once per window, whatever the injections do', () => {
    const note = '## Prompt-Relevant Memory\n- **tip** a note';
    const file = session([call('a', 0), inject(note), call('b', 1), call('c', 2)]);
    const r = simulate(file, 400, 1000);
    near(r.cost.builtin, (WRITE + 2 * READ) * tok(400));
    near(r.cost.now, WRITE * tok(1000) + READ * tok(1000) + WRITE * tok(note.length) + READ * tok(1000 + note.length));
  });

  it('ignores sidechain records and repeated assistant message ids', () => {
    const file = session([
      call('a', 0),
      call('a', 0),
      call('s1', 1, { isSidechain: true }),
      inject(PINNED, { isSidechain: true }),
      compact({ isSidechain: true }),
      call('b', 2),
    ]);
    const r = simulate(file, 400, 1000);
    expect(r.calls).toBe(2);
    expect(r.injections).toBe(0);
    expect(r.compactions).toBe(0);
    near(r.cost.now, (WRITE + READ) * tok(1000));
    near(r.cost.builtin, (WRITE + READ) * tok(400));
  });
});
