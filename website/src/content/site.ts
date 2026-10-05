/**
 * Single source of truth for all landing-page copy + claims.
 * EVERY number/claim here is verified against ../../README.md + package.json
 * (audit 2026-06-01). The sequential-learning "78% -> 14%" magnitude is RETRACTED
 * (README v1.7.9) and is deliberately ABSENT. Edit copy here, not in components.
 */

import pkg from '../../../package.json';
import { REPO, readmeComparison, readmeFaq } from './readme';

export { REPO };

// The sync check keeps these two README-shared lines on the site; they postdate the Sep 28 wording.
export const enterprise = {
  availability: 'The commercial edition is planned; its private repository is a scaffold, not a released enterprise product.',
} as const;

export const site = {
  name: 'hippo',
  pkg: 'hippo-memory',
  version: pkg.version, // Build-source version; publication is verified separately.
  positioning: pkg.description,
  tagline: {
    lead: 'Stop re‑teaching', // non-breaking hyphen keeps the word whole
    accent: 'your agent.',
    summary:
      "Make your agent's memory work like a brain. Hippo is long-term memory for coding agents. It's a critical layer for your AI harness that connects across your different tools (Cursor, Claude Code, Codex). It keeps your proprietary data completely local, and it actually learns over time. By strengthening memories each time they are recalled, Hippo preserves what works, lets mistakes decay, and continuously compounds your agents' intelligence.",
  },
  description: pkg.description,
  installCmd: 'npm install -g hippo-memory',
  initCmd: 'hippo init --scan ~',
  // A floor stays true as the suite grows; check-readme-sync.mjs holds README and llms.txt to it.
  tests: '3,500+',
  links: {
    repo: REPO,
    npm: 'https://www.npmjs.com/package/hippo-memory',
    docs: `${REPO}#readme`,
    changelog: `${REPO}/blob/master/CHANGELOG.md`,
    benchmarks: `${REPO}/tree/master/benchmarks`,
    longmemeval: `${REPO}/tree/master/benchmarks/longmemeval`,
    license: `${REPO}/blob/master/LICENSE`,
    jevEval: `${REPO}/blob/master/docs/evals/2026-09-19-jev-reranker.md`,
    atlas: 'https://neoneye.github.io/agent-memory-atlas/systems/hippo-memory/',
    // Pilot requests open a GitHub issue until a booking link exists.
    pilot: `${REPO}/issues/new?title=Pilot%20request&body=Company%2C%20team%20size%2C%20agents%20in%20use%3A`,
    security: `${REPO}/blob/master/SECURITY.md`,
  },
} as const;

// Hero proof lines, above the fold (audit: lead with capability proof, not adjectives).
// The reranker line carries its null result inline; the win never travels without it.
export const proofs = [
  { stat: '98.0% R@5', text: 'on LongMemEval-S with a free local embedder (best of five settings).' },
  {
    stat: 'R@1 0.41 to 0.62',
    text: 'with the opt-in Jev reranker, against the free local cross-encoder. Ranking only: no answer-rate win was shown.',
    href: site.links.jevEval,
    hrefLabel: 'the Jev reranker eval',
  },
] as const;

// Quickstart is the nav's install button, so it is not repeated here.
export const nav = [
  { label: 'How it works', href: '/how-it-works/' },
  { label: 'Teams', href: '/teams/' },
  { label: 'Benchmarks', href: '/benchmarks/' },
  { label: 'Compare', href: '/#compare' },
  { label: 'Docs', href: site.links.docs },
] as const;

/** An illustrated two-day Claude Code session with hippo's hooks; the hippo lines are shortened from what hippo prints.
 *  Kinds: note = day label, cmd = prompt, out = agent output, err = failed tool call, caught = hippo storing it,
 *  ok = hippo, mem = a memory in context. */
export const terminal: Array<{ kind: 'note' | 'cmd' | 'out' | 'err' | 'caught' | 'ok' | 'mem'; text: string }> = [
  { kind: 'note', text: 'Monday · billing-service' },
  { kind: 'cmd', text: 'add the refunds endpoint' },
  { kind: 'out', text: 'Bash(npm install stripe)' },
  { kind: 'err', text: 'lockfile is pnpm-lock.yaml; npm install would rewrite it' },
  { kind: 'caught', text: 'hippo · stored error memory (observed)' },
  { kind: 'note', text: 'Tuesday · new session' },
  { kind: 'cmd', text: 'add a webhook for failed payments' },
  { kind: 'ok', text: 'hippo · 2 memories in context' },
  { kind: 'mem', text: 'billing uses pnpm; never run npm install here' },
  { kind: 'out', text: 'Bash(pnpm add stripe)  ✓' },
  { kind: 'cmd', text: '/compact' },
  { kind: 'ok', text: 'Hippo saved your task snapshot before compacting.' },
];

/** The three commands under the hero. Sourced to README: the capture-error hook, `outcome --bad`, `doctor`. */
export const commands = [
  { cmd: 'hippo capture-error', body: 'Real failures become lessons. Interrupts, declined permissions and empty searches are skipped.' },
  { cmd: 'hippo outcome --bad', body: 'Mark a lesson wrong and it stops coming back.' },
  { cmd: 'hippo doctor', body: 'One command checks the install and names the fix for anything missing.' },
] as const;

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
    metric: '365d half-life',
    body: 'Every memory fades on a one-year half-life unless it is used. We did not tune 365 days: it tied with 730 days and with decay off.',
  },
  {
    title: 'Retrieval strengthens',
    metric: '+2d / recall',
    body: 'Use it or lose it. Each recall extends the half-life. Memories you reach for survive.',
  },
  {
    title: 'Errors stick',
    metric: '2x half-life',
    body: 'Tag a failure once. It decays slower and resurfaces every time you walk back into that code.',
  },
  {
    title: 'Sleep consolidates',
    metric: '3+ → 1',
    body: 'On `hippo sleep`, three or more related episodes merge into one semantic pattern. The originals decay; the pattern survives. It keeps the store tidy; it has not been shown to improve recall.',
  },
] as const;

export const receipts = [
  {
    stat: '98.0%',
    label: 'R@5 on LongMemEval-S',
    note: 'Any answer session in the top 5, per haystack, free local MiniLM (an optional install), best of five settings. Requiring every answer session: 86.8 to 88.5%. 99.8% with voyage-3-large (June 2026). BM25 only, older oracle split: 74.0%.',
    href: site.links.longmemeval,
  },
  {
    stat: '−6.0',
    tone: 'loss',
    label: 'points behind BM25, published',
    note: 'LoCoMo answer accuracy with the old 7-day default, in a Sonnet trial we registered first. The cause was the default; at 365 days the retrieval gap fell from 6.9 points to 1.0.',
    href: `${REPO}/blob/master/docs/evals/2026-09-24-public-benchmarks-sonnet-trial.md`,
  },
  {
    stat: site.tests,
    label: 'tests, real DB',
    note: 'No module mocks and no mocked store. Only paid network calls are stubbed.',
    href: site.links.benchmarks,
  },
  {
    stat: '0',
    label: 'runtime deps',
    note: 'Node 22.16+. SQLite under the hood. Optional embeddings.',
    href: site.links.repo,
  },
] as const;

export const worksWith = ['Claude Code', 'Codex', 'Cursor', 'OpenClaw', 'OpenCode', 'Pi', 'any MCP client'] as const;

/** The README's MCP config block ("MCP Server"), shown on /cursor/ and /mcp/. */
export const mcpJson = ['{', '  "mcpServers": {', '    "hippo-memory": {', '      "command": "hippo",', '      "args": ["mcp"]', '    }', '  }', '}'];
export const importsFrom = ['ChatGPT', 'CLAUDE.md', '.cursorrules', 'Slack', 'markdown'] as const;

export const compare = {
  heading: 'Learn what is wrong. Stop repeating it.',
  body: 'How hippo compares with nine other memory tools on the features that define a memory lifecycle.',
  sourceHref: `${REPO}#comparison`,
  sourceLabel: 'Every feature, with sources and check dates, on GitHub',
  scrollCue: 'scroll for more tools',
  // Short forms of the README footnotes; the long ones stay on GitHub and the vs pages.
  notes: [
    '* LongMemEval retrieval recall at 5. "Any" counts a hit when one answer session is in the top 5, "all" only when every one is. gbrain leads on "all".',
    '** Answer accuracy with a reader model, a different metric from recall.',
  ],
} as const;

/** README.md's Comparison table, parsed at build by readme.ts, plus the site's own closing line. */
export const comparison = {
  ...readmeComparison,
  closing: 'Most of the others save everything and search it later, or build a knowledge graph. Hippo learns what is wrong and stops repeating it.',
} as const;

/** Get started = quickstart + the zero-config auto-install differentiator. */
export const getStarted = {
  kicker: 'Get started',
  heading: 'Zero config. It wires itself in.',
  body: 'Install it, run init in your repo, and hippo detects your agent framework and patches the right config file. Next session, your agent just uses it.',
  notice: 'Package installation alone does not enable automatic preservation on every agent. Complete the documented setup and required host trust; capture and compaction coverage depend on the integration.',
  steps: [site.installCmd, 'hippo init'],
  autoInstall: {
    heading: 'Detected and patched automatically',
    frameworks: ['Claude Code', 'Codex', 'Cursor', 'OpenClaw', 'OpenCode', 'Pi'],
    note: 'In a repo, init patches the instruction file each agent already has (CLAUDE.md, AGENTS.md) and adds session hooks where the agent supports them. hippo init --scan ~ gives every git repo under your home folder a store and installs the Claude Code hooks and the OpenCode plugin, but patches no instruction files. hippo init --no-hooks --no-schedule skips the hooks and the daily run.',
  },
} as const;

/** Local-first / privacy. Every receipt sourced verbatim to README (L46/L57/L58). */
export const localFirst = {
  kicker: 'Local-first',
  points: [
    { stat: '0', label: 'outbound HTTP', body: 'Proven by a globalThis.fetch spy that throws on call, across the 1000-event ingestion smoke. Not a hardcoded zero. The default recall path makes no network call either; opt-in features such as the Jev reranker, the LLM reranker and the API embedders do.' },
    { stat: 'SQLite', label: 'on disk', body: 'Memories live in a local .hippo/ store with markdown mirrors you can read, grep, and commit. No cloud and no account. One default to know: hippo sleep sends text to Anthropic for fact extraction when ANTHROPIC_API_KEY is set, and one config line turns that off.' },
    { stat: '1 call', label: 'to forget', body: 'Right-to-be-forgotten is a single API call. Every row carries kind, scope, owner, and provenance.' },
    { stat: 'tenant-safe', label: 'by default', body: 'Multi-tenant keys are scrypt-hashed with an audit log on every mutation. Tenant A cannot see tenant B, proven by a negative test.' },
  ],
  portability: {
    heading: "And it's not locked to one tool.",
    body: "Your ChatGPT memories don't travel to Claude; your .cursorrules don't travel to Codex. Hippo is one store behind all of them.",
  },
} as const;

/** The README's FAQ word for word, so the site, GitHub and npm answer alike. Answers are markdown:
 *  render them with mdInline, or mdText for JSON-LD. */
export const faq = readmeFaq;

/** Picks FAQ entries by question and fails the build when one is missing, so a renamed README question cannot vanish quietly. */
export function faqPick(questions: readonly string[]) {
  return questions.map((q) => {
    const item = faq.find((f) => f.q === q);
    if (!item) throw new Error(`FAQ question not found: "${q}"`);
    return item;
  });
}
