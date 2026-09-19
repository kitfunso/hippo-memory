import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';

const MODEL_NAME = 'Xenova/ms-marco-MiniLM-L-6-v2';

// Opaque here: the tokenizer output goes straight into the model.
interface Tokenized {
  readonly input_ids: object;
  readonly attention_mask: object;
}
type TokenizerFn = (
  text: string,
  opts: { text_pair: string; padding: boolean; truncation: boolean },
) => Promise<Tokenized>;
type SeqClsModel = (inputs: Tokenized) => Promise<{ logits: { data: ArrayLike<number> } }>;
interface FromPretrained<T> {
  from_pretrained: (model: string) => Promise<T>;
}

interface TransformersExports {
  AutoTokenizer?: FromPretrained<TokenizerFn>;
  AutoModelForSequenceClassification?: FromPretrained<SeqClsModel>;
}
interface TransformersModuleNamespace extends TransformersExports {
  default?: TransformersExports;
}

const _require = createRequire(import.meta.url);

const TRANSFORMERS_PACKAGES = ['@huggingface/transformers', '@xenova/transformers'] as const;

// Returns a file URL, not the bare specifier: under a bundler's module runner
// a raw dynamic import cannot resolve bare specifiers, which silently forced
// the identity fallback and left the model untested in CI.
function resolveTransformersPackage(): string | null {
  for (const name of TRANSFORMERS_PACKAGES) {
    try {
      return pathToFileURL(_require.resolve(name)).href;
    } catch {
      // Try the legacy fallback only when the preferred package is not installed.
    }
  }
  return null;
}

async function loadTransformersModule(): Promise<Required<TransformersExports> | null> {
  // Import one backend only. Loading both native ONNX runtimes in one process
  // can abort during finalization; Hugging Face is the maintained default.
  const url = resolveTransformersPackage();
  if (!url) return null;
  try {
    const mod: TransformersModuleNamespace = await import(/* @vite-ignore */ url);
    const tok = mod.AutoTokenizer ?? mod.default?.AutoTokenizer;
    const seq =
      mod.AutoModelForSequenceClassification ?? mod.default?.AutoModelForSequenceClassification;
    return tok && seq ? { AutoTokenizer: tok, AutoModelForSequenceClassification: seq } : null;
  } catch {
    return null;
  }
}

type CrossEncoderFn = (query: string, candidate: string) => Promise<number>;
let cachedPipeline: CrossEncoderFn | null = null;
let warnedOnFallback = false;

/**
 * True if a Transformers.js backend is importable. Note: this does NOT confirm
 * that the model is downloadable from Hugging Face CDN — in sandboxed
 * environments the package may import but the model fetch may be blocked.
 * The reranker silently falls back to identity ordering in that case.
 */
export async function isCrossEncoderAvailable(): Promise<boolean> {
  return (await loadTransformersModule()) !== null;
}

// NOT the text-classification pipeline: this model is a num_labels=1
// regression head, and that pipeline softmaxes a length-1 logit vector, which
// is identically 1.0 for every input. Read the logit, then squash it.
async function loadPipeline(): Promise<CrossEncoderFn | null> {
  if (cachedPipeline) return cachedPipeline;
  try {
    const mod = await loadTransformersModule();
    if (!mod) return null;
    const [tokenizer, model] = await Promise.all([
      mod.AutoTokenizer.from_pretrained(MODEL_NAME),
      mod.AutoModelForSequenceClassification.from_pretrained(MODEL_NAME),
    ]);
    cachedPipeline = async (query: string, candidate: string) => {
      const inputs = await tokenizer(query, {
        text_pair: candidate,
        padding: true,
        truncation: true,
      });
      const { logits } = await model(inputs);
      return 1 / (1 + Math.exp(-Number(logits.data[0])));
    };
    return cachedPipeline;
  } catch {
    return null;
  }
}

/** Track 2 reranker: MS-MARCO MiniLM cross-encoder, identity fallback if the model will not load. */
export const crossEncoderReranker: RerankerFn = async (
  query,
  results,
  options?: RerankerOptions,
): Promise<RerankResult[]> => {
  const topK = options?.topK ?? 50;
  const head = results.slice(0, topK);

  const pipe = await loadPipeline();
  if (!pipe) {
    // Warn once per process: a silent identity fallback otherwise reads as a
    // working reranker.
    if (!warnedOnFallback) {
      warnedOnFallback = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[hippo] cross-encoder reranker unavailable (no Transformers.js backend, or model fetch blocked); falling back to identity ordering. Subsequent calls will not repeat this warning.',
      );
    }
    return head.map((r, i) => ({
      ...r,
      rerankScore: r.score,
      preRerankRank: r.preRerankRank ?? i + 1,
      postRerankRank: i + 1,
    }));
  }

  const scored = await Promise.all(
    head.map(async (r, i) => {
      let ceScore: number;
      try {
        ceScore = await pipe(query, r.entry.content);
      } catch {
        // One bad inference must not sink the whole pass.
        ceScore = r.score;
      }
      return {
        ...r,
        rerankScore: ceScore,
        preRerankRank: r.preRerankRank ?? i + 1,
        postRerankRank: 0,
      };
    }),
  );

  // Plain stable sort on purpose: tied scores MUST fall back to the prior
  // relevance order, never an arbitrary content order.
  scored.sort((a, b) => b.rerankScore - a.rerankScore);
  scored.forEach((r, i) => (r.postRerankRank = i + 1));
  return scored;
};
