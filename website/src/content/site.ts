/**
 * Single source of truth for all landing-page copy + claims.
 * EVERY number/claim here is verified against ../../README.md + package.json
 * (audit 2026-06-01). The sequential-learning "78% -> 14%" magnitude is RETRACTED
 * (README v1.7.9) and is deliberately ABSENT. Edit copy here, not in components.
 */

export const REPO = 'https://github.com/kitfunso/hippo-memory';

export const site = {
  name: 'hippo',
  pkg: 'hippo-memory',
  version: '1.15.0', // package.json
  // README headline tagline, split for gradient emphasis on the verb.
  tagline: { lead: 'Know what to', accent: 'forget.' },
  // README line 12 (verbatim intent).
  description:
    'A memory layer for AI agents, modeled on the hippocampus. Decay by default, strength through use, provenance on every memory.',
  installCmd: 'npm install -g hippo-memory',
  initCmd: 'hippo init --scan ~',
  links: {
    repo: REPO,
    npm: 'https://www.npmjs.com/package/hippo-memory',
    docs: `${REPO}#readme`,
    changelog: `${REPO}/blob/master/CHANGELOG.md`,
    benchmarks: `${REPO}/tree/master/benchmarks`,
    longmemeval: `${REPO}/tree/master/benchmarks/longmemeval`,
    license: `${REPO}/blob/master/LICENSE`,
  },
} as const;

export const nav = [
  { label: 'How it works', href: '#how' },
  { label: 'Receipts', href: '#receipts' },
  { label: 'Compare', href: '#compare' },
  { label: 'Docs', href: site.links.docs },
] as const;

/** Honest re-enactment of real `hippo` command output (README-grounded:
 *  --scan, --error -> 14d half-life + [verified], recall ranked w/ confidence + score). */
export const terminal: Array<{ kind: 'cmd' | 'ok' | 'out'; text: string; chip?: 'verified' | 'observed' }> = [
  { kind: 'cmd', text: 'npm install -g hippo-memory' },
  { kind: 'cmd', text: 'hippo init --scan ~' },
  { kind: 'ok', text: 'memory across every git repo under ~' },
  { kind: 'cmd', text: 'hippo remember "deploy failed: forgot migrations" --error' },
  { kind: 'out', text: 'stored · half-life 14d', chip: 'verified' },
  { kind: 'cmd', text: 'hippo recall "why did the deploy break"' },
  { kind: 'out', text: 'deploy failed: forgot migrations    0.91', chip: 'verified' },
  { kind: 'out', text: 'run migrations before release       0.74', chip: 'observed' },
];

export const problem = {
  kicker: 'The problem',
  heading: 'Most AI memory saves everything and searches later.',
  body: [
    "That's storage with semantic search bolted on. It's why your agent kept hitting the same deploy bug last week. And the week before.",
    'The system saw the failure four times. It had no way to know it should remember.',
  ],
  // README "Why this exists"
} as const;

export const mechanics = [
  {
    title: 'Decay by default',
    metric: '7d half-life',
    body: 'Every memory fades on a 7-day half-life. Persistence is earned, not assumed.',
  },
  {
    title: 'Retrieval strengthens',
    metric: '+2d / recall',
    body: 'Use it or lose it. Each recall extends the half-life. Memories you reach for learn to survive.',
  },
  {
    title: 'Errors stick',
    metric: '2x half-life',
    body: 'Tag a failure once. It decays slower and resurfaces every time you walk back into that code.',
  },
  {
    title: 'Sleep consolidates',
    metric: '3+ → 1',
    body: 'On `hippo sleep`, three or more related episodes merge into one semantic pattern. The originals decay; the pattern survives.',
  },
] as const;

export const receipts = [
  {
    stat: '74%',
    label: 'R@5 on LongMemEval',
    note: 'BM25 only, no embeddings. 73.8% with hybrid scoring (v0.28).',
    href: site.links.longmemeval,
  },
  {
    stat: '926',
    label: 'tests, real DB',
    note: 'Zero mocks. Project rule: no mocked dependencies in tests.',
    href: site.links.benchmarks,
  },
  {
    stat: '0',
    label: 'runtime deps',
    note: 'Node 22.5+. SQLite under the hood. Optional embeddings.',
    href: site.links.repo,
  },
  {
    stat: 'MIT',
    label: 'licensed',
    note: 'SQLite backbone with markdown mirrors. Git-trackable, human-readable.',
    href: site.links.license,
  },
] as const;

export const worksWith = ['Claude Code', 'Codex', 'Cursor', 'OpenClaw', 'OpenCode', 'Pi', 'any MCP client'] as const;
export const importsFrom = ['ChatGPT', 'CLAUDE.md', '.cursorrules', 'Slack', 'markdown'] as const;

export const compare = {
  heading: 'Forget by default. Earn persistence through use.',
  body: "The AI-memory category matured fast in 2026. Hippo's take - bio-decay, strengthen-on-use, outcome-weighted half-lives - is one stance among several. The matrix below is a feature snapshot, not a verdict.",
  sourceHref: `${REPO}#comparison`,
} as const;

/** Full comparison matrix, reproduced VERBATIM from README.md (#comparison),
 *  including the asterisked "not directly comparable" benchmark caveats + footnotes.
 *  cells[] align to systems[] order (Hippo first). Edit the README + here together. */
export const comparison = {
  systems: [
    { name: 'Hippo', href: REPO, self: true },
    { name: 'MemPalace', href: 'https://github.com/milla-jovovich/mempalace', self: false },
    { name: 'Mem0', href: 'https://github.com/mem0ai/mem0', self: false },
    { name: 'Basic Memory', href: 'https://github.com/basicmachines-co/basic-memory', self: false },
    { name: 'gbrain', href: 'https://hermesatlas.com/projects/garrytan/gbrain', self: false },
    { name: 'Zep', href: 'https://www.getzep.com/', self: false },
    { name: 'Letta', href: 'https://github.com/letta-ai/letta', self: false },
    { name: 'Cognee', href: 'https://www.cognee.ai/', self: false },
    { name: 'Memoria', href: 'https://github.com/matrixorigin/Memoria', self: false },
    { name: 'EverMind', href: 'https://evermind.ai/', self: false },
  ],
  rows: [
    { feature: 'Decay by default', cells: ['Yes', 'No', 'No', 'No', 'No', 'No', 'No', 'No', 'No', 'No'] },
    { feature: 'Retrieval strengthening', cells: ['Yes', 'No', 'No', 'No', 'No', 'No', 'No', 'Partial (recall tuning)', 'No', 'Partial (Skill Memory distills patterns)'] },
    { feature: 'Reward-proportional decay', cells: ['Yes', 'No', 'No', 'No', 'No', 'No', 'No', 'No', 'No', 'No'] },
    { feature: 'Hybrid search (BM25 + embeddings)', cells: ['Yes', 'Embeddings + spatial', 'Embeddings only', 'No', 'Yes (vec + rerank + graph)', 'Yes (graph + vec)', '?', 'Yes (GraphRAG)', 'Yes (vector + full-text)', 'Yes (mRAG, multi-modal)'] },
    { feature: 'Schema acceleration / knowledge graph', cells: ['Yes (schema)', 'No', 'No', 'No', 'Yes (typed KG, self-wiring)', 'Yes (temporal KG)', 'No', 'Yes (auto-ontologies)', 'No (typed claims)', 'Yes (hierarchical: user/group/agent)'] },
    { feature: 'Conflict detection + resolution', cells: ['Yes', 'No', 'No', 'No', 'Yes (eval-surfaced)', 'Yes (auto-invalidate stale facts)', 'No', 'No', 'Yes (auto-detect + quarantine)', 'Partial (temporal tracking)'] },
    { feature: 'Multi-agent shared memory', cells: ['Yes', 'No', 'No', 'No', 'Yes (brain repo, team mounts)', 'Yes', 'No (single-agent state)', 'Yes', 'Yes (branch/merge across sessions)', 'Yes (multi-agent coordination)'] },
    { feature: 'Transfer scoring', cells: ['Yes', 'No', 'No', 'No', 'No', 'No', 'No', 'No', 'No', 'No'] },
    { feature: 'Outcome tracking', cells: ['Yes', 'No', 'No', 'No', 'No', 'No', 'No', 'No', 'No', 'Partial (Cases: agent trajectories)'] },
    { feature: 'Confidence tiers', cells: ['Yes', 'No', 'No', 'No', 'No (typed facts)', 'No', 'No', 'No', 'No', 'No'] },
    { feature: 'Spatial organization', cells: ['No', 'Yes (wings/halls/rooms)', 'No', 'No', 'No', 'No', 'No', 'No', 'No', 'No'] },
    { feature: 'Lossless compression', cells: ['No', 'Yes (AAAK, 30x)', 'No', 'No', 'No', 'No', 'No', 'No', 'No', 'No'] },
    { feature: 'Cross-tool import (ChatGPT/Claude/Cursor)', cells: ['Yes', 'No', 'No', 'No', 'Partial (data sources)', '?', 'No', 'Partial (28 data sources)', 'No (Git ops)', 'Partial (mRAG: PDFs/images/URLs)'] },
    { feature: 'Auto-hook install', cells: ['Yes', 'No', 'No', 'No', 'No', 'No', 'No', 'No', 'No', 'No'] },
    { feature: 'MCP server', cells: ['Yes', 'Yes', 'No', 'No', 'Yes (stdio + HTTP/OAuth)', 'Partial (managed)', 'Yes (via Letta Code)', 'Yes (first-party Claude/LangGraph)', 'Yes', '?'] },
    { feature: 'Zero runtime deps', cells: ['Yes', 'No (ChromaDB)', 'No', 'No', 'No (PGLite or PG+pgvector)', 'No (managed service)', 'No (Python deps)', 'No (Python deps)', 'Yes (single Rust binary)', 'No (managed + OSS)'] },
    { feature: 'LongMemEval (best published)', cells: ['86.8% R@5 (F13+F9, oracle*)', '96.6% raw / 100% reranked R@5', '~49-85% R@5', 'N/A', '97.6-97.9% R@5 (s_cleaned*)', 'N/A (LoCoMo 80.3%)', 'N/A', 'N/A', '88.78% overall accuracy w/ reader**', '83.00% overall** (LoCoMo 93.05%, HaluMem 93.04%)'] },
    { feature: 'Git-friendly', cells: ['Yes', 'No', 'No', 'Yes', 'Yes', 'No', 'No', 'No', 'Yes (Git is the model)', '?'] },
    { feature: 'Framework agnostic', cells: ['Yes', 'Yes', 'Partial', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Yes'] },
    { feature: 'License', cells: ['MIT', '(open)', 'Apache-2.0', '(open)', 'MIT', 'Apache-2.0 (community)', 'Apache-2.0', 'MIT (core)', 'Apache-2.0', 'Apache-2.0 (OSS) + cloud'] },
  ],
  footnotes: [
    "* Split-mismatched: Hippo's 86.8% is on longmemeval_oracle (3 sessions per haystack); gbrain's 97.6% is on longmemeval_s_cleaned (~40 sessions per haystack). Different splits, different difficulty. Not directly comparable.",
    "** Different metric: Memoria's 88.78% and EverMind's 83% are reported as overall accuracy with a reader LLM, not retrieval R@5. Higher denominator + LLM helps. Not directly comparable to retrieval-only R@5 numbers above.",
  ],
  closing:
    'Different tools answer different questions. Mem0 and Basic Memory implement "save everything, search later." MemPalace organizes spatially. gbrain, Zep, and Cognee extract typed entities into a knowledge graph. Letta lets the agent edit its own memory blocks. Memoria is Git-style version control over memory. EverMind is self-evolving Skill Memory. Hippo implements "forget by default, earn persistence through use." Complementary takes, not a single-axis ranking.',
} as const;
