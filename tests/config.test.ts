import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from '../src/config.js';

describe('config.pinnedInject', () => {
  it('defaults to enabled=true budget=1500', () => {
    // v0.29.1: raised from 500 to 1500 so mature installs (10+ pinned
    // memories) fit the full pinned set without silently truncating.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cfg-'));
    try {
      const cfg = loadConfig(tmp);
      expect(cfg.pinnedInject.enabled).toBe(true);
      expect(cfg.pinnedInject.budget).toBe(1500);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts partial override', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cfg-'));
    try {
      fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ pinnedInject: { budget: 200 } }));
      const cfg = loadConfig(tmp);
      expect(cfg.pinnedInject.enabled).toBe(true);  // default retained
      expect(cfg.pinnedInject.budget).toBe(200);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
