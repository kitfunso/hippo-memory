// First-class object verbs for processes, policies and skills.

import { extractPathTags } from '../path-context.js';
import * as processesModule from '../processes.js';
import * as policiesModule from '../policies.js';
import * as skillsModule from '../skills.js';
import { resolveTenantId } from '../tenant.js';
import { printError } from './output.js';
import { requireInit, type CliFlags } from './shared.js';

// Strict positive-integer id parse for the mutating process subcommands.
// parseInt alone accepts trailing junk ('1abc' -> 1), which would let
// `process close 1abc` / `supersede 1abc` silently hit the wrong row; require
// the whole arg to be digits. (Mirrors parsePositiveIncidentId; codex P2,
// 2026-05-29.)
function parsePositiveProcessId(idRaw: unknown): number {
  const s = String(idRaw ?? '').trim();
  const id = parseInt(s, 10);
  if (!/^\d+$/.test(s) || id <= 0) {
    printError(`Invalid process id: "${idRaw}" (expected a positive integer).`);
    process.exit(1);
  }
  return id;
}

// --step is a repeatable flag (collected into an array by parseArgs). A single
// --step yields a string; normalize both to string[]. A value-less --step errors.
function collectProcessSteps(stepRaw: string | boolean | string[] | undefined): string[] {
  if (Array.isArray(stepRaw)) return stepRaw;
  if (typeof stepRaw === 'string') return [stepRaw];
  if (stepRaw === true) {
    printError('--step requires a value, e.g. hippo process new "<name>" --step "do X".');
    process.exit(1);
  }
  return [];
}


function parseListLimit(flags: CliFlags): number {
  const limitRaw = flags['limit'];
  const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : 100;
  if (!Number.isFinite(limit) || limit <= 0) {
    printError(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
    process.exit(1);
  }
  return limit;
}

function processList(hippoRoot: string, tenantId: string, flags: CliFlags): void {
  const statusRaw = flags['status'];
  const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
  const limit = parseListLimit(flags);
  let results;
  if (status === 'all') {
    results = processesModule.loadProcesses(hippoRoot, tenantId, { limit });
  } else {
    if (!processesModule.VALID_PROCESS_STATES.has(status as processesModule.ProcessStatus)) {
      printError(`Invalid --status: "${status}". Must be one of: active | superseded | closed | all.`);
      process.exit(1);
    }
    results = processesModule.loadProcesses(hippoRoot, tenantId, {
      status: status as processesModule.ProcessStatus,
      limit,
    });
  }
  if (results.length === 0) {
    console.log('No processes.');
    return;
  }
  console.log(`Found ${results.length} processes:\n`);
  for (const proc of results) {
    console.log(`#${proc.id} [${proc.status}] v${proc.version} steps=${proc.steps.length} memory=${proc.memoryId ?? '-'}`);
    console.log(`    ${proc.processName}`);
    if (proc.changeSummary) console.log(`    change: ${proc.changeSummary}`);
  }
}

function processGet(hippoRoot: string, tenantId: string, args: string[]): void {
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo process get <id>');
    process.exit(1);
  }
  const id = parsePositiveProcessId(idRaw);
  const proc = processesModule.loadProcessById(hippoRoot, tenantId, id);
  if (!proc) {
    printError(`Process ${id} not found.`);
    process.exit(1);
  }
  console.log(`Process #${proc.id}`);
  console.log(`  name: ${proc.processName}`);
  console.log(`  status: ${proc.status}`);
  console.log(`  version: ${proc.version}`);
  if (proc.description) console.log(`  description: ${proc.description}`);
  if (proc.steps.length > 0) {
    console.log(`  steps:`);
    proc.steps.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
  }
  if (proc.changeSummary) console.log(`  change_summary: ${proc.changeSummary}`);
  if (proc.supersededBy !== null) console.log(`  superseded_by: #${proc.supersededBy}`);
  if (proc.supersededAt) console.log(`  superseded_at: ${proc.supersededAt}`);
  if (proc.closedAt) console.log(`  closed_at: ${proc.closedAt}`);
  if (proc.memoryId) console.log(`  memory: ${proc.memoryId}`);
  console.log(`  created: ${proc.createdAt}`);
}

function processSupersede(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo process supersede <id> --step "<text>" [--step ...] [--change "<summary>"] [--description "<text>"]');
    process.exit(1);
  }
  const id = parsePositiveProcessId(idRaw);
  const steps = collectProcessSteps(flags['step']);
  if (steps.length === 0) {
    printError('hippo process supersede requires at least one --step "<text>" for the new version.');
    process.exit(1);
  }
  // A supersession is a new version of the SAME process, so the new row reuses the predecessor's name (stable identity
  // across versions). loadProcessById gives an early not-found before the write; saveProcess's in-SAVEPOINT preflight
  // is the authoritative active-state check.
  const existing = processesModule.loadProcessById(hippoRoot, tenantId, id);
  if (!existing) {
    printError(`Process ${id} not found.`);
    process.exit(1);
  }
  const changeRaw = flags['change'];
  const changeSummary = typeof changeRaw === 'string' && changeRaw ? changeRaw : undefined;
  const descRaw = flags['description'];
  const description = typeof descRaw === 'string' && descRaw ? descRaw : undefined;
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
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo process close <id>');
    process.exit(1);
  }
  const id = parsePositiveProcessId(idRaw);
  const closed = processesModule.closeProcess(hippoRoot, tenantId, id);
  console.log(`Process #${closed.id} closed.`);
}

export function cmdProcess(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
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
  const descRaw = flags['description'];
  const description = typeof descRaw === 'string' && descRaw ? descRaw : undefined;
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

// Strict positive-integer id parse for the mutating policy subcommands (mirrors
// parsePositiveProcessId; codex P2 class - parseInt alone accepts '1abc' -> 1).
function parsePositivePolicyId(idRaw: unknown): number {
  const s = String(idRaw ?? '').trim();
  const id = parseInt(s, 10);
  if (!/^\d+$/.test(s) || id <= 0) {
    printError(`Invalid policy id: "${idRaw}" (expected a positive integer).`);
    process.exit(1);
  }
  return id;
}

function printPolicyRow(p: policiesModule.Policy): void {
  const range = p.validTo ? `${p.validFrom}..${p.validTo}` : `${p.validFrom}..(open)`;
  console.log(`#${p.id} [${p.status}] v${p.version} ${range} memory=${p.memoryId ?? '-'}`);
  console.log(`    ${p.policyName}: ${p.policyText}`);
  if (p.changeSummary) console.log(`    change: ${p.changeSummary}`);
}

function policyList(hippoRoot: string, tenantId: string, flags: CliFlags): void {
  const statusRaw = flags['status'];
  const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
  const limit = parseListLimit(flags);
  let results;
  if (status === 'all') {
    results = policiesModule.loadPolicies(hippoRoot, tenantId, { limit });
  } else {
    if (!policiesModule.VALID_POLICY_STATES.has(status as policiesModule.PolicyStatus)) {
      printError(`Invalid --status: "${status}". Must be one of: active | superseded | closed | all.`);
      process.exit(1);
    }
    results = policiesModule.loadPolicies(hippoRoot, tenantId, {
      status: status as policiesModule.PolicyStatus,
      limit,
    });
  }
  if (results.length === 0) {
    console.log('No policies.');
    return;
  }
  console.log(`Found ${results.length} policies:\n`);
  for (const p of results) printPolicyRow(p);
}

function policyAsOf(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const dateRaw = args[1];
  if (!dateRaw) {
    printError('Usage: hippo policy asof <iso-date> [--name "<policy>"]');
    process.exit(1);
  }
  const nameRaw = flags['name'];
  const name = typeof nameRaw === 'string' && nameRaw ? nameRaw : undefined;
  let results;
  try {
    results = policiesModule.loadPoliciesAsOf(hippoRoot, tenantId, dateRaw, { name });
  } catch (e) {
    printError((e as Error).message);
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
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo policy get <id>');
    process.exit(1);
  }
  const id = parsePositivePolicyId(idRaw);
  const p = policiesModule.loadPolicyById(hippoRoot, tenantId, id);
  if (!p) {
    printError(`Policy ${id} not found.`);
    process.exit(1);
  }
  console.log(`Policy #${p.id}`);
  console.log(`  name: ${p.policyName}`);
  console.log(`  text: ${p.policyText}`);
  console.log(`  status: ${p.status}`);
  console.log(`  version: ${p.version}`);
  console.log(`  valid_from: ${p.validFrom}`);
  console.log(`  valid_to: ${p.validTo ?? '(open-ended)'}`);
  if (p.changeSummary) console.log(`  change_summary: ${p.changeSummary}`);
  if (p.supersededBy !== null) console.log(`  superseded_by: #${p.supersededBy}`);
  if (p.supersededAt) console.log(`  superseded_at: ${p.supersededAt}`);
  if (p.closedAt) console.log(`  closed_at: ${p.closedAt}`);
  if (p.memoryId) console.log(`  memory: ${p.memoryId}`);
  console.log(`  created: ${p.createdAt}`);
}

function policySupersede(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo policy supersede <id> --text "<rule>" [--from <iso>] [--to <iso>] [--change "<summary>"]');
    process.exit(1);
  }
  const id = parsePositivePolicyId(idRaw);
  const textRaw = flags['text'];
  if (typeof textRaw !== 'string' || !textRaw.trim()) {
    printError('hippo policy supersede requires --text "<rule>" for the new version.');
    process.exit(1);
  }
  const existing = policiesModule.loadPolicyById(hippoRoot, tenantId, id);
  if (!existing) {
    printError(`Policy ${id} not found.`);
    process.exit(1);
  }
  const fromRaw = flags['from'];
  const toRaw = flags['to'];
  const changeRaw = flags['change'];
  try {
    const created = policiesModule.savePolicy(hippoRoot, tenantId, {
      policyName: existing.policyName,
      policyText: textRaw,
      validFrom: typeof fromRaw === 'string' && fromRaw ? fromRaw : undefined,
      validTo: typeof toRaw === 'string' && toRaw ? toRaw : undefined,
      changeSummary: typeof changeRaw === 'string' && changeRaw ? changeRaw : undefined,
      supersedesPolicyId: id,
      extraTags: extractPathTags(process.cwd()),
    });
    console.log(`Policy #${created.id} recorded (v${created.version}), superseding #${id}.`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    printError((e as Error).message);
    process.exit(1);
  }
}

function policyClose(hippoRoot: string, tenantId: string, args: string[]): void {
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo policy close <id>');
    process.exit(1);
  }
  const id = parsePositivePolicyId(idRaw);
  const closed = policiesModule.closePolicy(hippoRoot, tenantId, id);
  console.log(`Policy #${closed.id} closed.`);
}

export function cmdPolicy(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
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
  const textRaw = flags['text'];
  if (!policyName || typeof textRaw !== 'string' || !textRaw.trim()) {
    printError('Usage: hippo policy new "<name>" --text "<rule>" [--from <iso>] [--to <iso>]');
    printError('       hippo policy list [--status active|superseded|closed|all] [--limit N]');
    printError('       hippo policy get <id>');
    printError('       hippo policy asof <iso-date> [--name "<policy>"]');
    printError('       hippo policy supersede <id> --text "<rule>" [--from] [--to] [--change "<summary>"]');
    printError('       hippo policy close <id>');
    process.exit(1);
  }
  const fromRaw = flags['from'];
  const toRaw = flags['to'];
  try {
    const created = policiesModule.savePolicy(hippoRoot, tenantId, {
      policyName,
      policyText: textRaw,
      validFrom: typeof fromRaw === 'string' && fromRaw ? fromRaw : undefined,
      validTo: typeof toRaw === 'string' && toRaw ? toRaw : undefined,
      extraTags: extractPathTags(process.cwd()),
    });
    const range = created.validTo ? `${created.validFrom}..${created.validTo}` : `${created.validFrom}..(open)`;
    console.log(`Policy recorded: #${created.id} (v${created.version}, effective ${range})`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    printError((e as Error).message);
    process.exit(1);
  }
}

// Strict positive-integer id parse for the mutating skill subcommands (mirrors
// parsePositivePolicyId; codex P2 class - parseInt accepts '1abc' -> 1).
function parsePositiveSkillId(idRaw: unknown): number {
  const s = String(idRaw ?? '').trim();
  const id = parseInt(s, 10);
  if (!/^\d+$/.test(s) || id <= 0) {
    printError(`Invalid skill id: "${idRaw}" (expected a positive integer).`);
    process.exit(1);
  }
  return id;
}

function printSkillRow(s: skillsModule.Skill): void {
  const trig = s.trigger ? ` when="${s.trigger}"` : '';
  console.log(`#${s.id} [${s.status}] v${s.version}${trig} memory=${s.memoryId ?? '-'}`);
  console.log(`    ${s.skillName}`);
  if (s.changeSummary) console.log(`    change: ${s.changeSummary}`);
}

function skillList(hippoRoot: string, tenantId: string, flags: CliFlags): void {
  const statusRaw = flags['status'];
  const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
  const limit = parseListLimit(flags);
  let results;
  if (status === 'all') {
    results = skillsModule.loadSkills(hippoRoot, tenantId, { limit });
  } else {
    if (!skillsModule.VALID_SKILL_STATES.has(status as skillsModule.SkillStatus)) {
      printError(`Invalid --status: "${status}". Must be one of: active | superseded | closed | all.`);
      process.exit(1);
    }
    results = skillsModule.loadSkills(hippoRoot, tenantId, {
      status: status as skillsModule.SkillStatus,
      limit,
    });
  }
  if (results.length === 0) {
    console.log('No skills.');
    return;
  }
  console.log(`Found ${results.length} skills:\n`);
  for (const s of results) printSkillRow(s);
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
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo skill get <id>');
    process.exit(1);
  }
  const id = parsePositiveSkillId(idRaw);
  const s = skillsModule.loadSkillById(hippoRoot, tenantId, id);
  if (!s) {
    printError(`Skill ${id} not found.`);
    process.exit(1);
  }
  console.log(`Skill #${s.id}`);
  console.log(`  name: ${s.skillName}`);
  console.log(`  status: ${s.status}`);
  console.log(`  version: ${s.version}`);
  if (s.trigger) console.log(`  when: ${s.trigger}`);
  console.log(`  instructions: ${s.instructions}`);
  if (s.changeSummary) console.log(`  change_summary: ${s.changeSummary}`);
  if (s.supersededBy !== null) console.log(`  superseded_by: #${s.supersededBy}`);
  if (s.supersededAt) console.log(`  superseded_at: ${s.supersededAt}`);
  if (s.closedAt) console.log(`  closed_at: ${s.closedAt}`);
  if (s.memoryId) console.log(`  memory: ${s.memoryId}`);
  console.log(`  created: ${s.createdAt}`);
}

function skillSupersede(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo skill supersede <id> --instructions "<text>" [--trigger "<when>"] [--change "<summary>"]');
    process.exit(1);
  }
  const id = parsePositiveSkillId(idRaw);
  const instrRaw = flags['instructions'];
  if (typeof instrRaw !== 'string' || !instrRaw.trim()) {
    printError('hippo skill supersede requires --instructions "<text>" for the new version.');
    process.exit(1);
  }
  const existing = skillsModule.loadSkillById(hippoRoot, tenantId, id);
  if (!existing) {
    printError(`Skill ${id} not found.`);
    process.exit(1);
  }
  const trigRaw = flags['trigger'];
  const changeRaw = flags['change'];
  try {
    const created = skillsModule.saveSkill(hippoRoot, tenantId, {
      skillName: existing.skillName,
      instructions: instrRaw,
      trigger: typeof trigRaw === 'string' && trigRaw ? trigRaw : undefined,
      changeSummary: typeof changeRaw === 'string' && changeRaw ? changeRaw : undefined,
      supersedesSkillId: id,
      extraTags: extractPathTags(process.cwd()),
    });
    console.log(`Skill #${created.id} recorded (v${created.version}), superseding #${id}.`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    printError((e as Error).message);
    process.exit(1);
  }
}

function skillClose(hippoRoot: string, tenantId: string, args: string[]): void {
  const idRaw = args[1];
  if (!idRaw) {
    printError('Usage: hippo skill close <id>');
    process.exit(1);
  }
  const id = parsePositiveSkillId(idRaw);
  const closed = skillsModule.closeSkill(hippoRoot, tenantId, id);
  console.log(`Skill #${closed.id} closed.`);
}

export function cmdSkill(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
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
  const instrRaw = flags['instructions'];
  if (!skillName || typeof instrRaw !== 'string' || !instrRaw.trim()) {
    printError('Usage: hippo skill new "<name>" --instructions "<text>" [--trigger "<when>"]');
    printError('       hippo skill list [--status active|superseded|closed|all] [--limit N]');
    printError('       hippo skill get <id>');
    printError('       hippo skill export   (render active skills as an AGENTS.md/CLAUDE.md block)');
    printError('       hippo skill supersede <id> --instructions "<text>" [--trigger] [--change "<summary>"]');
    printError('       hippo skill close <id>');
    process.exit(1);
  }
  const trigRaw = flags['trigger'];
  try {
    const created = skillsModule.saveSkill(hippoRoot, tenantId, {
      skillName,
      instructions: instrRaw,
      trigger: typeof trigRaw === 'string' && trigRaw ? trigRaw : undefined,
      extraTags: extractPathTags(process.cwd()),
    });
    console.log(`Skill recorded: #${created.id} (v${created.version})`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    printError((e as Error).message);
    process.exit(1);
  }
}
