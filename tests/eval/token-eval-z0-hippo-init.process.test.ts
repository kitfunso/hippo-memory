import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hippoInit } from '../../scripts/token-eval/runs.mjs';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-z0-init-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Z0 hippoInit', () => {
  it('leaves the Copilot home and VS Code folder that the operator env names untouched', () => {
    const copilotHome = path.join(root, 'operator-copilot');
    const vscodeData = path.join(root, 'operator-vscode');
    const vscodeUser = path.join(vscodeData, 'Code', 'User');
    const fakeHome = path.join(root, 'fake-home');
    const work = path.join(root, 'work');
    for (const dir of [copilotHome, vscodeUser, fakeHome, work]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(copilotHome, 'config.json'), '{}\n');
    fs.mkdirSync(path.join(fakeHome, '.copilot'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.copilot', 'config.json'), '{}\n');
    const env = {
      ...process.env,
      HIPPO_HOME: path.join(root, 'hippo-home'),
      COPILOT_HOME: copilotHome,
      VSCODE_APPDATA: vscodeData,
    };

    hippoInit({ env, dirs: { work } }, fakeHome);

    expect(fs.readdirSync(copilotHome)).toEqual(['config.json']);
    expect(fs.readdirSync(vscodeUser)).toEqual([]);
  });
});
