// A write to a hook's own log file in a failure path must carry the error's fields, as a shared log line must.
import { describe, expect, it } from 'vitest';
import { unfieldedLogLines } from '../../scripts/checks/check-caught-error-logs.mjs';

describe('check-caught-error-logs on a hook side log', () => {
  it('counts each side-log writer in a catch that omits errorFields', () => {
    const text = [
      'try { a(); } catch (err) {',
      '  appendPreCompactLog(file, `failed: ${errorMessage(err)}`);',
      '  appendSessionEndCloseLog(file, `failed: ${errorMessage(err)}`);',
      '  logLine(`failed: ${errorMessage(err)}`);',
      '  log(`failed: ${errorMessage(err)}`);',
      '  close.log(`failed: ${errorMessage(err)}`);',
      '  opts.log(`failed: ${errorMessage(err)}`, { startFresh: true });',
      '}',
    ].join('\n');
    expect(unfieldedLogLines(text)).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('passes a side-log write that carries errorFields or hands on the error, and one outside a failure path', () => {
    const text = [
      'try { a(); } catch (err) {',
      '  appendPreCompactLog(file, `failed`, errorFields(err));',
      '  appendSessionEndCloseLog(file, `failed`, { fields: errorFields(err) });',
      '  w.log(`failed`, { startFresh: true, fields: errorFields(err) });',
      '  log(`replay failed`, err);',
      '  console.log(`[hippo] capture failed: ${errorMessage(err)}`);',
      '}',
      'appendPreCompactLog(file, "fine outside a catch");',
    ].join('\n');
    expect(unfieldedLogLines(text)).toEqual([]);
  });
});
