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
});
