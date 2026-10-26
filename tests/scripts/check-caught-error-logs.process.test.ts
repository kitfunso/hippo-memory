import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  countUnfieldedLogs,
  findPartialPicks,
  findResultOnlyCatches,
  resultOnlyCatchLines,
  partialPickLines,
  unfieldedLogLines,
} from '../../scripts/check-caught-error-logs.mjs';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'check-caught-error-logs.mjs');
const BASELINE = '.caught-error-logs-baseline.json';

describe('check-caught-error-logs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'caught-error-logs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, body: string): void {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf-8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it('flags a log call in a catch block or a .catch callback that leaves out errorFields, with its line', () => {
    const text = [
      'try { work(); } catch (err) {',
      '  log.warn(`work failed: ${errorMessage(err)}`);',
      '}',
      'task().catch((err) => logger.debug(`task failed: ${errorMessage(err)}`));',
      'try { work(); } catch {',
      "  log.error('work failed');",
      '}',
    ].join('\n');
    expect(unfieldedLogLines(text)).toEqual([2, 4, 6]);
  });

  it('flags a log call in a function that takes the caught error as a parameter and sends only its message', () => {
    const text = [
      'function report(step, err) {',
      '  log.warn(`${step} failed: ${errorMessage(err)}`);',
      '}',
      'function reportAll(step, err) {',
      '  log.warn(`${step} failed`, errorFields(err));',
      '}',
      'function sizes(label, cause) {',
      '  log.info(`${label} sized`);',
      '}',
    ].join('\n');
    expect(unfieldedLogLines(text)).toEqual([2]);
  });

  it('accepts errorClassFields, which keeps the class and drops the text on purpose', () => {
    const text = ['try { x(); } catch (err) {', '  log.warn("late", errorClassFields(err));', '}'].join('\n');
    expect(unfieldedLogLines(text)).toEqual([]);
  });

  it('accepts expectedErrorText on a debug line only, the one stackless line an expected error earns', () => {
    const text = [
      'function noteSkipped(error) {',
      '  if (isAbsent(error)) log.debug(`skipped: ${expectedErrorText(error)}`);',
      '  else log.warn(`skipped: ${expectedErrorText(error)}`);',
      '}',
    ].join('\n');
    expect(unfieldedLogLines(text)).toEqual([3]);
  });

  it('passes a call that carries errorFields, spread or alone, and a log call outside any failure path', () => {
    const text = [
      'try { work(); } catch (err) {',
      '  log.warn(`work failed: ${errorMessage(err)}`, errorFields(err));',
      '  log.warn(`work failed: ${errorMessage(err)}`, { id, ...errorFields(err) });',
      '}',
      'task().catch((err) => { log.warn(`task failed`, errorFields(err)); });',
      "log.warn('not a failure path');",
      '// try { } catch (err) { log.warn(`in a comment`); }',
    ].join('\n');
    expect(unfieldedLogLines(text)).toEqual([]);
  });

  it("flags a log call in an 'error' listener given to on, once or addEventListener, inline or by name", () => {
    const text = [
      "child.on('error', (err) => log.warn(`a: ${errorMessage(err)}`));",
      "server.once('error', function (err) { log.warn(`b: ${errorMessage(err)}`); });",
      "target.addEventListener('error', () => { log.warn('c'); });",
      'const onFail = (err: Error): void => { log.warn(`d: ${errorMessage(err)}`); };',
      "socket.on('error', onFail);",
      "child.on('exit', () => log.warn('not an error listener'));",
    ].join('\n');
    expect(unfieldedLogLines(text)).toEqual([1, 2, 3, 4]);
  });

  it('passes an error listener that hands on errorFields', () => {
    const text = "child.on('error', (err) => log.warn(`a: ${errorMessage(err)}`, errorFields(err)));\n";
    expect(unfieldedLogLines(text)).toEqual([]);
  });

  it('does not count errorFields(x).prop, which drops the stack and the cause', () => {
    const text = [
      'try { work(); } catch (err) {',
      '  log.warn(`a`, { errorClass: errorFields(err).errorClass });',
      "  log.warn(`b`, { code: errorFields(err)['errorClass'] });",
      '}',
    ].join('\n');
    expect(unfieldedLogLines(text)).toEqual([2, 3]);
  });

  it('lists every errorFields(x) call read for one field, by property, index or destructuring, with its line', () => {
    const text = [
      'log.warn(`a`, { errorClass: errorFields(err).errorClass });',
      "log.warn(`b`, { code: errorFields(err)['errorClass'] });",
      'const { errorClass } = errorFields(err);',
      'log.warn(`kept whole`, errorFields(err));',
      'log.warn(`spread`, { id, ...errorFields(err) });',
      '// log.warn(errorFields(err).errorClass);',
    ].join('\n');
    expect(partialPickLines(text)).toEqual([1, 2, 3]);
  });

  it('fails the run on a partial pick even when the baseline allows every unfielded call', () => {
    file('src/pick.ts', 'export const f = (err: Error) => ({ errorClass: errorFields(err).errorClass });\n');
    file('src/whole.ts', 'export const g = (err: Error) => errorFields(err);\n');
    expect(findPartialPicks(join(dir, 'src'))).toEqual(['pick.ts:1']);
    writeFileSync(join(dir, BASELINE), '{}\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/pick.ts:1: reads one field of errorFields(...) and drops the rest');
  });

  it('counts a log call in a catch nested in another catch once', () => {
    const text = 'try { a(); } catch (e) { try { b(); } catch (f) { log.warn(`b failed`); } }\n';
    expect(unfieldedLogLines(text)).toEqual([1]);
  });

  it('fails a file with an unfielded log call and passes one that carries errorFields', () => {
    file(
      'src/bad.ts',
      'export function f(): void {\n  try { g(); } catch (err) {\n    log.warn(`g failed: ${errorMessage(err)}`);\n  }\n}\n',
    );
    file(
      'src/good.ts',
      'export function f(): void {\n  try { g(); } catch (err) {\n    log.warn(`g failed`, errorFields(err));\n  }\n}\n',
    );
    expect(countUnfieldedLogs(join(dir, 'src'))).toEqual({ 'bad.ts': 1 });
    writeFileSync(join(dir, BASELINE), '{}\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/bad.ts: 1 log calls in a failure path without errorFields(err) (baseline 0)');
  });

  it('passes at the baseline and refuses --update when a count would rise', () => {
    file('src/bad.ts', 'try { g(); } catch (err) { log.warn(`g failed`); }\n');
    writeFileSync(join(dir, BASELINE), JSON.stringify({ 'src/bad.ts': 1 }));
    expect(run().status).toBe(0);
    writeFileSync(join(dir, BASELINE), '{}\n');
    const r = run('--update');
    expect(r.status).toBe(1);
    expect(readFileSync(join(dir, BASELINE), 'utf-8')).toBe('{}\n');
  });

  it('passes on the real src tree at its baseline', () => {
    // SAFETY: the baseline is written by the script as a path-to-count object.
    const base = JSON.parse(readFileSync(resolve(__dirname, '..', '..', BASELINE), 'utf8')) as Record<string, number>;
    const counts = countUnfieldedLogs(resolve(__dirname, '..', '..', 'src'));
    for (const [f, n] of Object.entries(counts)) expect(n, f).toBeLessThanOrEqual(base[`src/${f}`] ?? 0);
  });

  it('flags a catch that sends only the error text to a result array, with its line', () => {
    const text = [
      'try { g(); } catch (err) {',
      '  result.details.push(`g failed: ${errorMessage(err)}`);',
      '}',
      'try { g(); } catch (cause) {',
      '  failures.push(String(cause));',
      '}',
    ].join('\n');
    expect(resultOnlyCatchLines(text)).toEqual([1, 4]);
  });

  it('passes a catch that also logs errorFields, or keeps the error object whole', () => {
    const text = [
      'try { g(); } catch (err) {',
      '  log.warn(`g failed`, errorFields(err));',
      '  result.details.push(`g failed: ${errorMessage(err)}`);',
      '}',
      'try { g(); } catch (error) {',
      '  failed.push({ event, error });',
      '}',
    ].join('\n');
    expect(resultOnlyCatchLines(text)).toEqual([]);
  });

  it('fails the check on a result-only catch in the tree', () => {
    file('src/quiet.ts', 'try { g(); } catch (err) { details.push(errorMessage(err)); }\n');
    expect(findResultOnlyCatches(join(dir, 'src'))).toEqual(['quiet.ts:1']);
    writeFileSync(join(dir, BASELINE), '{}\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/quiet.ts:1: the caught error goes only into a result array, not a log');
  });

  it('finds no result-only catch in the real src tree', () => {
    expect(findResultOnlyCatches(resolve(__dirname, '..', '..', 'src'))).toEqual([]);
  });
});
