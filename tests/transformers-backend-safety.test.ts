import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

interface PackageJsonManifest {
  optionalDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

interface PackageLockEntry {
  version?: string;
  resolved?: string;
  dev?: boolean;
  optional?: boolean;
}

interface PackageLockManifest {
  packages: Record<string, PackageLockEntry>;
}

function readJson<T>(file: string): T {
  // SAFETY: both callers below read this repo's own committed package.json /
  // package-lock.json, whose shape matches the requested manifest type.
  return JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8')) as T;
}

describe('Transformers.js backend safety', () => {
  it('auto-installs no backend: both Transformers.js packages are optional peers', () => {
    const manifest = readJson<PackageJsonManifest>('package.json');
    // No optionalDependencies at all — npm installs those by default, which
    // is exactly what issue #133 was about. Backends are bring-your-own.
    expect(manifest.optionalDependencies).toBeUndefined();
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependenciesMeta?.['@huggingface/transformers']?.optional).toBe(true);
    expect(manifest.peerDependenciesMeta?.['@xenova/transformers']?.optional).toBe(true);
  });

  it('locks zero Transformers.js backends and zero native ONNX Runtimes', () => {
    const lock = readJson<PackageLockManifest>('package-lock.json');
    const installedPaths = Object.keys(lock.packages);

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
