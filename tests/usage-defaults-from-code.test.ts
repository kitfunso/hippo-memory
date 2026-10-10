// Help text must print the defaults the code uses, so a changed constant cannot leave the help lying.

import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/cli/verbs.js';
import { DEFAULT_KEY_TTL_DAYS, MAX_TTL_DAYS } from '../src/api/auth.js';
import { DEFAULT_GRAPH_HOPS, DEFAULT_GRAPH_SEED_COUNT } from '../src/graph/stream.js';
import { DEFAULT_EMBEDDING_WEIGHT, DEFAULT_MMR_LAMBDA } from '../src/search/hybrid.js';

const help = (verb: keyof typeof COMMANDS): string => (COMMANDS[verb].usage ?? []).join('\n');

describe('help text defaults', () => {
  it('prints the embedding weight and MMR lambda the search uses', () => {
    expect(help('eval')).toContain(`--embedding-weight <f> Override cosine weight (default: ${DEFAULT_EMBEDDING_WEIGHT})`);
    expect(help('recall')).toContain(`MMR balance 0..1 (default: ${DEFAULT_MMR_LAMBDA},`);
    expect(help('explain')).toContain(`MMR balance 0..1 (default: ${DEFAULT_MMR_LAMBDA},`);
  });

  it('prints the graph stream and key lifetime defaults', () => {
    expect(help('recall')).toContain(`(1..3, default ${DEFAULT_GRAPH_HOPS})`);
    expect(help('recall')).toContain(`(default ${DEFAULT_GRAPH_SEED_COUNT}). The stream`);
    expect(help('auth')).toContain(`(default: ${DEFAULT_KEY_TTL_DAYS}, at most ${MAX_TTL_DAYS})`);
  });
});
