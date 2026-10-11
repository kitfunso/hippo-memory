import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hippoOut } from './_helpers/spawn-hippo.js';

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hippo-status-'));
  env = { ...process.env, HIPPO_HOME: join(home, '.hippo') };
});
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const run = (...args: string[]): string => hippoOut(args, { cwd: home, env });
const field = (out: string, label: string): string => {
  const line = out.split('\n').find((l) => l.trimStart().startsWith(`${label}:`));
  if (line === undefined) throw new Error(`no "${label}" line in:\n${out}`);
  return line.slice(line.indexOf(':') + 1).trim();
};

describe('hippo status', () => {
  it('reports every count of a seeded store', () => {
    run('init');
    run('remember', 'alpha deploys use blue green');
    run('remember', 'beta pinned rule', '--pin');
    run('trace', 'record', '--task', 't', '--steps', '[{"action":"a","observation":"o"}]', '--outcome', 'success');
    const out = run('status');
    expect({
      total: field(out, 'Total memories'),
      buffer: field(out, 'Buffer'),
      episodic: field(out, 'Episodic'),
      semantic: field(out, 'Semantic'),
      trace: field(out, 'Trace'),
      pinned: field(out, 'Pinned'),
      conflicts: field(out, 'Open conflicts'),
      remembered: field(out, 'Total remembered'),
      recalled: field(out, 'Total recalled'),
      forgotten: field(out, 'Total forgotten'),
      sleep: field(out, 'Last sleep'),
    }).toEqual({
      total: '3', buffer: '0', episodic: '2', semantic: '0', trace: '1', pinned: '1', conflicts: '0',
      remembered: '2', recalled: '0', forgotten: '0', sleep: 'never',
    });
  });

  it('reports an empty store as zeros', () => {
    run('init');
    const out = run('status');
    expect([field(out, 'Total memories'), field(out, 'Pinned'), field(out, 'Total remembered')]).toEqual(['0', '0', '0']);
  });
});
