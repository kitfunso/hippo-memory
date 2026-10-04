import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('hippo-memory/server request guards', () => {
  it('still exports isCrossSite and LOOPBACK_HOST_HEADER from the published subpath', () => {
    const script = [
      "const { isCrossSite, LOOPBACK_HOST_HEADER } = await import('hippo-memory/server');",
      'const req = (headers) => ({ headers });',
      'console.log(JSON.stringify({',
      "  localHost: LOOPBACK_HOST_HEADER.test('127.0.0.1:3333'),",
      "  rebound: LOOPBACK_HOST_HEADER.test('evil.example:3333'),",
      "  crossSite: isCrossSite(req({ 'sec-fetch-site': 'cross-site' })),",
      "  sameOrigin: isCrossSite(req({ 'sec-fetch-site': 'same-origin', host: 'localhost:3333', origin: 'http://localhost:3333' })),",
      "  foreignOrigin: isCrossSite(req({ host: 'localhost:3333', origin: 'http://evil.example' })),",
      '  cli: isCrossSite(req({})),',
      '}));',
    ].join('\n');
    // cwd is the checkout because self-reference resolves from the nearest package.json.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    if (child.status !== 0) throw new Error(`self-reference import failed (run \`npm run build\` first):\n${child.stderr}`);
    const lines = child.stdout.trim().split('\n');
    // SAFETY: the child script above is the only writer of the last stdout line and always emits these keys.
    const out = JSON.parse(lines[lines.length - 1]!) as Record<string, boolean>;
    expect(out).toEqual({
      localHost: true,
      rebound: false,
      crossSite: true,
      sameOrigin: false,
      foreignOrigin: true,
      cli: false,
    });
  });
});
