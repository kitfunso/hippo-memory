import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import hippoAdapter from '../../benchmarks/sequential-learning/adapters/hippo.mjs';

let operator: string;

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(operator, { recursive: true, force: true });
});

describe('sequential-learning hippo adapter init', () => {
  // An operator's Copilot and VS Code folders in the shell must stay untouched by the adapter's fake-home init.
  it('writes nothing into the operator Copilot or VS Code folders', async () => {
    operator = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-sl-operator-'));
    const copilot = path.join(operator, 'copilot');
    const vscode = path.join(operator, 'vscode');
    fs.mkdirSync(copilot);
    fs.mkdirSync(path.join(vscode, 'Code', 'User'), { recursive: true });
    fs.writeFileSync(path.join(copilot, 'config.json'), '{}\n');
    vi.stubEnv('COPILOT_HOME', copilot);
    vi.stubEnv('VSCODE_APPDATA', vscode);
    vi.stubEnv('VSCODE_PORTABLE', '');

    await hippoAdapter.init();
    await hippoAdapter.cleanup();

    expect(fs.readdirSync(copilot)).toEqual(['config.json']);
    expect(fs.readdirSync(path.join(vscode, 'Code', 'User'))).toEqual([]);
  });
});
