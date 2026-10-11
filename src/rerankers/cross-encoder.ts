import { createOutageWarning } from './outage-warning.js';
import type { RerankerFn, RerankResult, RerankerOptions } from './types.js';
import { compareScoresDesc } from '../core/compare.js';
import type { SearchResult } from '../core/search-types.js';
import { createModelLoads, importTransformers, MODEL_LOAD_POLICY } from '../embeddings/transformers.js';
import { errorFields, errorMessage, log } from '../util/log.js';

const DEFAULT_CROSS_ENCODER_TOP_K = 50;

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

type CrossEncoderFn = (query: string, candidate: string) => Promise<number>;
type ImportModule = () => Promise<{ readonly name: string; readonly mod: TransformersModuleNamespace } | null>;

async function importModelClasses(importModule: ImportModule): Promise<Required<TransformersExports>> {
  const imported = await importModule();
  if (!imported) throw new Error('no Transformers.js package is installed');
  const { name, mod } = imported;
  const tok = mod.AutoTokenizer ?? mod.default?.AutoTokenizer;
  const seq = mod.AutoModelForSequenceClassification ?? mod.default?.AutoModelForSequenceClassification;
  if (!tok || !seq) throw new Error(`${name} exports no AutoTokenizer or AutoModelForSequenceClassification`);
  return { AutoTokenizer: tok, AutoModelForSequenceClassification: seq };
}

// NOT the text-classification pipeline: this is a num_labels=1 regression head and that pipeline softmaxes a length-1 logit vector (always 1.0).
// Read the logit, then squash it.
async function buildPipeline(importModule: ImportModule): Promise<CrossEncoderFn> {
  const mod = await importModelClasses(importModule);
  const [tokenizer, model] = await Promise.all([
    mod.AutoTokenizer.from_pretrained(MODEL_NAME),
    mod.AutoModelForSequenceClassification.from_pretrained(MODEL_NAME),
  ]);
  return async (query: string, candidate: string) => {
    const inputs = await tokenizer(query, {
      text_pair: candidate,
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    const score = 1 / (1 + Math.exp(-Number(logits.data[0])));
    // NaN would make the sort comparator a no-op; throwing hands this
    // candidate to the per-candidate fallback instead.
    if (!Number.isFinite(score)) throw new Error('cross-encoder returned a non-finite score');
    return score;
  };
}

/** The head in its input order, scored as it came. */
function identityOrder(head: readonly SearchResult[]): RerankResult[] {
  return head.map((r, i) => ({
    ...r,
    rerankScore: r.score,
    preRerankRank: r.preRerankRank ?? i + 1,
    postRerankRank: i + 1,
  }));
}

async function scoreHead(pipe: CrossEncoderFn, query: string, head: readonly SearchResult[]): Promise<RerankResult[]> {
  const scored = await Promise.all(
    head.map(async (r, i) => {
      let ceScore: number;
      try {
        ceScore = await pipe(query, r.entry.content);
      } catch (err) {
        // One bad inference must not sink the whole pass.
        log.debug(`cross-encoder inference failed, keeping the base score: ${errorMessage(err)}`);
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
  scored.sort((a, b) => compareScoresDesc(a.rerankScore, b.rerankScore));
  scored.forEach((r, i) => (r.postRerankRank = i + 1));
  return scored;
}

/** Track 2 reranker: MS-MARCO MiniLM cross-encoder, identity fallback if the model will not load. Each instance owns its model and outage warning. */
export function createCrossEncoderReranker(importModule: ImportModule = importTransformers): RerankerFn {
  const outage = createOutageWarning('cross-encoder', 'falling back to identity ordering');
  // The outage warning already says each failure, at most once per window, so the loads report nothing themselves.
  const pipelines = createModelLoads<CrossEncoderFn>(MODEL_LOAD_POLICY);
  return async (query, results, options?: RerankerOptions): Promise<RerankResult[]> => {
    const head = results.slice(0, options?.topK ?? DEFAULT_CROSS_ENCODER_TOP_K);
    let pipe: CrossEncoderFn;
    try {
      // One shared load per backoff window: two first calls fetch the model once, and a failure is not fetched again on every recall.
      pipe = await pipelines.load(MODEL_NAME, () => buildPipeline(importModule));
    } catch (err) {
      // A silent identity fallback otherwise reads as a working reranker.
      outage.failed(errorMessage(err), errorFields(err));
      return identityOrder(head);
    }
    outage.answered();
    return scoreHead(pipe, query, head);
  };
}
