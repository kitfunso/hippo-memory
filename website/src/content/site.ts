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
  body: 'Most memory systems save everything and search later. Hippo takes the opposite stance: memories decay unless they prove useful. One take among several in a fast-moving category.',
  rows: [
    { feature: 'Decay by default', hippo: true, others: false },
    { feature: 'Retrieval strengthening', hippo: true, others: false },
    { feature: 'Outcome-weighted half-lives', hippo: true, others: false },
    { feature: 'Confidence tiers + provenance', hippo: true, others: false },
    { feature: 'Zero runtime dependencies', hippo: true, others: false },
  ],
  // Honest framing: "others" = the dominant "save everything, search later" pattern,
  // NOT a named-competitor takedown. Full nuanced table lives in the README.
  fullTableHref: `${REPO}#comparison`,
} as const;
