/** npm 11 refuses to publish below `latest` without --tag, so a backport
 *  needs the right maint-<major>.<minor> tag. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { distTagFor, fetchLatest } from '../scripts/publish-dist-tag.mjs';

describe('distTagFor', () => {
  it('publishes a version newer than latest as latest', () => {
    expect(distTagFor('1.48.0', '1.47.0')).toBe('latest');
  });

  it('routes a patch on an older minor to its maint tag', () => {
    expect(distTagFor('1.47.1', '1.48.0')).toBe('maint-1.47');
  });

  it('routes a same-version republish to its maint tag (npm refuses the republish anyway)', () => {
    expect(distTagFor('1.48.0', '1.48.0')).toBe('maint-1.48');
  });

  it('sends a prerelease to next regardless of latest', () => {
    expect(distTagFor('2.0.0-rc.1', '1.48.0')).toBe('next');
  });

  it('compares major.minor.patch numerically, not as strings', () => {
    expect(distTagFor('1.10.0', '1.9.9')).toBe('latest');
  });

  it('publishes a release over its own prerelease left on latest', () => {
    expect(distTagFor('2.0.0', '2.0.0-rc.1')).toBe('latest');
  });

  it('keeps an older line on its maint tag when latest is a newer prerelease', () => {
    expect(distTagFor('1.9.0', '2.0.0-rc.1')).toBe('maint-1.9');
  });

  it('throws on a version that is not x.y.z[-pre]', () => {
    expect(() => distTagFor('not-a-version', '1.0.0')).toThrow();
  });
});

describe('fetchLatest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails closed on a 404, so a backport never goes out as latest', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404, statusText: 'Not Found' }));
    await expect(fetchLatest()).rejects.toThrow(/404/);
  });

  it('fails closed when the registry has no latest tag', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ next: '2.0.0-rc.1' }));
    await expect(fetchLatest()).rejects.toThrow(/no latest/);
  });

  it('returns the latest tag', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ latest: '1.52.2' }));
    await expect(fetchLatest()).resolves.toBe('1.52.2');
  });
});
