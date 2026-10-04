/**
 * Single source of truth for all landing-page copy + claims.
 * EVERY number/claim here is verified against ../../README.md + package.json
 * (audit 2026-06-01). The sequential-learning "78% -> 14%" magnitude is RETRACTED
 * (README v1.7.9) and is deliberately ABSENT. Edit copy here, not in components.
 */

import pkg from '../../../package.json';
import { REPO, readmeComparison, readmeFaq } from './readme';

export { REPO };

export const enterprise = {
  status: 'Planned commercial edition',
  availability: 'The commercial edition is planned; its private repository is a scaffold, not a released enterprise product.',
} as const;

export const site = {
  name: 'hippo',
  pkg: 'hippo-memory',
  version: pkg.version, // Build-source version; publication is verified separately.
  positioning: 'memory for AI agents that learns what is wrong', // page title and hero eyebrow
  // Hero headline, split for accent emphasis. The per-agent install detail lives in Get started.
  tagline: { lead: 'Stop re‑teaching', accent: 'your agent.' }, // non-breaking hyphen keeps the word whole
  description:
    "The mistake your agent made on Monday is a memory by Tuesday. Hippo plugs into Claude Code, Codex, Cursor and any MCP client, keeps what worked, drops what turned out to be wrong, and replaces facts that changed.",
  installCmd: 'npm install -g hippo-memory',
  initCmd: 'hippo init',
  // Every page that offers the scan states what it changes before the command.
  scanCmd: 'hippo init --scan ~',
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
    recallEval: `${REPO}/blob/master/docs/evals/2026-09-28-recall-cli-longmemeval-result.md`,
    atlas: 'https://neoneye.github.io/agent-memory-atlas/systems/hippo-memory/',
    // Pilot requests open a GitHub issue until a booking link exists.
    pilot: `${REPO}/issues/new?title=Pilot%20request&body=Company%2C%20team%20size%2C%20agents%20in%20use%3A`,
    security: `${REPO}/blob/master/SECURITY.md`,
  },
} as const;

// Hero proof lines, above the fold (audit: lead with capability proof, not adjectives).
// The reranker line carries its null result inline; the win never travels without it.
export const proofs = [
  {
    stat: '85.6% R@5',
    text: 'from hippo recall on LongMemEval-S, inside its default 4,000-token budget; 96.8% with the budget lifted.',
    href: site.links.recallEval,
    hrefLabel: 'the hippo recall eval',
  },
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

/** An illustrated two-day Claude Code session with hippo's hooks; the stored memory is the tool name plus the error text, as capture-error writes it (it prints nothing).
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
  { kind: 'mem', text: 'Bash: lockfile is pnpm-lock.yaml; npm install would rewrite it' },
  { kind: 'cmd', text: '/compact' },
  { kind: 'ok', text: 'Hippo saved 3 memories from this compaction and restored your task snapshot.' },
];

/** The three commands under the hero. Sourced to README: the capture-error hook, `outcome --bad`, `doctor`. */
export const commands = [
  { cmd: 'hippo capture-error', body: 'Failed tool calls are stored as error memories, word for word. Interrupts, declined permissions and empty searches are skipped.' },
  { cmd: 'hippo outcome --bad', body: 'Mark a lesson wrong and hippo ranks it down.' },
  { cmd: 'hippo doctor', body: 'One command checks the install and names the fix for anything missing.' },
] as const;

export const problem = {
  kicker: 'The problem',
  heading: 'Most AI memory saves everything and searches later.',
  body: [
    "That's storage with search on top. A note that turned out wrong ranks the same as one that held up, and an old fact sits beside the one that replaced it.",
    'Hippo records which memories were marked wrong or replaced. A wrong one ranks lower, and a replaced one leaves the results.',
  ],
  // README "Why this exists"
} as const;

export const mechanics = [
  {
    title: 'Decay by default',
    metric: '365d half-life',
    body: 'The default half-life is 365 days, and a memory fades unless it is used. We did not tune 365 days: it tied with 730 days and with decay off.',
  },
  {
    title: 'Retrieval strengthens',
    metric: '+2d / recall',
    body: 'Use it or lose it. Each recall extends the half-life. Memories you reach for survive.',
  },
  {
    title: 'Errors last longer',
    metric: '2x half-life',
    body: 'Tag a failure as an error and it gets twice the half-life, so a later recall that matches it can still find it.',
  },
  {
    title: 'Sleep consolidates',
    metric: '2+ → 1',
    body: 'On `hippo sleep`, two or more related episodes merge into one semantic memory. The originals decay; the merged memory survives. It keeps the store tidy, but in hippo\'s own audit it cost 3.6 points of LongMemEval recall.',
  },
] as const;

export const receipts = [
  {
    stat: '85.6%',
    label: 'R@5 from hippo recall, LongMemEval-S',
    note: "An answer session in the top 5 for 85.6% of the 500 questions, on a default install inside recall's 4,000-token budget. 87.6% with the optional MiniLM embedder; 96.8% with the budget lifted. The benchmark scripts' best of five settings reach 98.0%. BM25 only, older oracle split: 74.0%.",
    href: site.links.recallEval,
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
  heading: 'How hippo compares.',
  body: 'Where the data lives, what it runs on and what each tool has published, including the rows where another tool is stronger. Hippo\'s design bets, such as decay, are in a second table on GitHub.',
  sourceHref: `${REPO}#comparison`,
  sourceLabel: 'Both tables, all 10 tools, on GitHub',
  scrollCue: 'scroll for more tools',
  qualifierNote:
    'Verdicts are shortened for scanning; the qualifier behind each Yes, No or Partial is in the full tables.',
} as const;

/** README.md's Comparison table, parsed at build by readme.ts, plus the site's own closing line. */
export const comparison = {
  ...readmeComparison,
  closing:
    'Different tools answer different questions. Mem0 and Basic Memory implement "save everything, search later." MemPalace organizes spatially. gbrain, Zep, and Cognee extract typed entities into a knowledge graph. Letta lets the agent edit its own memory blocks. Memoria is Git-style version control over memory. EverMind is self-evolving Skill Memory. Hippo implements "learn what is wrong and rank it down."',
} as const;

/** Get started in one project, with everything hippo init changes (src/cli.ts cmdInit) listed above the command. */
export const getStarted = {
  kicker: 'Get started',
  heading: 'Start in one project.',
  body: 'Install it, then run init inside one repo. This is everything init changes on your machine.',
  notice: 'Package installation alone does not enable automatic preservation on every agent. Complete the documented setup and required host trust; capture and compaction coverage depend on the integration.',
  steps: [site.installCmd, site.initCmd],
  changes: [
    'A .hippo/ store in the project. On the first run it learns from the last 30 days of git history.',
    'A hippo block in the CLAUDE.md or AGENTS.md the project already has. It never creates either file.',
    'If the project uses Claude Code: 7 hook entries in ~/.claude/settings.json, for session start and end, each prompt, compaction and failed tool calls.',
    "If the project has AGENTS.md or .codex and Codex is installed: 2 hook entries in Codex's hooks.json, for each prompt and after a compaction. Codex runs them once you trust them in /hooks.",
    'If the project uses OpenCode: a plugin at ~/.config/opencode/plugins/hippo.ts.',
    "A daily run at 6:15am, through crontab on Linux and macOS or a scheduled task on Windows. It learns from each registered project's commits and runs hippo sleep there.",
    "On the first run, it imports the project's Claude Code auto memory, from its folder under ~/.claude/projects/.",
  ],
  skip: 'To leave a part out: --no-hooks skips the block and the hooks, --no-schedule the daily run, --no-learn both imports.',
} as const;

/** Local-first / privacy. Every receipt sourced verbatim to README (L46/L57/L58). */
export const localFirst = {
  kicker: 'Local-first',
  points: [
    { stat: '0', label: 'outbound HTTP', body: 'Proven by a globalThis.fetch spy that throws on call, across the 1000-event ingestion smoke. Not a hardcoded zero. The default recall path makes no network call either; opt-in features such as the Jev reranker, the LLM reranker and the API embedders do.' },
    { stat: 'SQLite', label: 'on disk', body: 'Memories live in a local .hippo/ store with markdown mirrors you can read, grep, and commit. No cloud and no account. One default to know: hippo sleep sends text to Anthropic for fact extraction when ANTHROPIC_API_KEY is set. Sleep runs at every Claude Code session end and in the daily job, so it happens without you asking. One config line turns that off.' },
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
