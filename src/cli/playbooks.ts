// First-class object verbs for processes, policies and skills.

import { extractPathTags } from '../search/path-context.js';
import * as processesModule from '../objects/processes.js';
import * as policiesModule from '../objects/policies.js';
import * as skillsModule from '../objects/skills.js';
import { printError } from './output.js';
import { isStringFlag, nonEmptyStringFlag, stringFlag, type CliFlags, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { closeObject, foundOrExit, idArgOrExit, listObjects, printLifecycleTail, type ObjectNames } from './object-verbs.js';
import { errorMessage } from '../util/log.js';

const PROCESS: ObjectNames = { cmd: 'process', noun: 'Process', idLabel: 'process' };
const POLICY: ObjectNames = { cmd: 'policy', noun: 'Policy', idLabel: 'policy' };
const SKILL: ObjectNames = { cmd: 'skill', noun: 'Skill', idLabel: 'skill' };

// --step is a repeatable flag (collected into an array by parseArgs). A single
// --step yields a string; normalize both to string[]. A value-less --step errors.
function collectProcessSteps(stepRaw: string | boolean | string[] | undefined): string[] {
  if (Array.isArray(stepRaw)) return stepRaw;
  if (isStringFlag(stepRaw)) return [stepRaw];
  if (stepRaw === true) {
    printError('--step requires a value, e.g. hippo process new "<name>" --step "do X".');
    process.exit(1);
  }
  return [];
}

function printProcessRow(proc: processesModule.Process): void {
  console.log(`#${proc.id} [${proc.status}] v${proc.version} steps=${proc.steps.length} memory=${proc.memoryId ?? '-'}`);
  console.log(`    ${proc.processName}`);
  if (proc.changeSummary) console.log(`    change: ${proc.changeSummary}`);
}

function processList(hippoRoot: string, tenantId: string, flags: CliFlags): void {
  listObjects(flags, {
    plural: 'processes',
    states: processesModule.VALID_PROCESS_STATES,
    load: (opts) => processesModule.loadProcesses(hippoRoot, tenantId, opts),
    printRow: printProcessRow,
  });
}

function processGet(hippoRoot: string, tenantId: string, args: string[]): void {
  const id = idArgOrExit(args, 'Usage: hippo process get <id>', PROCESS.idLabel);
  const proc = foundOrExit(processesModule.loadProcessById(hippoRoot, tenantId, id), PROCESS.noun, id);
  console.log(`Process #${proc.id}`);
  console.log(`  name: ${proc.processName}`);
  console.log(`  status: ${proc.status}`);
  console.log(`  version: ${proc.version}`);
  if (proc.description) console.log(`  description: ${proc.description}`);
  if (proc.steps.length > 0) {
    console.log(`  steps:`);
    proc.steps.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
  }
  printLifecycleTail(proc);
}

function processSupersede(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const id = idArgOrExit(args, 'Usage: hippo process supersede <id> --step "<text>" [--step ...] [--change "<summary>"] [--description "<text>"]', PROCESS.idLabel);
  const steps = collectProcessSteps(flags['step']);
  if (steps.length === 0) {
    printError('hippo process supersede requires at least one --step "<text>" for the new version.');
    process.exit(1);
  }
  // A supersession is a new version of the SAME process, so the new row reuses the predecessor's name (stable identity
  // across versions). loadProcessById gives an early not-found before the write; saveProcess's in-SAVEPOINT preflight
  // is the authoritative active-state check.
  const existing = foundOrExit(processesModule.loadProcessById(hippoRoot, tenantId, id), PROCESS.noun, id);
  const changeSummary = nonEmptyStringFlag(flags, 'change');
  const description = nonEmptyStringFlag(flags, 'description');
  const procPathTags = extractPathTags(process.cwd());
  const created = processesModule.saveProcess(hippoRoot, tenantId, {
    processName: existing.processName,
    steps,
    description,
    changeSummary,
    supersedesProcessId: id,
    extraTags: procPathTags,
  });
  console.log(`Process #${created.id} recorded (v${created.version}), superseding #${id}.`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
}

function processClose(hippoRoot: string, tenantId: string, args: string[]): void {
  closeObject(args, PROCESS, (id) => processesModule.closeProcess(hippoRoot, tenantId, id));
}

export function handleProcess({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';
  if (subcommand === 'list') return processList(hippoRoot, tenantId, flags);
  if (subcommand === 'get') return processGet(hippoRoot, tenantId, args);
  if (subcommand === 'supersede') return processSupersede(hippoRoot, tenantId, args, flags);
  if (subcommand === 'close') return processClose(hippoRoot, tenantId, args);

  // Default subcommand: new (create). Accept both the documented
  // `process new "<name>"` form and the bare `process "<name>"` form: for the
  // `new` keyword the name is args[1], otherwise args[0] IS the name.
  processCreate(hippoRoot, tenantId, subcommand === 'new' ? (args[1] ?? '') : subcommand, flags);
}

function processCreate(hippoRoot: string, tenantId: string, processName: string, flags: CliFlags): void {
  if (!processName) {
    printError('Usage: hippo process new "<name>" --step "<text>" [--step ...] [--description "<text>"]');
    printError('       hippo process list [--status active|superseded|closed|all] [--limit N]');
    printError('       hippo process get <id>');
    printError('       hippo process supersede <id> --step "<text>" [--change "<summary>"]');
    printError('       hippo process close <id>');
    process.exit(1);
  }
  const steps = collectProcessSteps(flags['step']);
  const description = nonEmptyStringFlag(flags, 'description');
  const procPathTags = extractPathTags(process.cwd());
  const created = processesModule.saveProcess(hippoRoot, tenantId, {
    processName,
    steps,
    description,
    extraTags: procPathTags,
  });
  console.log(`Process recorded: #${created.id} (v${created.version}, ${created.steps.length} steps)`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
}

function printPolicyRow(p: policiesModule.Policy): void {
  const range = p.validTo ? `${p.validFrom}..${p.validTo}` : `${p.validFrom}..(open)`;
  console.log(`#${p.id} [${p.status}] v${p.version} ${range} memory=${p.memoryId ?? '-'}`);
  console.log(`    ${p.policyName}: ${p.policyText}`);
  if (p.changeSummary) console.log(`    change: ${p.changeSummary}`);
}

function policyList(hippoRoot: string, tenantId: string, flags: CliFlags): void {
  listObjects(flags, {
    plural: 'policies',
    states: policiesModule.VALID_POLICY_STATES,
    load: (opts) => policiesModule.loadPolicies(hippoRoot, tenantId, opts),
    printRow: printPolicyRow,
  });
}

function policyAsOf(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const dateRaw = args[1];
  if (!dateRaw) {
    printError('Usage: hippo policy asof <iso-date> [--name "<policy>"]');
    process.exit(1);
  }
  const name = nonEmptyStringFlag(flags, 'name');
  let results;
  try {
    results = policiesModule.loadPoliciesAsOf(hippoRoot, tenantId, dateRaw, { name });
  } catch (e) {
    printError(errorMessage(e));
    process.exit(1);
  }
  if (results.length === 0) {
    console.log(`No active policies in force at ${dateRaw}${name ? ` for "${name}"` : ''}.`);
    return;
  }
  console.log(`Policies in force at ${dateRaw}:\n`);
  for (const p of results) printPolicyRow(p);
}

function policyGet(hippoRoot: string, tenantId: string, args: string[]): void {
  const id = idArgOrExit(args, 'Usage: hippo policy get <id>', POLICY.idLabel);
  const p = foundOrExit(policiesModule.loadPolicyById(hippoRoot, tenantId, id), POLICY.noun, id);
  console.log(`Policy #${p.id}`);
  console.log(`  name: ${p.policyName}`);
  console.log(`  text: ${p.policyText}`);
  console.log(`  status: ${p.status}`);
  console.log(`  version: ${p.version}`);
  console.log(`  valid_from: ${p.validFrom}`);
  console.log(`  valid_to: ${p.validTo ?? '(open-ended)'}`);
  printLifecycleTail(p);
}

function policySupersede(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const id = idArgOrExit(args, 'Usage: hippo policy supersede <id> --text "<rule>" [--from <iso>] [--to <iso>] [--change "<summary>"]', POLICY.idLabel);
  const textRaw = stringFlag(flags, 'text');
  if (!textRaw?.trim()) {
    printError('hippo policy supersede requires --text "<rule>" for the new version.');
    process.exit(1);
  }
  const existing = foundOrExit(policiesModule.loadPolicyById(hippoRoot, tenantId, id), POLICY.noun, id);
  try {
    const created = policiesModule.savePolicy(hippoRoot, tenantId, {
      policyName: existing.policyName,
      policyText: textRaw,
      validFrom: nonEmptyStringFlag(flags, 'from'),
      validTo: nonEmptyStringFlag(flags, 'to'),
      changeSummary: nonEmptyStringFlag(flags, 'change'),
      supersedesPolicyId: id,
      extraTags: extractPathTags(process.cwd()),
    });
    console.log(`Policy #${created.id} recorded (v${created.version}), superseding #${id}.`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    printError(errorMessage(e));
    process.exit(1);
  }
}

function policyClose(hippoRoot: string, tenantId: string, args: string[]): void {
  closeObject(args, POLICY, (id) => policiesModule.closePolicy(hippoRoot, tenantId, id));
}

export function handlePolicy({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';
  if (subcommand === 'list') return policyList(hippoRoot, tenantId, flags);
  if (subcommand === 'asof') return policyAsOf(hippoRoot, tenantId, args, flags);
  if (subcommand === 'get') return policyGet(hippoRoot, tenantId, args);
  if (subcommand === 'supersede') return policySupersede(hippoRoot, tenantId, args, flags);
  if (subcommand === 'close') return policyClose(hippoRoot, tenantId, args);
  policyCreate(hippoRoot, tenantId, args, flags);
}

function policyCreate(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const subcommand = args[0] ?? '';
  // Default subcommand: new (create). Accept both `policy new "<name>"` and the
  // bare `policy "<name>"` form: for the `new` keyword the name is args[1].
  const policyName = subcommand === 'new' ? (args[1] ?? '') : subcommand;
  const textRaw = stringFlag(flags, 'text');
  if (!policyName || !textRaw?.trim()) {
    printError('Usage: hippo policy new "<name>" --text "<rule>" [--from <iso>] [--to <iso>]');
    printError('       hippo policy list [--status active|superseded|closed|all] [--limit N]');
    printError('       hippo policy get <id>');
    printError('       hippo policy asof <iso-date> [--name "<policy>"]');
    printError('       hippo policy supersede <id> --text "<rule>" [--from] [--to] [--change "<summary>"]');
    printError('       hippo policy close <id>');
    process.exit(1);
  }
  try {
    const created = policiesModule.savePolicy(hippoRoot, tenantId, {
      policyName,
      policyText: textRaw,
      validFrom: nonEmptyStringFlag(flags, 'from'),
      validTo: nonEmptyStringFlag(flags, 'to'),
      extraTags: extractPathTags(process.cwd()),
    });
    const range = created.validTo ? `${created.validFrom}..${created.validTo}` : `${created.validFrom}..(open)`;
    console.log(`Policy recorded: #${created.id} (v${created.version}, effective ${range})`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    printError(errorMessage(e));
    process.exit(1);
  }
}

function printSkillRow(s: skillsModule.Skill): void {
  const trig = s.trigger ? ` when="${s.trigger}"` : '';
  console.log(`#${s.id} [${s.status}] v${s.version}${trig} memory=${s.memoryId ?? '-'}`);
  console.log(`    ${s.skillName}`);
  if (s.changeSummary) console.log(`    change: ${s.changeSummary}`);
}

function skillList(hippoRoot: string, tenantId: string, flags: CliFlags): void {
  listObjects(flags, {
    plural: 'skills',
    states: skillsModule.VALID_SKILL_STATES,
    load: (opts) => skillsModule.loadSkills(hippoRoot, tenantId, opts),
    printRow: printSkillRow,
  });
}

function skillExport(hippoRoot: string, tenantId: string): void {
  const md = skillsModule.exportSkills(hippoRoot, tenantId);
  if (!md) {
    console.log('No active skills.');
    return;
  }
  console.log(md);
}

function skillGet(hippoRoot: string, tenantId: string, args: string[]): void {
  const id = idArgOrExit(args, 'Usage: hippo skill get <id>', SKILL.idLabel);
  const s = foundOrExit(skillsModule.loadSkillById(hippoRoot, tenantId, id), SKILL.noun, id);
  console.log(`Skill #${s.id}`);
  console.log(`  name: ${s.skillName}`);
  console.log(`  status: ${s.status}`);
  console.log(`  version: ${s.version}`);
  if (s.trigger) console.log(`  when: ${s.trigger}`);
  console.log(`  instructions: ${s.instructions}`);
  printLifecycleTail(s);
}

function skillSupersede(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const id = idArgOrExit(args, 'Usage: hippo skill supersede <id> --instructions "<text>" [--trigger "<when>"] [--change "<summary>"]', SKILL.idLabel);
  const instrRaw = stringFlag(flags, 'instructions');
  if (!instrRaw?.trim()) {
    printError('hippo skill supersede requires --instructions "<text>" for the new version.');
    process.exit(1);
  }
  const existing = foundOrExit(skillsModule.loadSkillById(hippoRoot, tenantId, id), SKILL.noun, id);
  try {
    const created = skillsModule.saveSkill(hippoRoot, tenantId, {
      skillName: existing.skillName,
      instructions: instrRaw,
      trigger: nonEmptyStringFlag(flags, 'trigger'),
      changeSummary: nonEmptyStringFlag(flags, 'change'),
      supersedesSkillId: id,
      extraTags: extractPathTags(process.cwd()),
    });
    console.log(`Skill #${created.id} recorded (v${created.version}), superseding #${id}.`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    printError(errorMessage(e));
    process.exit(1);
  }
}

function skillClose(hippoRoot: string, tenantId: string, args: string[]): void {
  closeObject(args, SKILL, (id) => skillsModule.closeSkill(hippoRoot, tenantId, id));
}

export function handleSkill({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';
  if (subcommand === 'list') return skillList(hippoRoot, tenantId, flags);
  if (subcommand === 'export') return skillExport(hippoRoot, tenantId);
  if (subcommand === 'get') return skillGet(hippoRoot, tenantId, args);
  if (subcommand === 'supersede') return skillSupersede(hippoRoot, tenantId, args, flags);
  if (subcommand === 'close') return skillClose(hippoRoot, tenantId, args);
  skillCreate(hippoRoot, tenantId, args, flags);
}

function skillCreate(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const subcommand = args[0] ?? '';
  // Default subcommand: new (create). Accept both `skill new "<name>"` and the
  // bare `skill "<name>"` form: for the `new` keyword the name is args[1].
  const skillName = subcommand === 'new' ? (args[1] ?? '') : subcommand;
  const instrRaw = stringFlag(flags, 'instructions');
  if (!skillName || !instrRaw?.trim()) {
    printError('Usage: hippo skill new "<name>" --instructions "<text>" [--trigger "<when>"]');
    printError('       hippo skill list [--status active|superseded|closed|all] [--limit N]');
    printError('       hippo skill get <id>');
    printError('       hippo skill export   (render active skills as an AGENTS.md/CLAUDE.md block)');
    printError('       hippo skill supersede <id> --instructions "<text>" [--trigger] [--change "<summary>"]');
    printError('       hippo skill close <id>');
    process.exit(1);
  }
  try {
    const created = skillsModule.saveSkill(hippoRoot, tenantId, {
      skillName,
      instructions: instrRaw,
      trigger: nonEmptyStringFlag(flags, 'trigger'),
      extraTags: extractPathTags(process.cwd()),
    });
    console.log(`Skill recorded: #${created.id} (v${created.version})`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    printError(errorMessage(e));
    process.exit(1);
  }
}
