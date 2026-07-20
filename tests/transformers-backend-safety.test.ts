import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
}

describe('Transformers.js backend safety', () => {
  it('ships one optional backend, with Xenova left as a manual legacy fallback', () => {
    const manifest = readJson('package.json');
    expect(manifest.optionalDependencies).toHaveProperty('@huggingface/transformers');
    expect(manifest.optionalDependencies).not.toHaveProperty('@xenova/transformers');
  });

  it('locks one native ONNX Runtime implementation', () => {
    const lock = readJson('package-lock.json');
    const installedPaths = Object.keys(lock.packages as Record<string, unknown>);

    expect(installedPaths).toContain('node_modules/@huggingface/transformers');
    expect(installedPaths).not.toContain('node_modules/@xenova/transformers');

    const nativeOrtPaths = installedPaths.filter((name) =>
      name.endsWith('/onnxruntime-node'),
    );
    expect(nativeOrtPaths).toEqual([
      'node_modules/@huggingface/transformers/node_modules/onnxruntime-node',
    ]);
  });
});
