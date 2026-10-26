// A corrupt workspace registry is warned about and kept aside, so the next registration cannot silently erase its entries.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listRegisteredWorkspaces, registerWorkspace, workspaceRegistryPath } from '../../src/surface/cli/scheduler.js';

let globalRoot: string;
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-registry-'));
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  fs.rmSync(globalRoot, { recursive: true, force: true });
});

describe('corrupt workspace registry', () => {
  it('warns, moves the bad file aside and starts empty', () => {
    const registryFile = workspaceRegistryPath(globalRoot);
    const corrupt = '{"version":1,"workspaces":["/repo/a",';
    fs.writeFileSync(registryFile, corrupt, 'utf8');

    expect(listRegisteredWorkspaces(globalRoot)).toEqual([]);

    const asides = fs.readdirSync(globalRoot).filter((f) => f.startsWith('workspaces.json.corrupt-'));
    expect(asides).toHaveLength(1);
    expect(fs.readFileSync(path.join(globalRoot, asides[0]), 'utf8')).toBe(corrupt);
    expect(fs.existsSync(registryFile)).toBe(false);
    const warning = stderrSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('workspace registry'));
    expect(warning).toMatch(
      /^\[hippo\] warn: workspace registry .* is corrupt .*moved it to .*workspaces\.json\.corrupt-/,
    );

    registerWorkspace(globalRoot, path.join(globalRoot, 'repo-b'));
    expect(fs.readFileSync(path.join(globalRoot, asides[0]), 'utf8')).toBe(corrupt);
  });

  it('skips entries that are not paths with one warning and keeps the paths', () => {
    fs.writeFileSync(
      workspaceRegistryPath(globalRoot),
      JSON.stringify({ version: 1, workspaces: ['/repo/a', 7, null, {}] }),
    );

    expect(listRegisteredWorkspaces(globalRoot)).toEqual([path.resolve('/repo/a').replace(/\\/g, '/')]);

    const warnings = stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('are not paths'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('3 entries');
  });

  it('reads a registry that is not an object as empty', () => {
    fs.writeFileSync(workspaceRegistryPath(globalRoot), '["/repo/a"]');
    expect(listRegisteredWorkspaces(globalRoot)).toEqual([]);
  });
});
