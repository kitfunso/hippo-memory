import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
}

describe('Transformers.js backend safety', () => {
  it('auto-installs no backend: both Transformers.js packages are optional peers', () => {
    const manifest = readJson('package.json');
    // No optionalDependencies at all — npm installs those by default, which
    // is exactly what issue #133 was about. Backends are bring-your-own.
    expect(manifest.optionalDependencies).toBeUndefined();
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependenciesMeta?.['@huggingface/transformers']?.optional).toBe(true);
    expect(manifest.peerDependenciesMeta?.['@xenova/transformers']?.optional).toBe(true);
  });

  it('locks zero Transformers.js backends and zero native ONNX Runtimes', () => {
    const lock = readJson('package-lock.json');
    const installedPaths = Object.keys(lock.packages as Record<string, unknown>);

    expect(installedPaths).not.toContain('node_modules/@huggingface/transformers');
    expect(installedPaths).not.toContain('node_modules/@xenova/transformers');

    // Count-based, not path-based, so an npm hoist can never false-pass a
    // second runtime. A user may manually install one backend (that is the
    // supported opt-in); the SHIPPED graph must contain none, and the
    // resolve-before-import logic in src/embeddings.ts guarantees a single
    // native runtime per process even when both are installed manually.
    const nativeOrtPaths = installedPaths.filter((name) =>
      name.endsWith('/onnxruntime-node'),
    );
    expect(nativeOrtPaths).toHaveLength(0);
  });
});
