import { ConfidenceLevel, EmotionalValence } from '../base/memory/entry.js';
import type { Http } from '../base/ports/http.js';
import { errorFields, errorMessage, log } from '../base/util/log.js';
import { readCappedJson, readCappedText } from '../base/util/capped-json.js';
import { MAX_REPLY_BYTES } from '../base/util/limits.js';
import { type JsonValue, isJsonNumber, isJsonObject, knownOption } from '../base/util/json.js';
import { JEV_MODEL, postScoring, TYPESAFE_ENDPOINT } from './rerankers/endpoint.js';

const MAX_CONCURRENCY = 8;

export type JudgedKind = 'error' | 'decision' | 'convention' | 'preference' | 'trivia';

export interface Judgment {
  durable: number;
  kind: JudgedKind;
  valence: EmotionalValence;
  confidence: ConfidenceLevel;
  kindConfidence: number;
}

export interface JudgeOptions {
  apiKey: string;
  model?: string;
  http: Http;
  concurrency?: number;
}

const JUDGE_MAX_ERROR_BYTES = 4096;
const OBSERVED_CONFIDENCE_MIN = 0.8;

function answerNamed(reply: JsonValue, name: string): { [key: string]: JsonValue } {
  const answers = isJsonObject(reply) ? reply.answers : undefined;
  const answer = isJsonObject(answers) ? answers[name] : undefined;
  return isJsonObject(answer) ? answer : {};
}

const QUESTIONS = {
  durable: {
    type: 'noul',
    instructions:
      'This text was extracted from an AI coding agent transcript as a candidate memory. It is worth storing ' +
      'long-term only if it would still be useful to a future agent working on this codebase weeks from now: a ' +
      'durable preference, a convention, a decision with a reason, or a gotcha that will recur. Transient chatter, ' +
      'one-off status, restatements of code already in the repo, and anything only true inside this one session are ' +
      'not worth storing.',
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

function toConfidenceTier(kindConfidence: number): ConfidenceLevel {
  if (kindConfidence >= OBSERVED_CONFIDENCE_MIN) return 'observed';
  return 'inferred';
}

const JUDGE_TIMEOUT_MS = 15_000;

async function post(content: string, opts: JudgeOptions): Promise<Response | null> {
  let res: Response;
  try {
    res = await postScoring(opts.http, {
      url: TYPESAFE_ENDPOINT,
      token: opts.apiKey,
      body: { state: content, model: opts.model ?? JEV_MODEL, questions: QUESTIONS },
      budgetMs: JUDGE_TIMEOUT_MS,
    });
  } catch (err) {
    log.warn(`judge: request failed: ${errorMessage(err)}`, errorFields(err));
    return null;
  }
  if (res.ok) return res;
  const snippet = (
    await readCappedText(res, JUDGE_MAX_ERROR_BYTES).catch((err) => {
      log.debug(`judge: error body unreadable: ${errorMessage(err)}`, errorFields(err));
      return '';
    })
  ).slice(0, 200);
  log.warn('judge: non-2xx reply', { status: res.status, body: snippet });
  return null;
}

async function judge(content: string, opts: JudgeOptions): Promise<Judgment | null> {
  const trimmed = content.trim();
  if (trimmed.length < 3) return null;

  const res = await post(trimmed, opts);
  if (!res) return null;

  let data: JsonValue;
  try {
    data = await readCappedJson(res, MAX_REPLY_BYTES);
  } catch (err) {
    log.warnThenDebug(
      'judge-unreadable',
      `judge: unreadable response: ${errorMessage(err)}`,
      errorFields(err),
    );
    return null;
  }

  const durable = answerNamed(data, 'durable').noul;
  const kindAnswer = answerNamed(data, 'kind');
  const kind = knownOption(KINDS, kindAnswer.choice) ?? null;
  const valence = knownOption(VALENCES, answerNamed(data, 'valence').choice) ?? null;
  if (!isJsonNumber(durable) || durable < 0 || durable > 1 || !kind || !valence) return null;

  const kindConfidence = isJsonNumber(kindAnswer.confidence) ? kindAnswer.confidence : 0;
  return { durable, kind, valence, confidence: toConfidenceTier(kindConfidence), kindConfidence };
}

/** Judge many candidates under a bounded concurrency pool, order preserved. */
export async function judgeOver(
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
