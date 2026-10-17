import { describe, expect, it } from 'vitest';
import { handBuiltStores } from '../scripts/check-test-stores.mjs';

const lines = (text: string): number[] => handBuiltStores(text).map((hit) => hit.line);

describe('check-test-stores', () => {
  it('flags a store opened on the temp dir itself, on a joined path and on a template path', () => {
    const text = [
      "const a = mkdtempSync(join(tmpdir(), 'a-'));",
      'initStore(a);',
      'const b = join(a, ".hippo");',
      'openHippoDb(b);',
      'const c = `${a}/store`;',
      'initStore(c);',
    ].join('\n');
    expect(lines(text)).toEqual([2, 4, 6]);
  });

  it('flags a store opened inline on a mkdtempSync call and on a reassigned let', () => {
    const text = [
      "initStore(mkdtempSync(join(tmpdir(), 'inline-')));",
      'let root: string;',
      "beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'x-'))); });",
      'openHippoDb(join(root, ".hippo"));',
    ].join('\n');
    expect(lines(text)).toEqual([1, 4]);
  });

  it('passes a temp dir used for a fake home, a vault or a plain file', () => {
    const text = [
      "const home = mkdtempSync(join(tmpdir(), 'home-'));",
      'writeFileSync(join(home, "notes.md"), "x");',
      'const store = makeRoot("s");',
      'initStore(join(store, "other"));',
    ].join('\n');
    expect(handBuiltStores(text)).toEqual([]);
  });

  it('flags a temp dir handed to the CLI as HIPPO_HOME or as the cwd of a hippo spawn', () => {
    const text = [
      "const home = mkdtempSync(join(tmpdir(), 'h-'));",
      "vi.stubEnv('HIPPO_HOME', home);",
      "spawnSync(process.execPath, [HIPPO_JS, 'init'], { cwd: home });",
      "execFileSync('node', [HIPPO_JS, 'recall'], { env: { ...process.env, HIPPO_HOME: home } });",
    ].join('\n');
    expect(lines(text)).toEqual([2, 3, 4]);
  });

  it('passes a temp dir as the cwd of a spawn that is not hippo, and a path inside the dir for HIPPO_HOME', () => {
    const text = [
      "const home = mkdtempSync(join(tmpdir(), 'h-'));",
      "spawnSync('git', ['init'], { cwd: home });",
      "vi.stubEnv('HIPPO_HOME', join(home, 'global'));",
    ].join('\n');
    expect(handBuiltStores(text)).toEqual([]);
  });

  it('flags initStore and openStore on a function parameter, and passes openHippoDb on one', () => {
    const text = [
      'function seed(root: string) { initStore(root); }',
      'const open = (dir: string) => openStore(dir);',
      'function read(root: string) { return openHippoDb(root); }',
      'const made = makeRoot("t");',
      'initStore(made);',
    ].join('\n');
    expect(lines(text)).toEqual([1, 2]);
  });

  it('passes a store from makeRoot or makeStore and a file with no mkdtempSync', () => {
    expect(handBuiltStores('const { root } = makeStore("t");\nopenHippoDb(root);')).toEqual([]);
    expect(handBuiltStores('const root = makeRoot("t");\ninitStore(root);')).toEqual([]);
  });

  it('does not follow a value that is only a property of the temp dir name', () => {
    const text = [
      "const dir = mkdtempSync(join(tmpdir(), 'd-'));",
      'const made = makeStore("t");',
      'openHippoDb(made.dir);',
    ].join('\n');
    expect(handBuiltStores(text)).toEqual([]);
  });

  it('does not follow a name through a call that is not a path function', () => {
    const text = [
      "const dir = mkdtempSync(join(tmpdir(), 'd-'));",
      'const root = makeRoot(dir);',
      'initStore(root);',
    ].join('\n');
    expect(handBuiltStores(text)).toEqual([]);
  });
});
