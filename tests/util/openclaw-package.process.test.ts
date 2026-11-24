import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACKAGE_VERSION } from '../../src/base/util/version.js';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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

  it('keeps nested extensions/openclaw-plugin manifests aligned with root version', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const nestedPkg = JSON.parse(readFileSync(join(repoRoot, 'extensions/openclaw-plugin/package.json'), 'utf8'));
    const nestedPlugin = JSON.parse(
      readFileSync(join(repoRoot, 'extensions/openclaw-plugin/openclaw.plugin.json'), 'utf8'),
    );

    expect(nestedPkg.version).toBe(pkg.version);
    expect(nestedPlugin.version).toBe(pkg.version);
  });

  it('keeps PACKAGE_VERSION aligned with the package version', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it('ships a compiled dist twin for every TypeScript openclaw extension entry', () => {
    execFileSync(process.execPath, [join(repoRoot, 'scripts', 'checks', 'check-openclaw-dist.mjs')], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  });
});
