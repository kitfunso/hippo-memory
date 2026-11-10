// A model load is bounded and backed off, and a recall stops waiting on a local model only while it downloads.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelLoads, MODEL_LOAD_POLICY } from '../../src/infra/transformers.js';
import type { EmbeddingProvider } from '../../src/base/ports/embedder.js';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import { createLocalEmbedder } from '../../src/infra/local-embedder.js';
import { embedQueryBy } from '../../src/domain/search/vector.js';
import { loadConfig } from '../../src/host/config-file.js';

type Pipe = (input: string) => Promise<{ data: number[] }>;
type PipelineFn = (task: string, model: string) => Promise<Pipe>;

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-model-loads-'));
  dirs.push(dir);
  return dir;
};
const MODEL = 'test/model';

/** A local provider over a stand-in for the optional package, which these tests never install; each gets its own loads. */
function localProvider(pipeline: PipelineFn, cacheDir: string): EmbeddingProvider {
  const transformers = {
    installed: () => true,
    load: async () => ({ name: '@huggingface/transformers', mod: { env: { cacheDir }, pipeline } }),
  };
  return resolveEmbeddingProvider(loadConfig(tempDir()).embeddings, { provider: 'local', model: MODEL, transformers });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (v: T) => void;
}

/** A promise the test settles by hand. */
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let stderr: MockInstance<typeof process.stderr.write>;
const logged = (): string[] => stderr.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.stubEnv('HIPPO_MODEL_CACHE', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('createModelLoads', () => {
  it('fails a load that hangs at the timeout, then answers from memory until the backoff window ends', async () => {
    vi.useFakeTimers();
    const failures: string[] = [];
    const loads = createModelLoads<string>(MODEL_LOAD_POLICY, (_key, err) => failures.push(err.message));
    const start = vi.fn(() => new Promise<string>(() => {}));

    const first = loads.load('m', start);
    const firstFailed = expect(first).rejects.toThrow(`m did not load within ${MODEL_LOAD_POLICY.timeoutMs / 1000} s`);
    await vi.advanceTimersByTimeAsync(MODEL_LOAD_POLICY.timeoutMs);
    await firstFailed;

    await expect(loads.load('m', start)).rejects.toThrow(/did not load within/);
    await vi.advanceTimersByTimeAsync(MODEL_LOAD_POLICY.backoffMs - 1);
    await expect(loads.load('m', start)).rejects.toThrow(/did not load within/);
    expect(start).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    // Left pending: the fake clock goes with the test, so its timeout never fires.
    void loads.load('m', start);
    await vi.advanceTimersByTimeAsync(0);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('remembers a load that throws, with its own error, for one backoff window', async () => {
    vi.useFakeTimers();
    const failures: Error[] = [];
    const loads = createModelLoads<string>(MODEL_LOAD_POLICY, (_key, err) => failures.push(err));
    const start = vi.fn(async (): Promise<string> => {
      throw new Error('fetch failed: ECONNREFUSED');
    });

    await expect(loads.load('m', start)).rejects.toThrow('fetch failed: ECONNREFUSED');
    await expect(loads.load('m', start)).rejects.toThrow('fetch failed: ECONNREFUSED');
    expect(start).toHaveBeenCalledTimes(1);
    expect(failures.map((e) => e.message)).toEqual(['fetch failed: ECONNREFUSED']);

    start.mockResolvedValueOnce('model');
    await vi.advanceTimersByTimeAsync(MODEL_LOAD_POLICY.backoffMs);
    await expect(loads.load('m', start)).resolves.toBe('model');
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('shares one load between concurrent calls, and keeps a model that lands after its timeout', async () => {
    vi.useFakeTimers();
    const late = deferred<string>();
    const loads = createModelLoads<string>(MODEL_LOAD_POLICY);
    const start = vi.fn(() => late.promise);

    const both = Promise.allSettled([loads.load('m', start), loads.load('m', start)]);
    await vi.advanceTimersByTimeAsync(MODEL_LOAD_POLICY.timeoutMs);
    expect((await both).map((r) => r.status)).toEqual(['rejected', 'rejected']);

    late.resolve('model');
    await vi.advanceTimersByTimeAsync(0);
    await expect(loads.load('m', start)).resolves.toBe('model');
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('the local embedding model under a recall deadline', () => {
  it('stops waiting at the deadline while the model downloads, and a later call gets it once it lands', async () => {
    const download = deferred<Pipe>();
    const pipeline = vi.fn<PipelineFn>(() => download.promise);
    const provider = localProvider(pipeline, tempDir());
    const deadline = new AbortController();

    const embedding = embedQueryBy(deadline.signal, provider, 'deploy');
    await vi.waitFor(() => expect(pipeline).toHaveBeenCalledTimes(1));
    deadline.abort();

    expect(await embedding).toBeNull();
    download.resolve(async () => ({ data: [0, 1] }));
    expect(await provider.embed(['deploy'], 'query')).toEqual([[0, 1]]);
    expect(await embedQueryBy(AbortSignal.abort(), provider, 'deploy')).toEqual([0, 1]);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it('waits past the deadline for a model loading from disk', async () => {
    const cacheDir = tempDir();
    mkdirSync(join(cacheDir, MODEL, 'onnx'), { recursive: true });
    const fromDisk = deferred<Pipe>();
    const pipeline = vi.fn<PipelineFn>(() => fromDisk.promise);
    const provider = localProvider(pipeline, cacheDir);
    const deadline = new AbortController();

    const embedding = embedQueryBy(deadline.signal, provider, 'deploy');
    await vi.waitFor(() => expect(pipeline).toHaveBeenCalledTimes(1));
    deadline.abort();
    fromDisk.resolve(async () => ({ data: [1, 0] }));

    expect(await embedding).toEqual([1, 0]);
  });

  it('warns with the real load error and its class once, then answers from memory without loading again', async () => {
    const pipeline = vi.fn<PipelineFn>(async () => {
      throw new TypeError('fetch failed: getaddrinfo ENOTFOUND huggingface.co');
    });
    const provider = localProvider(pipeline, tempDir());

    await expect(provider.embed(['a memory'], 'passage')).rejects.toThrow(
      /did not load: fetch failed: getaddrinfo ENOTFOUND/,
    );
    await expect(provider.embed(['a memory'], 'passage')).rejects.toThrow(/did not load: fetch failed/);

    const warnings = logged().filter((line) => line.includes(`local embedding model ${MODEL} did not load`));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[hippo\] warn: .*getaddrinfo ENOTFOUND huggingface\.co.*errorClass=TypeError/);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });
});

describe('local embedder availability', () => {
  /** An embedder over a stand-in package whose installed answer the test flips by hand. */
  function embedderOver(initiallyInstalled: boolean) {
    const state = { installed: initiallyInstalled };
    const installed = vi.fn(() => state.installed);
    const pipeline = async () => async (): Promise<{ data: number[] }> => ({ data: [1, 0] });
    const load = vi.fn(async () => ({ name: 'stand-in', mod: { pipeline } }));
    return { state, installed, load, embedder: createLocalEmbedder({ installed, load }) };
  }
  const later = (ms: number): void => {
    vi.setSystemTime(Date.now() + ms);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  it('turns available once the package is installed and one window has passed, with no restart', async () => {
    const { state, embedder } = embedderOver(false);
    expect(embedder.isAvailable()).toBe(false);

    state.installed = true;
    later(MODEL_LOAD_POLICY.backoffMs);

    expect(embedder.isAvailable()).toBe(true);
    expect(await embedder.embed('x', MODEL)).toEqual([1, 0]);
  });

  it('does not ask again inside the window, and asks once the window ends', async () => {
    const { installed, load, embedder } = embedderOver(false);
    expect(embedder.isAvailable()).toBe(false);

    later(MODEL_LOAD_POLICY.backoffMs - 1);
    for (let i = 0; i < 3; i++) {
      expect(embedder.isAvailable()).toBe(false);
      expect(await embedder.embed('x', MODEL)).toEqual([]);
    }
    expect(installed).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();

    later(1);
    embedder.isAvailable();
    expect(installed).toHaveBeenCalledTimes(2);
  });

  it('keeps a true answer for the life of the embedder', () => {
    const { state, installed, embedder } = embedderOver(true);
    expect(embedder.isAvailable()).toBe(true);

    state.installed = false;
    later(10 * MODEL_LOAD_POLICY.backoffMs);

    expect(embedder.isAvailable()).toBe(true);
    expect(installed).toHaveBeenCalledTimes(1);
  });

  it('answers [] without loading a model while the package is missing', async () => {
    const { load, embedder } = embedderOver(false);
    expect(embedder.isAvailable()).toBe(false);
    expect(await embedder.embed('x', MODEL)).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
});
