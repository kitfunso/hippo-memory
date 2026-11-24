/** The two pretrained CLEF decision models served by Cloudflare Workers AI. */
export type ClefModel = 'clef-flash' | 'clef';

const CLEF_MODELS: readonly ClefModel[] = ['clef-flash', 'clef'];

/** True when `name` is one of the CLEF reranker names. */
export function isClefModel(name: string): name is ClefModel {
  return CLEF_MODELS.some((m) => m === name);
}

export const JEV_DEFAULT_TOP_K = 40;
