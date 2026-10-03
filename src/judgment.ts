/** Typed judgment over capture candidates via TypeSafe's Jev (System One).
 *  Regex picks WHAT is a candidate; it cannot say what is worth keeping, so
 *  every captured memory currently lands on a flat schema_fit of 0.5. */

import { ConfidenceLevel, EmotionalValence } from './memory.js';
import { fetchWithRetry } from './http-retry.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-1.13.0';
const MAX_CONCURRENCY = 8;

export type JudgedKind = 'error' | 'decision' | 'convention' | 'preference' | 'trivia';

export interface Judgment {
  /** Jev noul, 0..1. Maps to `schema_fit` on the written entry. */
  durable: number;
  kind: JudgedKind;
  valence: EmotionalValence;
  confidence: ConfidenceLevel;
  /** Jev's calibrated confidence on the kind choice, 0..1. */
  kindConfidence: number;
}

export interface JudgeOptions {
  apiKey: string;
  model?: string;
  /** Injected for testing — defaults to the real fetch. */
  fetcher?: typeof fetch;
  /** Bounded parallelism for `judgeAll`. */
  concurrency?: number;
}

interface JevNoulAnswer { noul?: number }
interface JevChoiceAnswer { choice?: string; confidence?: number }
interface JevResponse {
  answers?: {
    durable?: JevNoulAnswer;
    kind?: JevChoiceAnswer;
    valence?: JevChoiceAnswer;
  };
}

const QUESTIONS = {
  durable: {
    type: 'noul',
    instructions:
      'This text was extracted from an AI coding agent transcript as a candidate memory. It is worth storing long-term only if it would still be useful to a future agent working on this codebase weeks from now: a durable preference, a convention, a decision with a reason, or a gotcha that will recur. Transient chatter, one-off status, restatements of code already in the repo, and anything only true inside this one session are not worth storing.',
  },
  kind: {
    type: 'choice',
    instructions: 'Classify what kind of durable knowledge this is.',
    criteria: {
      error: 'A failure, gotcha, or thing that went wrong, and why.',
      decision: 'A choice that was made, ideally with its reason.',
      convention: 'A rule, standard, or way this project does things.',
      preference: 'A stated preference of the user or team.',
      trivia: 'None of the above; incidental detail with no reuse value.',
    },
  },
  valence: {
    type: 'choice',
    instructions: 'Classify the emotional charge of this memory for replay priority.',
    criteria: {
      critical: 'A costly failure or a rule whose violation causes real damage.',
      negative: 'Something that went wrong, or a warning.',
      positive: 'Something that worked, or a confirmed good approach.',
      neutral: 'Plain fact with no success or failure charge.',
    },
  },
} as const;

const KINDS: readonly JudgedKind[] = ['error', 'decision', 'convention', 'preference', 'trivia'];
const VALENCES: readonly EmotionalValence[] = ['critical', 'negative', 'positive', 'neutral'];

/** Absent key means hippo keeps its pre-Jev behaviour and makes no HTTP call. */
export function judgmentApiKey(): string | undefined {
  const key = process.env.TYPESAFE_API_KEY?.trim();
  return key ? key : undefined;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | null {
  return allowed.find((option) => option === value) ?? null;
}

/** `verified` is unreachable: that tier means a human or a test confirmed it. */
function toConfidenceTier(kindConfidence: number): ConfidenceLevel {
  if (kindConfidence >= 0.8) return 'observed';
  return 'inferred';
}

/** Capture-time judging must not hold a write for long: one budget per attempt, shorter than the LLM calls. */
const JUDGE_TIMEOUT_MS = 15_000;

async function post(content: string, opts: JudgeOptions): Promise<Response | null> {
  let res: Response;
  try {
    res = await fetchWithRetry(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        state: content,
        model: opts.model ?? DEFAULT_MODEL,
        questions: QUESTIONS,
      }),
    }, { timeoutMs: JUDGE_TIMEOUT_MS, fetchFn: opts.fetcher });
  } catch {
    return null;
  }
  return res.ok ? res : null;
}

/** `null` on any failure, so a Jev outage degrades capture to today's
 *  behaviour instead of blocking the write. */
export async function judge(content: string, opts: JudgeOptions): Promise<Judgment | null> {
  const trimmed = content.trim();
  if (trimmed.length < 3) return null;

  const res = await post(trimmed, opts);
  if (!res) return null;

  let data: JevResponse;
  try {
    // SAFETY: the documented Jev response is `{ answers: { <name>: Answer } }`
    // keyed by the question names posted above; every field read below is
    // optional-chained and range-checked before use, so a lie here returns null.
    data = await res.json() as JevResponse;
  } catch {
    return null;
  }

  const durable = data.answers?.durable?.noul;
  const kind = oneOf(data.answers?.kind?.choice, KINDS);
  const valence = oneOf(data.answers?.valence?.choice, VALENCES);
  if (durable === undefined || durable < 0 || durable > 1 || !kind || !valence) return null;

  const kindConfidence = data.answers?.kind?.confidence ?? 0;
  return { durable, kind, valence, confidence: toConfidenceTier(kindConfidence), kindConfidence };
}

/** Judge many candidates under a bounded concurrency pool, order preserved. */
export async function judgeAll(
  contents: readonly string[],
  opts: JudgeOptions,
): Promise<(Judgment | null)[]> {
  const out: (Judgment | null)[] = Array.from({ length: contents.length }, () => null);
  const limit = Math.max(1, opts.concurrency ?? MAX_CONCURRENCY);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < contents.length) {
      const i = cursor++;
      out[i] = await judge(contents[i]!, opts);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, contents.length) }, worker));
  return out;
}
