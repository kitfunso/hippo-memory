import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe('openclaw package metadata', () => {
  it('exposes root package metadata for direct npm plugin install', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

    expect(pkg.name).toBe('hippo-memory');
    expect(pkg.openclaw?.extensions).toContain('./extensions/openclaw-plugin/index.ts');
    expect(existsSync(join(repoRoot, 'openclaw.plugin.json'))).toBe(true);
  });

  it('keeps the root OpenClaw manifest aligned with the package version', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'openclaw.plugin.json'), 'utf8'));

    expect(manifest.id).toBe('hippo-memory');
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.configSchema?.properties?.root?.description).toContain('workspace');
  });

  // v0.32 / J3.2 — fixes drift the v1.13.0 ship missed. extensions/openclaw-
  // plugin/* nested manifests were stuck at 1.12.11 because the prior test
  // (above) only asserted ROOT parity. package.json::files includes the entire
  // extensions/openclaw-plugin/ dir, so nested files DO ship to npm; downstream
  // consumers reading the nested copy would see a stale version. This block
  // covers the two known nested manifests as of v1.13.x. If new nested
  // manifests are added under a different path, extend this test or convert
  // to a glob-based check across all *.plugin.json / **/package.json with
  // name='hippo-memory'.
  it('keeps nested extensions/openclaw-plugin manifests aligned with root version', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const nestedPkg = JSON.parse(readFileSync(join(repoRoot, 'extensions/openclaw-plugin/package.json'), 'utf8'));
    const nestedPlugin = JSON.parse(readFileSync(join(repoRoot, 'extensions/openclaw-plugin/openclaw.plugin.json'), 'utf8'));

    expect(nestedPkg.version).toBe(pkg.version);
    expect(nestedPlugin.version).toBe(pkg.version);
  });
});
