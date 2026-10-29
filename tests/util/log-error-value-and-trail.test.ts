// errorFields keeps a short preview of a thrown non-Error value; a server process writes its request trail by default.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorFields } from '../../src/base/util/log.js';

describe('errorFields for a thrown value that is not an Error', () => {
  it('names the class and previews the value', () => {
    expect(errorFields('plain text')).toEqual({ errorClass: 'NonError', value: 'plain text' });
    expect(errorFields({ code: 7 })).toEqual({ errorClass: 'NonError', value: '{"code":7}' });
    expect(errorFields(undefined).value).toBe('undefined');
  });

  it('masks a key-shaped value and cuts a long one', () => {
    const key = `sk-ant-${'a1'.repeat(20)}`;
    expect(String(errorFields(`failed with ${key}`).value)).not.toContain(key);
    const long = String(errorFields('x'.repeat(5000)).value);
    expect(long.length).toBeLessThan(300);
    expect(long.endsWith('...')).toBe(true);
  });

  it('survives a value that cannot be printed', () => {
    const cyclic = { self: {} };
    cyclic.self = cyclic;
    expect(errorFields(cyclic).value).toBe('(unprintable)');
  });
});

describe('the request trail', () => {
  let write: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('HIPPO_LOG', undefined);
    write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    write.mockRestore();
    vi.unstubAllEnvs();
  });
  const out = (): string => write.mock.calls.map((c: unknown[]) => String(c[0])).join('');

  it('is off in a CLI or hook process at the default threshold', async () => {
    const { log } = await import('../../src/base/util/log.js');
    log.trail('request', { status: 200 });
    expect(out()).toBe('');
  });

  it('is on at the default threshold once a server process enables it', async () => {
    const { log, enableRequestTrail } = await import('../../src/base/util/log.js');
    enableRequestTrail();
    log.trail('request', { status: 200 });
    expect(out()).toMatch(/\[hippo\] info: request .*status=200/);
  });

  it('stays off when HIPPO_LOG names a threshold above info', async () => {
    vi.stubEnv('HIPPO_LOG', 'warn');
    const { log, enableRequestTrail } = await import('../../src/base/util/log.js');
    enableRequestTrail();
    log.trail('request', { status: 200 });
    expect(out()).toBe('');
  });

  it('does not turn other info lines on', async () => {
    const { log, enableRequestTrail } = await import('../../src/base/util/log.js');
    enableRequestTrail();
    log.info('something else');
    expect(out()).toBe('');
  });
});
