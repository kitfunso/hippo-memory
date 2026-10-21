// First-class object verbs for processes, policies and skills.

import { policiesInForce, skillsExport } from '../../api/objects/object-kinds.js';
import type { Context } from '../../api/types.js';
import type { Policy, Process, Skill } from '../../base/records/object-types.js';
import { flagValueless, nonEmptyStringFlag, repeatedFlag, type CliFlags } from './flag-values.js';
import { errorMessage } from '../../base/util/log.js';
import { fail } from './exit.js';
import { requiredText, versionedVerbs, type VersionedKind } from './versioned-verbs.js';

// A value-less --step errors; repeated and single values both come back as a list.
function collectProcessSteps(flags: CliFlags): string[] {
  if (flagValueless(flags, 'step')) {
    fail('--step requires a value, e.g. hippo process new "<name>" --step "do X".');
  }
  return repeatedFlag(flags, 'step');
}

function printProcessRow(proc: Process): void {
  console.log(
    `#${proc.id} [${proc.status}] v${proc.version} steps=${proc.steps.length} memory=${proc.memoryId ?? '-'}`,
  );
  console.log(`    ${proc.processName}`);
  if (proc.changeSummary) console.log(`    change: ${proc.changeSummary}`);
}

interface ProcessBody {
  readonly steps: string[];
  readonly description: string | undefined;
}

const processKind: VersionedKind<'process', ProcessBody> = {
  kind: 'process',
  names: { cmd: 'process', noun: 'Process', idLabel: 'process' },
  plural: 'processes',
  usage: [
    'Usage: hippo process new "<name>" --step "<text>" [--step ...] [--description "<text>"]',
    '       hippo process list [--status active|superseded|closed|all] [--limit N]',
    '       hippo process get <id>',
    '       hippo process supersede <id> --step "<text>" [--change "<summary>"]',
    '       hippo process close <id>',
  ],
  supersedeUsage:
    'Usage: hippo process supersede <id> --step "<text>" [--step ...] [--change "<summary>"] [--description "<text>"]',
  bodyRequired: 'at least one --step "<text>"',
  body: (flags, verb) => {
    const steps = collectProcessSteps(flags);
    // A new process may start with no steps; a new version must say what its steps are.
    if (verb === 'supersede' && steps.length === 0) return undefined;
    return { steps, description: nonEmptyStringFlag(flags, 'description') };
  },
  keyOf: (proc) => proc.processName,
  write: (processName, body, from) => ({
    processName,
    ...body,
    changeSummary: from?.changeSummary,
    supersedesProcessId: from?.id,
  }),
  recorded: (proc) => `Process recorded: #${proc.id} (v${proc.version}, ${proc.steps.length} steps)`,
  printRow: printProcessRow,
  printDetail: (proc) => {
    console.log(`  name: ${proc.processName}`);
    console.log(`  status: ${proc.status}`);
    console.log(`  version: ${proc.version}`);
    if (proc.description) console.log(`  description: ${proc.description}`);
    if (proc.steps.length > 0) {
      console.log(`  steps:`);
      proc.steps.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
    }
  },
};

export const handleProcess = versionedVerbs(processKind);

const policyRange = (p: Policy): string => (p.validTo ? `${p.validFrom}..${p.validTo}` : `${p.validFrom}..(open)`);

function printPolicyRow(p: Policy): void {
  console.log(`#${p.id} [${p.status}] v${p.version} ${policyRange(p)} memory=${p.memoryId ?? '-'}`);
  console.log(`    ${p.policyName}: ${p.policyText}`);
  if (p.changeSummary) console.log(`    change: ${p.changeSummary}`);
}

async function policyAsOf(ctx: Context, args: string[], flags: CliFlags): Promise<void> {
  const dateRaw = args[1];
  if (!dateRaw) {
    fail('Usage: hippo policy asof <iso-date> [--name "<policy>"]');
  }
  const name = nonEmptyStringFlag(flags, 'name');
  let results;
  try {
    results = await policiesInForce(ctx, dateRaw, { name });
  } catch (e) {
    fail(errorMessage(e));
  }
  if (results.length === 0) {
    console.log(`No active policies in force at ${dateRaw}${name ? ` for "${name}"` : ''}.`);
    return;
  }
  console.log(`Policies in force at ${dateRaw}:\n`);
  for (const p of results) printPolicyRow(p);
}

interface PolicyBody {
  readonly policyText: string;
  readonly validFrom: string | undefined;
  readonly validTo: string | undefined;
}

const policyKind: VersionedKind<'policy', PolicyBody> = {
  kind: 'policy',
  names: { cmd: 'policy', noun: 'Policy', idLabel: 'policy' },
  plural: 'policies',
  usage: [
    'Usage: hippo policy new "<name>" --text "<rule>" [--from <iso>] [--to <iso>]',
    '       hippo policy list [--status active|superseded|closed|all] [--limit N]',
    '       hippo policy get <id>',
    '       hippo policy asof <iso-date> [--name "<policy>"]',
    '       hippo policy supersede <id> --text "<rule>" [--from] [--to] [--change "<summary>"]',
    '       hippo policy close <id>',
  ],
  supersedeUsage:
    'Usage: hippo policy supersede <id> --text "<rule>" [--from <iso>] [--to <iso>] [--change "<summary>"]',
  bodyRequired: '--text "<rule>"',
  body: (flags) => {
    const policyText = requiredText(flags, 'text');
    if (policyText === undefined) return undefined;
    return { policyText, validFrom: nonEmptyStringFlag(flags, 'from'), validTo: nonEmptyStringFlag(flags, 'to') };
  },
  keyOf: (p) => p.policyName,
  write: (policyName, body, from) => ({
    policyName,
    ...body,
    changeSummary: from?.changeSummary,
    supersedesPolicyId: from?.id,
  }),
  recorded: (p) => `Policy recorded: #${p.id} (v${p.version}, effective ${policyRange(p)})`,
  printRow: printPolicyRow,
  printDetail: (p) => {
    console.log(`  name: ${p.policyName}`);
    console.log(`  text: ${p.policyText}`);
    console.log(`  status: ${p.status}`);
    console.log(`  version: ${p.version}`);
    console.log(`  valid_from: ${p.validFrom}`);
    console.log(`  valid_to: ${p.validTo ?? '(open-ended)'}`);
  },
  extra: { sub: 'asof', run: policyAsOf },
};

export const handlePolicy = versionedVerbs(policyKind);

function printSkillRow(s: Skill): void {
  const trig = s.trigger ? ` when="${s.trigger}"` : '';
  console.log(`#${s.id} [${s.status}] v${s.version}${trig} memory=${s.memoryId ?? '-'}`);
  console.log(`    ${s.skillName}`);
  if (s.changeSummary) console.log(`    change: ${s.changeSummary}`);
}

async function skillExport(ctx: Context): Promise<void> {
  const md = await skillsExport(ctx);
  if (!md) {
    console.log('No active skills.');
    return;
  }
  console.log(md);
}

interface SkillBody {
  readonly instructions: string;
  readonly trigger: string | undefined;
}

const skillKind: VersionedKind<'skill', SkillBody> = {
  kind: 'skill',
  names: { cmd: 'skill', noun: 'Skill', idLabel: 'skill' },
  plural: 'skills',
  usage: [
    'Usage: hippo skill new "<name>" --instructions "<text>" [--trigger "<when>"]',
    '       hippo skill list [--status active|superseded|closed|all] [--limit N]',
    '       hippo skill get <id>',
    '       hippo skill export   (render active skills as an AGENTS.md/CLAUDE.md block)',
    '       hippo skill supersede <id> --instructions "<text>" [--trigger] [--change "<summary>"]',
    '       hippo skill close <id>',
  ],
  supersedeUsage:
    'Usage: hippo skill supersede <id> --instructions "<text>" [--trigger "<when>"] [--change "<summary>"]',
  bodyRequired: '--instructions "<text>"',
  body: (flags) => {
    const instructions = requiredText(flags, 'instructions');
    if (instructions === undefined) return undefined;
    return { instructions, trigger: nonEmptyStringFlag(flags, 'trigger') };
  },
  keyOf: (s) => s.skillName,
  write: (skillName, body, from) => ({
    skillName,
    ...body,
    changeSummary: from?.changeSummary,
    supersedesSkillId: from?.id,
  }),
  recorded: (s) => `Skill recorded: #${s.id} (v${s.version})`,
  printRow: printSkillRow,
  printDetail: (s) => {
    console.log(`  name: ${s.skillName}`);
    console.log(`  status: ${s.status}`);
    console.log(`  version: ${s.version}`);
    if (s.trigger) console.log(`  when: ${s.trigger}`);
    console.log(`  instructions: ${s.instructions}`);
  },
  extra: { sub: 'export', run: skillExport },
};

export const handleSkill = versionedVerbs(skillKind);
