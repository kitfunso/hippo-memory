// The cross-encoder port: the reranker scores pairs with the model a root hands it; src/infra/cross-encoder.ts loads
// it.

/** A query and one candidate in, a relevance score in [0, 1] out; throws when that pair cannot be scored. */
export type CrossEncoderFn = (query: string, candidate: string) => Promise<number>;

/** The loaded model, or why it did not load; calls inside one backoff window share a load and its failure. */
export type CrossEncoderLoad = () => Promise<CrossEncoderFn>;
