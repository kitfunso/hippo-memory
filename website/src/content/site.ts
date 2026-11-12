// Site copy and claims, edited here and not in components. Sources sit beside each number or in the
// copy deck of 12 Nov 2026. The retracted "78% -> 14%" magnitude (docs/RETRACTION.md) stays out under any name.

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
  title: 'hippo: open-source memory for Claude Code, Codex and Cursor',
  // The default meta description and the JSON-LD description; package.json's line ships with npm releases.
  description:
    'Open-source memory for coding agents. In our own Claude Code test on 29 repositories, adding hippo to built-in memory cut repeat mistakes from 21 in 100 to 11, and the gain held with lesson capture off.',
  tagline: {
    lead: 'One memory for',
    accent: 'Claude Code, Codex and Cursor.',
    summary:
      "Hippo is open-source and runs on your machine. In our test on 29 repositories, adding it to Claude Code's built-in memory cut repeat mistakes from 21 in 100 to 11, at the same cost.",
  },
  installCmd: 'npm install -g hippo-memory',
  // A floor stays true as the suite grows; check-readme-sync.mjs holds README and llms.txt to it.
  tests: '3,500+',
  links: {
    repo: REPO,
    npm: 'https://www.npmjs.com/package/hippo-memory',
    docs: `${REPO}#readme`,
    changelog: `${REPO}/blob/master/CHANGELOG.md`,
    license: `${REPO}/blob/master/LICENSE`,
    evals: `${REPO}/blob/master/docs/evals/README.md`,
    jevEval: `${REPO}/blob/master/docs/evals/2026-09-19-jev-reranker.md`,
    z0Round3: `${REPO}/blob/master/docs/evals/2026-11-08-z0-round3-result.md`,
    locomoScore: `${REPO}/blob/master/benchmarks/public/results/2026-11-12-answer-accuracy/locomo-h2h-emb.txt`,
    dmrScore: `${REPO}/blob/master/benchmarks/public/results/2026-11-12-answer-accuracy/dmr-emb.txt`,
    mechanismAudit: `${REPO}/blob/master/docs/evals/2026-09-23-mechanism-audit-round2-result.md`,
    decayDefault: `${REPO}/blob/master/docs/evals/2026-09-24-decay-default-result.md`,
    // Pilot requests open a GitHub issue until a booking link exists.
    pilot: `${REPO}/issues/new?title=Pilot%20request&body=Company%2C%20team%20size%2C%20agents%20in%20use%3A`,
    security: `${REPO}/blob/master/SECURITY.md`,
  },
} as const;

// The Z0 cell keeps its lesson-capture caveat and one cell is a loss; check-readme-sync.mjs fails the build if either goes.
export const proofs: ReadonlyArray<{ stat: string; text: string; href: string; hrefLabel: string; tone?: 'loss' }> = [
  {
    stat: '11 repeats in 100',
    text: 'Against 21 with built-in memory alone, in our Claude Code test. Switching lesson capture off gave the same gain.',
    href: site.links.z0Round3,
    hrefLabel: 'the Z0 round 3 result',
  },
  {
    stat: 'Stored on your machine',
    text: 'SQLite, no account, and recall stays local. If ANTHROPIC_API_KEY is set, sleep sends text to Anthropic unless switched off.',
    href: '/faq/#where-does-hippo-keep-my-data',
    hrefLabel: 'where hippo keeps your data',
  },
  {
    stat: 'Mem0 94.9, hippo 89.4',
    text: 'Answers on LoCoMo, a public test of questions about long conversations. We ran both, and Mem0 won.',
    href: '/benchmarks/',
    hrefLabel: 'the benchmarks page',
    tone: 'loss',
  },
];

// Quickstart is the nav's install button, so it is not repeated here.
export const nav = [
  { label: 'How it works', href: '/how-it-works/' },
  { label: 'Teams', href: '/teams/' },
  { label: 'Benchmarks', href: '/benchmarks/' },
  { label: 'Compare', href: '/#compare' },
  { label: 'Docs', href: site.links.docs },
] as const;

// An illustrated session. The hippo lines copy USER_RULES_HEADING and userRuleLine in src/api/context/context-render.ts.
export const terminal: ReadonlyArray<{ kind: 'note' | 'cmd' | 'out' | 'hippo'; text: string }> = [
  { kind: 'note', text: 'Monday, billing-service' },
  { kind: 'cmd', text: 'add the refunds endpoint' },
  { kind: 'out', text: 'Bash(npm install stripe)' },
  { kind: 'cmd', text: 'we use pnpm, never npm, because the lockfile is pnpm-lock.yaml' },
  { kind: 'out', text: 'Bash(pnpm add stripe) ✓' },
  { kind: 'note', text: 'Tuesday, new session' },
  { kind: 'hippo', text: '## Rules from the user' },
  { kind: 'hippo', text: '- we use pnpm, never npm, because the lockfile is pnpm-lock.yaml' },
  { kind: 'cmd', text: 'add a webhook for failed payments' },
  { kind: 'out', text: 'Bash(pnpm install) ✓' },
];

// Every figure is in docs/evals/2026-11-08-z0-round3-result.md.
export const repeatMistakes = {
  unit: 'in 100',
  bars: [
    { name: 'No memory', rate: 83, lead: false },
    { name: "Claude Code's built-in memory", rate: 21, lead: false },
    { name: 'Built-in memory plus hippo', rate: 11, lead: true },
  ],
} as const;

export const theTest = {
  heading: 'We corrected Claude Code once and counted the repeats',
  body: 'We built hippo and we ran this test, so weigh it accordingly. In real Claude Code sessions on 29 repositories, each run corrects the agent once and then, 2 to 4 tasks later, gives it a task where the same mistake is possible.',
  note: "The arm with hippo cost the same, a ratio of 1.006. The gain was the same with lesson capture switched off, so we can't yet say why, and round 4 tests how much of it the stored lessons carry. The corrections were scripted and the agent was Claude Code only.",
  linkLabel: 'Read the full result',
} as const;

export const losses = {
  heading: 'Where hippo lost',
  items: [
    { text: "On LoCoMo, a public test of questions about long conversations, Mem0 scored 94.9 to hippo's 89.4.", href: site.links.locomoScore },
    { text: 'Handing the model the whole chat beat hippo by 10.5 points on another public test, 83.6 to 73.1.', href: site.links.dmrScore },
    { text: 'Sleep, the step that merges related memories, lowered recall by 3.6 points on one scorer.', href: site.links.mechanismAudit },
    { text: 'Decay made no measurable difference to recall on our short synthetic test.', href: site.links.decayDefault },
    { text: 'The paid Jev reranker, a model that reorders search results, improved ranking but showed no measurable gain in answers.', href: site.links.jevEval },
    { text: 'Seven smaller experiments failed or stalled, and one early headline number was retracted.', href: site.links.evals },
  ],
  moreLabel: 'All results',
} as const;

// Markdown, rendered with mdInline.
export const how = {
  heading: 'What hippo does between sessions',
  body: [
    'When you state a rule or a tool call fails, hippo keeps it.',
    'At the start of the next session your rules are printed back to the agent, and memories that match each prompt are added. In our test that came to about 389 tokens a session.',
    'When a memory turns out wrong, `hippo outcome --bad` pushes it down the ranking and `hippo supersede` replaces it. Unused memories fade on a 365-day half-life.',
    '`hippo init` sets this up for Claude Code, Codex, Cursor and three more agents, and any MCP client can use the server. What runs automatically differs by agent.',
  ],
  linkLabel: 'How each part works',
} as const;

// The README "MCP Server" config block, shown on /cursor/ and /mcp/.
export const mcpJson = ['{', '  "mcpServers": {', '    "hippo-memory": {', '      "command": "hippo",', '      "args": ["mcp"]', '    }', '  }', '}'];

// Markdown. Sources: README FAQ 11 and the local-first section.
export const localFirst = {
  heading: 'Stored on your machine, and what can leave it',
  body: 'Memories live in SQLite, in `.hippo/hippo.db` in each project and a global store in `~/.hippo/`, with markdown mirrors you can read, grep and commit. The package has zero runtime dependencies. Recall makes no network call by default. Text leaves your machine only if you turn on an API embedder or a reranker, run `hippo refine`, or have `ANTHROPIC_API_KEY` set when `hippo sleep` runs, and one config line switches that last one off.',
} as const;

// Markdown; `links` keeps the three vs links on the site instead of sending them to GitHub.
export const compare = {
  heading: 'Who should use something else',
  body: "Hippo is for one developer's coding agents on one machine. [Mem0](/vs/mem0/) fits better when the memory belongs to your app's end users, [Zep](/vs/zep/) when you want a managed knowledge graph built from business data, and [Letta Code](/vs/letta/) when you want an agent that edits its own memory.",
  links: { '/vs/mem0/': '/vs/mem0/', '/vs/zep/': '/vs/zep/', '/vs/letta/': '/vs/letta/' },
} as const;

// README.md's Comparison table, parsed at build by readme.ts; the vs pages show their rows of it.
export const comparison = readmeComparison;

// check-readme-sync.mjs holds `notice` to README and llms.txt.
export const getStarted = {
  heading: 'Try it on the repository you have open',
  body: "Run two commands, and `hippo doctor` will name anything that's missing. If hippo misses a rule you expected it to keep, open an issue with an example.",
  notice: 'Installing the package alone captures nothing, and what runs after init depends on the agent.',
  steps: [site.installCmd, 'hippo init'],
  askLabel: 'Or ask your agent first:',
  prompt:
    'Read https://hippo-memory.com/llms-full.txt and tell me if hippo-memory fits this repo, what it stores, and what it sends over the network.',
} as const;

// The README's FAQ word for word, so the site, GitHub and npm answer alike. Answers are markdown.
export const faq = readmeFaq;

// Fails the build when a picked question is missing, so a renamed README question cannot vanish quietly.
export function faqPick(questions: readonly string[]) {
  return questions.map((q) => {
    const item = faq.find((f) => f.q === q);
    if (!item) throw new Error(`FAQ question not found: "${q}"`);
    return item;
  });
}
