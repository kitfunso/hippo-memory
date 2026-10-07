import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../src/config.js';

let root: string;

function writeConfig(body: string): void {
  fs.writeFileSync(path.join(root, 'config.json'), body);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-delivery-cfg-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('deliveryLedger config', () => {
  it('defaults to off with no config file and with a config that omits it', () => {
    expect(loadConfig(root).deliveryLedger).toEqual({ enabled: false });
    writeConfig(JSON.stringify({ pinnedInject: { promptRecall: false } }));
    expect(loadConfig(root).deliveryLedger).toEqual({ enabled: false });
  });

  it('turns on only with a real boolean inside an object', () => {
    writeConfig(JSON.stringify({ deliveryLedger: { enabled: true } }));
    expect(loadConfig(root).deliveryLedger).toEqual({ enabled: true });
  });

  it.each([
    ['a bare boolean', { deliveryLedger: true }],
    ['a string flag', { deliveryLedger: { enabled: 'true' } }],
    ['an array', { deliveryLedger: [true] }],
  ])('warns and stays off for %s', (_label, body) => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeConfig(JSON.stringify(body));
    expect(loadConfig(root).deliveryLedger).toEqual({ enabled: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('deliveryLedger');
  });

  it('leaves pinnedInject defaults unchanged', () => {
    const before = loadConfig(root).pinnedInject;
    writeConfig(JSON.stringify({ deliveryLedger: { enabled: true } }));
    expect(loadConfig(root).pinnedInject).toEqual(before);
  });
});
