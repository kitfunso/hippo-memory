import { describe, it, expect } from 'vitest';
import { judgeAll, type JudgeOptions, type Judgment } from '../src/eval/judgment.js';
import { envTypesafeApiKey } from '../src/util/env.js';

interface JevAnswerFixture { type?: string; noul?: number; choice?: string; confidence?: number }
interface JevBodyFixture {
  answers?: { durable?: JevAnswerFixture; kind?: JevAnswerFixture; valence?: JevAnswerFixture };
}
interface JevQuestion { type: string; instructions: string; criteria?: Record<string, string> }
interface JevRequestBody {
  state: string;
  model: string;
  questions: { durable: JevQuestion; kind: JevQuestion; valence: JevQuestion };
}

/** One candidate through judgeAll, the module's public entry. */
async function judgeOne(content: string, opts: JudgeOptions): Promise<Judgment | null> {
  const [result] = await judgeAll([content], opts);
  return result ?? null;
}

function jevResponse(body: JevBodyFixture, status = 200): typeof fetch {
  return async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sentBody(init: RequestInit | undefined): JevRequestBody {
  // SAFETY: `init` is the request `judge` just made through a fetcher this
  // file supplied, and judge always stringifies exactly this object.
  return JSON.parse(String(init?.body)) as JevRequestBody;
}

const GOOD = {
  answers: {
    durable: { type: 'noul', noul: 0.94 },
    kind: { type: 'choice', choice: 'convention', confidence: 0.88 },
    valence: { type: 'choice', choice: 'critical', confidence: 0.7 },
  },
};

describe('judge', () => {
  it('maps a well-formed Jev answer onto hippo fields', async () => {
    const result = await judgeOne('always use real DB for tests', {
      apiKey: 'test-key',
      fetcher: jevResponse(GOOD),
    });
    expect(result).toEqual({
      durable: 0.94,
      kind: 'convention',
      valence: 'critical',
      confidence: 'observed',
      kindConfidence: 0.88,
    });
  });

  it('sends the key as a bearer token and the content as state', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const spy: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(JSON.stringify(GOOD), { status: 200 });
    };

    await judgeOne('some lesson', { apiKey: 'sk-abc', fetcher: spy });

    expect(seenUrl).toBe('https://api.typesafe.ai/v1/systemone');
    expect(new Headers(seenInit?.headers).get('authorization')).toBe('Bearer sk-abc');
    const body = sentBody(seenInit);
    expect(body.state).toBe('some lesson');
    expect(body.model).toBe('jev-1.13.0');
    expect(Object.keys(body.questions).sort()).toEqual(['durable', 'kind', 'valence']);
  });

  it('drops below the observed tier when Jev is not confident', async () => {
    const result = await judgeOne('maybe a lesson', {
      apiKey: 'k',
      fetcher: jevResponse({
        answers: {
          durable: { noul: 0.3 },
          kind: { choice: 'trivia', confidence: 0.41 },
          valence: { choice: 'neutral', confidence: 0.5 },
        },
      }),
    });
    expect(result?.confidence).toBe('inferred');
    expect(result?.kind).toBe('trivia');
  });

  it('returns null rather than a wrong answer when the body is off-schema', async () => {
    const cases: JevBodyFixture[] = [
      { answers: { durable: { noul: 0.9 }, kind: { choice: 'vibes' }, valence: { choice: 'neutral' } } },
      { answers: { durable: { noul: 1.4 }, kind: { choice: 'error' }, valence: { choice: 'neutral' } } },
      { answers: { kind: { choice: 'error' }, valence: { choice: 'neutral' } } },
      {},
    ];
    for (const body of cases) {
      const result = await judgeOne('x y z', { apiKey: 'k', fetcher: jevResponse(body) });
      expect(result).toBeNull();
    }
  });

  it('returns null, never throws, on a body that is not an object or is not JSON', async () => {
    const reply = (body: string): typeof fetch => async () => new Response(body, { status: 200 });
    for (const body of ['null', '[]', '"ok"', '{"answers":null}', '{"answers":{"durable":null,"kind":7,"valence":[]}}', '<html>busy</html>']) {
      expect(await judgeOne('x y z', { apiKey: 'k', fetcher: reply(body) })).toBeNull();
    }
  });

  it('returns null when a number arrives as a string, which would pass the range check by coercion', async () => {
    const body = JSON.stringify({ answers: { durable: { noul: '0.9' }, kind: { choice: 'error' }, valence: { choice: 'neutral' } } });
    expect(await judgeOne('x y z', { apiKey: 'k', fetcher: async () => new Response(body, { status: 200 }) })).toBeNull();
  });

  it('returns null for a reply over the 1 MiB cap, even one whose answers are valid', async () => {
    const padded = JSON.stringify(GOOD).replace(/}$/, `${' '.repeat(1024 * 1024)}}`);
    expect(JSON.parse(padded)).toEqual(GOOD);
    expect(await judgeOne('x y z', { apiKey: 'k', fetcher: async () => new Response(padded, { status: 200 }) })).toBeNull();
  });

  it('fails open on transport and HTTP errors', async () => {
    const thrower: typeof fetch = async () => { throw new Error('offline'); };
    expect(await judgeOne('abc', { apiKey: 'k', fetcher: thrower })).toBeNull();
    expect(await judgeOne('abc', { apiKey: 'k', fetcher: jevResponse({}, 401) })).toBeNull();
  });

  it('retries once on a rate limit, then succeeds', async () => {
    let calls = 0;
    const flaky: typeof fetch = async () => {
      calls++;
      return calls === 1
        ? new Response('', { status: 429 })
        : new Response(JSON.stringify(GOOD), { status: 200 });
    };

    const result = await judgeOne('abc', { apiKey: 'k', fetcher: flaky });
    expect(calls).toBe(2);
    expect(result?.durable).toBe(0.94);
  });

  it('makes no call for content too short to be a memory', async () => {
    let calls = 0;
    const counter: typeof fetch = async () => { calls++; return new Response('{}'); };
    expect(await judgeOne('  a ', { apiKey: 'k', fetcher: counter })).toBeNull();
    expect(calls).toBe(0);
  });
});

describe('judgeAll', () => {
  it('preserves input order under concurrency and isolates per-item failure', async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      const state = sentBody(init).state;
      if (state === 'bad') return new Response('', { status: 500 });
      await new Promise((r) => setTimeout(r, state === 'slow' ? 20 : 0));
      return new Response(JSON.stringify({
        answers: {
          durable: { noul: state === 'slow' ? 0.1 : 0.8 },
          kind: { choice: 'decision', confidence: 0.9 },
          valence: { choice: 'neutral', confidence: 0.9 },
        },
      }));
    };

    const out = await judgeAll(['slow', 'bad', 'fast'], { apiKey: 'k', fetcher, concurrency: 3 });
    expect(out.map((j) => j?.durable ?? null)).toEqual([0.1, null, 0.8]);
  });

  it('handles an empty batch without hanging', async () => {
    const never: typeof fetch = async () => { throw new Error('should not be called'); };
    expect(await judgeAll([], { apiKey: 'k', fetcher: never })).toEqual([]);
  });
});

describe('envTypesafeApiKey', () => {
  it('treats a missing or blank key as opt-out', () => {
    const original = process.env.TYPESAFE_API_KEY;
    try {
      delete process.env.TYPESAFE_API_KEY;
      expect(envTypesafeApiKey()).toBeUndefined();
      process.env.TYPESAFE_API_KEY = '   ';
      expect(envTypesafeApiKey()).toBeUndefined();
      process.env.TYPESAFE_API_KEY = ' sk-live ';
      expect(envTypesafeApiKey()).toBe('sk-live');
    } finally {
      if (original === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = original;
    }
  });
});
