// The one LLM call behind every DAG summary, kept apart from the graph writes so its request bytes are tested on their own.
import { redactSecretsStrict } from '../util/secret-detect.js';
import { describeMessageFailure, sendAnthropicMessage } from '../util/anthropic-messages.js';
import { certainDefect } from '../core/memory-quality.js';

export interface DagSummaryOptions {
  apiKey: string;
  model?: string;
  fetcher?: typeof fetch;
  onError?: (msg: string) => void;
}

const DAG_SUMMARY_PROMPT = `You are summarizing a cluster of facts about a specific topic/entity for a memory system.

Topic: {label}
Facts:
{facts}

` +
  'Write a single concise paragraph (2-4 sentences) that captures all the key information from these facts. ' +
  'This summary will be used to quickly determine if this cluster is relevant to a future query, ' +
  'so include specific names, dates, numbers, and key details. Output ONLY the summary paragraph, no preamble.';

// Output budget for one summary paragraph, and the shortest reply kept as a summary.
const SUMMARY_MAX_TOKENS = 400;
const SUMMARY_MIN_CHARS = 20;

export async function generateDagSummary(
  label: string,
  factContents: string[],
  opts: DagSummaryOptions,
): Promise<string | null> {
  const factsBlock = factContents.map((f, i) => `${i + 1}. ${redactSecretsStrict(f)}`).join('\n');
  const prompt = DAG_SUMMARY_PROMPT
    .replace('{label}', redactSecretsStrict(label))
    .replace('{facts}', factsBlock);

  const reply = await sendAnthropicMessage({
    apiKey: opts.apiKey,
    model: opts.model,
    maxTokens: SUMMARY_MAX_TOKENS,
    prompt,
    fetcher: opts.fetcher,
  });
  if (!reply.ok) {
    opts.onError?.(describeMessageFailure(reply.failure));
    return null;
  }

  const defect = certainDefect(reply.text);
  if (defect !== null) {
    opts.onError?.(`summary quality refused: ${defect}`);
    return null;
  }
  return reply.text.length >= SUMMARY_MIN_CHARS ? reply.text : null;
}
