// Test-isolation guard ancestor coverage (episode 01M31DR9BAD95WQ5DJTX03Z1FC). Real filesystem in a
// mkdtemp sandbox; exercises watchedStoreDirs() directly, not the globalSetup leak check itself.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { snapshot, watchedStoreDirs } from './_real-store-guard.js';

function globalStoreRootLocal(): string {
  const hippoHome = process.env.HIPPO_HOME?.trim();
  if (hippoHome) return hippoHome;
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return path.join(xdg, 'hippo');
  return path.join(os.homedir(), '.hippo');
}

let sandboxRoot: string;
let offWalkHome: string;
let home: string;
let outer: string;
let checkout: string;
let fixture: string;

beforeAll(() => {
  sandboxRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-guard-ancestors-')));
  home = path.join(sandboxRoot, 'home');
  outer = path.join(home, 'outer');
  checkout = path.join(outer, 'checkout');
  fixture = path.join(checkout, 'fixture');
  fs.mkdirSync(path.join(outer, '.hippo'), { recursive: true });
  fs.mkdirSync(fixture, { recursive: true });
  offWalkHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-guard-offwalk-')));
});

afterAll(() => {
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
  fs.rmSync(offWalkHome, { recursive: true, force: true });
});

describe('watchedStoreDirs ancestor coverage', () => {
  it('arm 1: cwd rooted at the fixture leaf, two hops below the blind-spot store, still finds it (a checkout-rooted cwd would not)', () => {
    expect(watchedStoreDirs(fixture, home)).toContain(path.join(outer, '.hippo'));
  });

  it('arm 2: absent ancestor stores are listed too, so a store a test creates mid-run is still watched', () => {
    const dirs = watchedStoreDirs(fixture, home);
    expect(dirs).toContain(path.join(fixture, '.hippo'));
    expect(dirs).toContain(path.join(checkout, '.hippo'));
    expect(fs.existsSync(path.join(fixture, '.hippo'))).toBe(false);
    expect(fs.existsSync(path.join(checkout, '.hippo'))).toBe(false);
  });

  it('arm 3: cwd on the home bound still watches its own store, because getHippoRoot falls back to cwd/.hippo', () => {
    const dirs = watchedStoreDirs(home, home);
    expect(dirs).toEqual([path.join(home, '.hippo'), globalStoreRootLocal()]);
  });

  it('arm 4: the walk stops at the real temp root when home is off the walk entirely', () => {
    expect(watchedStoreDirs(fixture, offWalkHome)).toEqual([
      path.join(fixture, '.hippo'),
      path.join(checkout, '.hippo'),
      path.join(outer, '.hippo'),
      path.join(home, '.hippo'),
      path.join(sandboxRoot, '.hippo'),
      globalStoreRootLocal(),
    ]);
  });

  it('arm 5: the global store is always last and the list has no duplicates (weak: this fixture never collides)', () => {
    const dirs = watchedStoreDirs(fixture, home);
    expect(dirs[dirs.length - 1]).toBe(globalStoreRootLocal());
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('arm 6: HIPPO_HOME colliding with an ancestor store is listed once, not twice', () => {
    const prevHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = path.join(outer, '.hippo');
    try {
      const dirs = watchedStoreDirs(fixture, home);
      expect(dirs).toEqual([path.join(fixture, '.hippo'), path.join(checkout, '.hippo'), path.join(outer, '.hippo')]);
    } finally {
      if (prevHome === undefined) delete process.env.HIPPO_HOME;
      else process.env.HIPPO_HOME = prevHome;
    }
  });

  describe.skipIf(process.platform !== 'win32')('case-insensitive collision (win32 only)', () => {
    it('arm 7: HIPPO_HOME differing only in case still collides with the ancestor store', () => {
      const prevHome = process.env.HIPPO_HOME;
      process.env.HIPPO_HOME = path.join(outer, '.HIPPO');
      try {
        expect(watchedStoreDirs(fixture, home).length).toBe(3);
      } finally {
        if (prevHome === undefined) delete process.env.HIPPO_HOME;
        else process.env.HIPPO_HOME = prevHome;
      }
    });
  });

  it('arm 8: a junction on the cwd chain resolves to the real ancestor store, not the link chain', () => {
    const link = path.join(sandboxRoot, 'link');
    fs.symlinkSync(checkout, link, process.platform === 'win32' ? 'junction' : 'dir');
    const dirs = watchedStoreDirs(path.join(link, 'fixture'), home);
    expect(dirs).toEqual([
      path.join(fixture, '.hippo'),
      path.join(checkout, '.hippo'),
      path.join(outer, '.hippo'),
      globalStoreRootLocal(),
    ]);
  });

  it('arm 9: an ancestor holding a FILE named .hippo is still watched, and snapshotting it does not throw ENOTDIR', () => {
    const fileMarker = path.join(checkout, '.hippo');
    fs.writeFileSync(fileMarker, 'not a store');
    try {
      expect(watchedStoreDirs(fixture, home)).toContain(fileMarker);
      expect(snapshot(fileMarker)).toBe('<not-a-directory>');
    } finally {
      fs.rmSync(fileMarker, { force: true });
    }
  });
});
