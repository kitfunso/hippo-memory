// The MS-MARCO MiniLM cross-encoder from Transformers.js, behind the cross-encoder port the reranker scores through.
import type { CrossEncoderFn, CrossEncoderLoad } from '../base/ports/cross-encoder.js';
import { createModelLoads, importTransformers, MODEL_LOAD_POLICY } from './transformers.js';

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

// NOT the text-classification pipeline: this is a num_labels=1 regression head and that pipeline softmaxes a length-1
// logit vector (always 1.0). Read the logit, then squash it.
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
    // NaN would make the sort comparator a no-op; throwing hands this candidate to the per-candidate fallback instead.
    if (!Number.isFinite(score)) throw new Error('cross-encoder returned a non-finite score');
    return score;
  };
}

/** One model per loader, so each reranker built on one owns its model; a failure is answered from memory until the
 * backoff ends, and the reranker's outage warning reports it. */
export function transformersCrossEncoder(importModule: ImportModule = importTransformers): CrossEncoderLoad {
  const pipelines = createModelLoads<CrossEncoderFn>(MODEL_LOAD_POLICY);
  return () => pipelines.load(MODEL_NAME, () => buildPipeline(importModule));
}
