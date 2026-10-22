// The hosted rerankers' names and pool size: recall sizes its pool from these, and their clients live in src/infra.

/** The two pretrained CLEF decision models served by Cloudflare Workers AI. */
export type ClefModel = 'clef-flash' | 'clef';

const CLEF_MODELS: readonly ClefModel[] = ['clef-flash', 'clef'];

/** True when `name` is one of the CLEF reranker names. */
export function isClefModel(name: string): name is ClefModel {
  return CLEF_MODELS.some((m) => m === name);
}

// The pool size the eval numbers were measured at.
export const JEV_DEFAULT_TOP_K = 40;
