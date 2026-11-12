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
    lead: 'Your corrections, remembered by',
    accent: 'Claude Code, Codex and Cursor',
    summary:
      'Hippo is open-source memory that runs on your machine and gives the rules it captured back to the agent when a new session starts. In our Claude Code test on 29 repositories, adding it to built-in memory cut repeat mistakes from 21 in 100 to 11, at the same cost.',
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
    jevEval: `${REPO}/blob/master/docs/evals/2026-09-19-jev-reranker.md`,
    z0Round3: `${REPO}/blob/master/docs/evals/2026-11-08-z0-round3-result.md`,
    locomoScore: `${REPO}/blob/master/benchmarks/public/results/2026-11-12-answer-accuracy/locomo-h2h-emb.txt`,
    dmrScore: `${REPO}/blob/master/benchmarks/public/results/2026-11-12-answer-accuracy/dmr-emb.txt`,
    storeCalls: `${REPO}/blob/master/benchmarks/public/results/2026-11-12-answer-accuracy/mem0-locomo-ingest-gate.json`,
    // Pilot requests open a GitHub issue until a booking link exists.
    pilot: `${REPO}/issues/new?title=Pilot%20request&body=Company%2C%20team%20size%2C%20agents%20in%20use%3A`,
    security: `${REPO}/blob/master/SECURITY.md`,
  },
} as const;

// Three wins, each quoting only numbers its linked file holds (check-readme-sync.mjs); the Z0 caveat sits in theTest.
export const proofs: ReadonlyArray<{ stat: string; text: string; href: string; hrefLabel: string }> = [
  {
    stat: '11 in 100',
    text: "Repeat mistakes 2 to 4 tasks after a correction, with hippo added to Claude Code's built-in memory. Built-in memory alone gave 21, in our test on 29 repositories.",
    href: site.links.z0Round3,
    hrefLabel: 'the Z0 round 3 result',
  },
  {
    stat: '+11.7 points',
    text: 'Answer accuracy over BM25 keyword search on DMR, a public memory test. Hippo with its optional local embedder scored 73.1% against 61.4%, with the same answer model.',
    href: site.links.dmrScore,
    hrefLabel: 'the DMR score file',
  },
  {
    stat: '0 language-model calls',
    text: 'To store the LoCoMo test conversations. Mem0 made 5,882 to store the same ones, one for each turn.',
    href: site.links.storeCalls,
    hrefLabel: 'the Mem0 store-call log',
  },
];

// The hero figure's two captions follow the scene; the still shows Tuesday. Wording follows session.body.
export const heroScene = {
  alt: 'An oak card cabinet with its rules drawer open. An index card above it reads "we use pnpm, never npm".',
  days: [
    { key: 'monday', day: 'Monday', text: 'You tell Claude Code "we use pnpm, never npm". Hippo files the rule.' },
    { key: 'tuesday', day: 'Tuesday', text: 'A new session opens with the rule printed in, before your first prompt.' },
  ],
} as const;

// README.md line 32, "Works with".
export const worksWith = ['Claude Code', 'Codex', 'Cursor', 'OpenClaw', 'OpenCode', 'Pi', 'any MCP client'] as const;

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
  body: 'We built hippo and we ran this test, so weigh it accordingly. In real Claude Code sessions on 29 repositories, each run teaches the agent a rule, as a correction where it had just got the task wrong, and 2 to 4 tasks later gives it a task where the same mistake is possible. The plan and its pass line were registered before the run.',
  note: "The arm with hippo cost the same, a ratio of 1.006. The gain was the same with lesson capture switched off, so this run cannot say hippo's stored lessons caused it, and round 4 makes that comparison its main one. A memory that always held the taught rule scored 7 in 100, about 4 points better than hippo. The corrections were scripted and the agent was Claude Code only, so we have no measured result for Codex or Cursor.",
  linkLabel: 'Read the full result',
} as const;

// The home session story: the terminal lines split at each note into Monday and Tuesday.
export const session = {
  heading: 'Correct it once, on Monday',
  body: 'On Monday you tell Claude Code "we use pnpm, never npm". On Tuesday a SessionStart hook prints the captured rule into the new session, before your first prompt.',
} as const;

// The home summary of the public tests; rows come from data/public-benchmarks.json, and the first two losses below sit under them.
export const publicTests = {
  heading: 'On public question-answering tests',
  body: 'These tests ask questions about long conversations, a different job from stopping a repeated mistake, so we show them as supporting evidence. Within each test, every system we ran used the same answer model and the same scorer, and hippo ran with its optional local embedder.',
  linkLabel: 'Every result, and where hippo lost',
} as const;

// The two public-test losses, shown under the home table; /benchmarks/ lists the rest in its own words.
export const losses = {
  items: [
    { text: "On LoCoMo, a public test of questions about long conversations, Mem0 scored 94.9 to hippo's 89.4.", href: site.links.locomoScore },
    { text: 'Handing the model the whole chat beat hippo by 10.5 points on another public test, 83.6 to 73.1.', href: site.links.dmrScore },
  ],
} as const;

// Markdown in each text, rendered with mdInline. Commands are shown as typed.
export const how = {
  heading: 'What hippo does between sessions',
  intro: 'Hippo is a command-line tool, a set of agent hooks and a SQLite file in your project. The hooks do the routine work, and every memory they store is one you can read, correct or replace.',
  items: [
    {
      title: 'What hippo keeps',
      text: "When a Claude Code session ends, the `SessionEnd` hook checks your last 20 messages and the agent's last 10 against word patterns for decisions, rules, errors and preferences. A turn of yours with a rule word such as never, always or must is pinned as a rule, and a rule phrased another way can be missed. The `PostToolUseFailure` hook stores a failed tool call as an error memory, skipping interrupts, declined permissions and repeats. For anything the patterns missed, one command stores it by hand.",
      command: 'hippo remember "we use pnpm, never npm" --pin',
    },
    {
      title: 'What the agent sees',
      text: 'In Claude Code, a `SessionStart` hook prints the rules hippo captured from you under the heading `## Rules from the user`. On each prompt, the `UserPromptSubmit` hook adds your pinned memories and up to 5 memories that share words with the prompt, and it skips the pinned block when nothing in it has changed. In our test that prompt block came to about 389 tokens a session.',
      command: 'hippo recall "why did the deploy break" --why',
    },
    {
      title: 'Correcting a memory',
      text: '`hippo outcome --bad` weakens every memory from the last recall, so a memory that keeps misleading the agent sinks down the results. `hippo supersede` stores the new version of a fact and links the old one to it, and the old one leaves recall and stays on record. On a synthetic test where every mark was correct, a bad mark cut how often a wrong memory stayed in the top five from 71.9% to 0.0%, and real marks are noisier.',
      command: 'hippo supersede mem_a1b2c3 "billing moved to bun"',
    },
    {
      title: 'What fades',
      text: 'An ordinary memory has a 365-day half-life, and each recall lengthens it by 2 days, so the memories your agent keeps recalling fade more slowly. An error memory starts at 730 days and a pinned memory never fades. `hippo sleep` moves a memory that has faded below the threshold to a dormant store, and `hippo dormant restore <id>` brings it back. On our short synthetic test decay made no measurable difference to recall.',
      command: '',
    },
    {
      title: 'One command, six agents',
      text: "`hippo init` creates a `.hippo/` store in the project and sets up the agents it detects. Claude Code gets hooks for session start and end, each prompt, compaction and failed tool calls. Codex gets two hooks that run once you trust them in `/hooks`, Cursor and Pi read hippo's block in an existing `AGENTS.md`, and any MCP client can run `hippo mcp` for 13 memory tools. Installing the package alone captures nothing, and what runs after init depends on the agent.",
      command: 'hippo init',
    },
  ],
  linkLabel: 'How each part works',
} as const;

// Sources for each section are in the 12 Nov home deck v3.
export const problem = {
  heading: 'You have explained this before',
  intro: 'You already keep a CLAUDE.md, and the agent keeps notes of its own. A new session can still repeat a mistake you corrected last week, and in our test Claude Code with its built-in memory did so 21 times in 100.',
  items: [
    {
      title: 'The same rule, every morning',
      text: 'You tell the agent "we use pnpm, never npm", and it runs `pnpm add`. The next day a new session runs `npm install` and leaves a `package-lock.json` beside your `pnpm-lock.yaml`. You type the same sentence again.',
    },
    {
      title: 'A correction buried in a transcript',
      text: 'The agent mocks the database in a test, you tell it this project tests against a real one, and it rewrites the test. The correction is still on disk, in a transcript no later session reads. The next session writes the mock again.',
    },
    {
      title: 'A CLAUDE.md nobody prunes',
      text: "CLAUDE.md is the right place for build commands and code style. Six months on it also holds a note about a migration that finished in the spring and two rules that disagree. Claude Code's memory docs say that when two rules contradict each other, Claude may pick one arbitrarily.",
    },
    {
      title: 'The same failed command, again',
      text: "The agent runs bare `pytest`, the run fails because this project needs `uv run pytest`, and two attempts later it has the right command. Next week a new session starts with bare `pytest`. The failure sits in last week's transcript, and nothing puts it in front of the agent before it types the command.",
    },
  ],
} as const;

export const different = {
  heading: 'No language model writes your memories by default',
  intro: "Mem0 uses a language model to extract memories. Hippo's default capture matches word patterns, which costs nothing to run and misses rules phrased in other ways. Storing the LoCoMo test conversations took Mem0 5,882 language-model calls and hippo none.",
  items: [
    {
      title: 'Stored without a model call',
      text: "A memory is a row in SQLite, written by word patterns, hooks and the command line. Search is BM25 keyword ranking out of the box, with no model and no network call, and a local embedder is an optional install. On the same LoCoMo test Mem0's answers scored 94.9% and hippo's 89.4%, a comparison of the two whole systems.",
    },
    {
      title: 'Files you can read and commit',
      text: 'The store is `.hippo/hippo.db` in each project, with a global store in `~/.hippo/`. Hippo writes a markdown mirror after each change, so a memory can be read, found with grep and reviewed in a pull request. `hippo recall --why` shows which words matched for each memory it returns.',
    },
    {
      title: 'Local, with a named list of exceptions',
      text: 'Hippo needs no account and no API key, and recall makes no network call by default. Text goes to an outside provider only through an API embedder, an API reranker, `hippo refine`, model-read rule capture, or `hippo sleep` when `ANTHROPIC_API_KEY` is set. The first four are off until you turn them on, and `{"extraction":{"enabled":false}}` in `.hippo/config.json` switches the last one off.',
    },
    {
      title: 'One store behind every agent',
      text: 'Claude Code, Codex and Cursor read the same `.hippo/` store in a project, so what one agent was told is there for the others. Hippo also imports the notes that Claude Code, Codex, Gemini CLI and three other tools keep for themselves, and the import never changes those notes. The memory text it adds to a prompt is paid for as input tokens, and in our test the arm with hippo cost the same as the arm without, a ratio of 1.006.',
    },
  ],
} as const;

export const teams = {
  heading: 'For a team that runs more than one agent',
  intro: 'Your developers use different agents, and each agent keeps its own notes in its own format. Hippo gives the agents on each machine one store, in files your team can read.',
  items: [
    {
      title: 'The same rules for every agent',
      text: "On a developer's machine, Claude Code, Codex and Cursor read the same `.hippo/` store in the project. Commit the markdown mirrors and the rules your agents work to can be reviewed beside the code. Slack and GitHub connectors bring in what the team has already written down.",
    },
    {
      title: 'What you can run today',
      text: 'The MIT core includes an HTTP server with tenants, API keys, admin and member roles, per-key scope grants and an audit log on every change. Keys are stored scrypt-hashed, and one API call deletes a memory. SSO, SCIM, SIEM export, a hosted service and an SLA are on the plan for the commercial edition, and none of it is released.',
    },
    {
      title: 'A pilot measured on your work',
      text: 'We have no team result to show. The fair test is a holdout, where a random share of sessions runs without memory and you compare cost per merged PR and repeat errors between the two groups. Hippo\'s holdout withholds memories from the hooks, while `hippo recall` and the MCP tools stay open, so a pilot has to account for those. Open a pilot request with your team size and the agents you use.',
    },
  ],
  ctaLabel: 'What teams can run today',
} as const;

// The README "MCP Server" config block, shown on /cursor/ and /mcp/.
export const mcpJson = ['{', '  "mcpServers": {', '    "hippo-memory": {', '      "command": "hippo",', '      "args": ["mcp"]', '    }', '  }', '}'];

// Markdown. Sources: README FAQ 11 and the local-first section.
export const localFirst = {
  heading: 'Stored on your machine, and what can leave it',
  body: 'Memories live in SQLite, in `.hippo/hippo.db` in each project and a global store in `~/.hippo/`, with markdown mirrors you can read, grep and commit. The package has zero runtime dependencies. Recall makes no network call by default. Text leaves your machine only if you turn on an API embedder, a reranker or model-read rule capture, run `hippo refine`, or have `ANTHROPIC_API_KEY` set when `hippo sleep` runs, and one config line switches that last one off.',
} as const;

// Markdown; `links` keeps the three vs links on the site instead of sending them to GitHub.
export const compare = {
  heading: 'Who should use something else',
  body: "Hippo is for coding agents on machines you control. [Mem0](/vs/mem0/) fits better when the memory belongs to your app's end users, [Zep](/vs/zep/) when you want a managed knowledge graph built from business data, and [Letta Code](/vs/letta/) when you want an agent that edits its own memory.",
  links: { '/vs/mem0/': '/vs/mem0/', '/vs/zep/': '/vs/zep/', '/vs/letta/': '/vs/letta/' },
} as const;

// README.md's Comparison table, parsed at build by readme.ts; the vs pages show their rows of it.
export const comparison = readmeComparison;

// check-readme-sync.mjs holds `notice` to README and llms.txt.
export const getStarted = {
  heading: 'Try it on the repository you have open',
  body: "`hippo init` creates the project's store, sets up the agents it detects and schedules a daily 6:15am run, and `--no-hooks` and `--no-schedule` skip those parts. `hippo doctor` checks Node, the store and the agent hooks, and each problem it finds names its fix. If hippo misses a rule you expected it to keep, open an issue with an example.",
  notice: 'Installing the package alone captures nothing, and what runs after init depends on the agent.',
  steps: [site.installCmd, 'hippo init'],
  askLabel: 'Or have your agent read about it first',
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
