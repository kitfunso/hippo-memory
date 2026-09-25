/** npm 11 refuses to publish below `latest` without --tag, so a backport
 *  needs the right maint-<major>.<minor> tag. */

import { describe, it, expect } from 'vitest';
import { distTagFor } from '../scripts/publish-dist-tag.mjs';

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

  it('is latest when the package has never published', () => {
    expect(distTagFor('1.0.0', null)).toBe('latest');
  });

  it('compares major.minor.patch numerically, not as strings', () => {
    expect(distTagFor('1.10.0', '1.9.9')).toBe('latest');
  });

  it('throws on a version that is not x.y.z[-pre]', () => {
    expect(() => distTagFor('not-a-version', '1.0.0')).toThrow();
  });
});
