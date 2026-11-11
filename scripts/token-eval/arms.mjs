// Z0 arms (docs/evals/2026-09-29-z0-built-in-memory-prereg.md "Arms"; round 4 prereg item 1): the arm table, the designs, settings, environment, PATH and the hippo shims.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HIPPO_JS, pathKey } from './exec.mjs';

export const OPUS_MODEL = 'claude-opus-5-5';
export const SONNET_MODEL = 'claude-sonnet-5-5';
const CODEX_MODEL = 'gpt-5.6-sol';

const own = (object, key) => Object.hasOwn(object, key);
const isString = (v) => v !== undefined && v !== null && v.constructor === String;
const isBool = (v) => v === true || v === false;
const isObject = (v) => v !== undefined && v !== null && v.constructor === Object;
const isCodeList = (v) => Array.isArray(v) && v.every(isString);
const isPair = (v) => isCodeList(v) && v.length === 2;

function deepFreeze(x) {
  if (x === null || x === undefined || Object(x) !== x) return x;
  for (const v of Object.values(x)) deepFreeze(v);
  return Object.freeze(x);
}

const oneOf = (...values) => ({ text: values.map(String).join(', '), test: (v) => values.includes(v) });
const nullOr = (...values) => ({ text: `null, ${values.join(', ')}`, test: (v) => v === null || values.includes(v) });
// The fields a round 4 row may change from its round 3 twin; every other field is copied.
const OWN_FIELDS = ['round', 'twin', 'model', 'pinKey', 'effort', 'group'];
export const EFFORTS = Object.freeze(['low', 'medium', 'high']);
const ROW_FIELDS = {
  round: oneOf('r3', 'r4'),
  twin: { text: 'null or an arm code', test: (v) => v === null || isString(v) },
  tool: oneOf('claude-code', 'codex'),
  model: { text: 'a model id', test: (v) => isString(v) && v.length > 0 },
  pinKey: oneOf('model', 'codexModel', 'modelOpus', 'modelSonnet'),
  effort: nullOr('medium'),
  set: oneOf('RN', 'X'),
  seeds: oneOf(2, 3),
  group: oneOf('A', 'X', 'O', 'S'),
  autoMemory: { text: 'a boolean', test: isBool },
  carry: { text: 'a boolean', test: isBool },
  capture: { text: 'a boolean', test: isBool },
  seedRule: { text: 'a boolean', test: isBool },
  shim: nullOr('real', 'sham'),
  taught: nullOr('claude-md', 'x4-block'),
  stub: nullOr('x3'),
};
const ROW_NAMES = Object.keys(ROW_FIELDS);
// The arm-literal scanner reads a code as one of these letters and a digit, so a code of another shape would escape it.
const ARM_CODE = /^[AXOS][0-9]$/;

/** Stops, naming the row and field, on a missing, extra or out-of-domain field, or a round 4 row that differs from its twin outside its own fields. */
export function checkTable(table) {
  for (const [code, r] of Object.entries(table)) {
    if (!ARM_CODE.test(code)) throw new Error(`ARM_TABLE ${code}: an arm code is A, X, O or S and one digit`);
    for (const f of ROW_NAMES) if (!own(r, f)) throw new Error(`ARM_TABLE ${code}: field ${f} is missing`);
    for (const f of Object.keys(r)) if (!own(ROW_FIELDS, f)) throw new Error(`ARM_TABLE ${code}: field ${f} is not a table field`);
    for (const f of ROW_NAMES) if (!ROW_FIELDS[f].test(r[f])) throw new Error(`ARM_TABLE ${code}.${f}: ${JSON.stringify(r[f])} is outside ${ROW_FIELDS[f].text}`);
    if ((r.round === 'r3') !== (r.twin === null)) throw new Error(`ARM_TABLE ${code}.twin: a round 3 row has no twin and a round 4 row names one`);
    if (r.twin === null) continue;
    if (!own(table, r.twin) || table[r.twin].round !== 'r3') throw new Error(`ARM_TABLE ${code}.twin: ${r.twin} is not a round 3 row`);
    for (const f of ROW_NAMES.filter((n) => !OWN_FIELDS.includes(n))) {
      if (r[f] !== table[r.twin][f]) throw new Error(`ARM_TABLE ${code}.${f}: ${JSON.stringify(r[f])} but its twin ${r.twin} holds ${JSON.stringify(table[r.twin][f])}`);
    }
  }
}

const row = (fields) => ({
  round: 'r3', twin: null, tool: 'claude-code', model: OPUS_MODEL, pinKey: 'model', effort: null, set: 'RN', seeds: 3, group: 'A',
  autoMemory: true, carry: false, capture: false, seedRule: false, shim: null, taught: null, stub: null, ...fields,
});
const codexRow = (fields) => row({ tool: 'codex', model: CODEX_MODEL, pinKey: 'codexModel', set: 'X', group: 'X', carry: true, ...fields });
// arm-table:start
const R3_ROWS = {
  A0: row({ seeds: 2, autoMemory: false }),
  A1: row({ carry: true, seedRule: true }),
  A2: row({ carry: true, capture: true, seedRule: true, shim: 'real' }),
  A4: row({ seeds: 2, autoMemory: false, taught: 'claude-md' }),
  A5: row({ carry: true, seedRule: true, shim: 'sham' }),
  X1: codexRow({}),
  X2: codexRow({ capture: true, seedRule: true, shim: 'real' }),
  X3: codexRow({ seedRule: true, stub: 'x3' }),
  X4: codexRow({ seeds: 2, taught: 'x4-block' }),
};
const twinOf = (twin, fields) => ({ ...R3_ROWS[twin], round: 'r4', twin, effort: 'medium', ...fields });
const R4_ROWS = {
  O1: twinOf('A1', { model: OPUS_MODEL, pinKey: 'modelOpus', group: 'O' }),
  S1: twinOf('A1', { model: SONNET_MODEL, pinKey: 'modelSonnet', group: 'S' }),
  S2: twinOf('A2', { model: SONNET_MODEL, pinKey: 'modelSonnet', group: 'S' }),
  S5: twinOf('A5', { model: SONNET_MODEL, pinKey: 'modelSonnet', group: 'S' }),
  S0: twinOf('A0', { model: SONNET_MODEL, pinKey: 'modelSonnet', group: 'S' }),
  S4: twinOf('A4', { model: SONNET_MODEL, pinKey: 'modelSonnet', group: 'S' }),
};
// arm-table:end
export const ARM_TABLE = deepFreeze({ ...R3_ROWS, ...R4_ROWS });
checkTable(ARM_TABLE);

export const ALL_ARMS = Object.freeze(Object.keys(ARM_TABLE));
const armsWhere = (test) => new Set(ALL_ARMS.filter((a) => test(ARM_TABLE[a])));
// The sets span both rounds; a list that code iterates, prints or pairs comes from a design.
export const NO_AUTO_MEMORY = armsWhere((r) => !r.autoMemory);
export const RESTORED_ARMS = armsWhere((r) => !r.autoMemory);
export const FLOOR_ARMS = armsWhere((r) => !r.autoMemory);
export const HIPPO_ARMS = armsWhere((r) => r.shim !== null);
export const CODEX_HIPPO_ARMS = armsWhere((r) => r.tool === 'codex' && r.shim === 'real');
export const CARRY_ARMS = armsWhere((r) => r.carry);
export const CAPTURE_ARMS = armsWhere((r) => r.capture);
export const TWO_SEED_ARMS = armsWhere((r) => r.seeds === 2);
export const RULE_ARMS = armsWhere((r) => r.seedRule);

/** The codes of one round whose boolean field is set, for the messages that name them. */
export const roundArms = (round, field) => ALL_ARMS.filter((a) => ARM_TABLE[a].round === round && ARM_TABLE[a][field]);
export const joinCodes = (codes) => (codes.length < 2 ? codes.join('') : `${codes.slice(0, -1).join(', ')} and ${codes.at(-1)}`);

const CODES = Object.freeze(Object.fromEntries(ALL_ARMS.map((a) => [a, a])));
const { A0, A1, A2, A4, A5, X1, X2, X3, X4, O1, S0, S1, S2, S4, S5 } = CODES;

// A design names arms by these bare constants, so a misspelled code is an undeclared name at load.
export const DESIGNS = deepFreeze({
  r3: {
    arms: [A0, A1, A2, A4, A5, X1, X2, X3, X4],
    noMemory: A0,
    sets: ['R', 'N', 'X'],
    hookHold: [A2, A5],
    tests: { H1: [A2, A1], H2: [X2, X3], H3: [A2, A1], H4: [A2, A1] },
    pairs: { attribution: [A2, A5], A1vA0: [A1, A0], A4vA1: [A4, A1], X2vX1: [X2, X1] },
    reported: ['A1vA0', 'A4vA1', 'X2vX1', 'H1', 'H2', 'H3'],
    seedRule: [{ arms: [A1, A2, A5], tests: ['H1', 'H4'] }, { arms: [X2, X3], tests: ['H2'] }],
    g2: { claudeCode: { taught: A4, control: A0, needs: [A1, A2] }, codex: { taught: X4, control: X1, needs: [X2, X3] } },
    screen: { control: A0, taught: A4 },
    drift: null,
    prices: 'tool',
    dropFamilies: [],
    maxSeed: null,
  },
  r4: {
    arms: [O1, S0, S1, S2, S4, S5],
    noMemory: S0,
    sets: ['R', 'N'],
    hookHold: [S2, S5],
    tests: { T1: [S2, S1], T2a: [S2, O1], T2b: [S2, O1], T2c: [S2, O1], T3: [S2, S5], H4: [S2, S1] },
    pairs: { H1: [S2, S1], H3: [S2, S1], S1vO1: [S1, O1], S1vS0: [S1, S0], S4vS1: [S4, S1], resampled: [S2, S1] },
    reported: ['S1vS0', 'S4vS1', 'H1', 'H3'],
    seedRule: [{ arms: [O1, S1, S2, S5], tests: ['T1', 'T2a', 'T2b', 'T2c', 'T3', 'H4'] }],
    g2: { claudeCode: { taught: S4, control: S0, needs: [S1, S2] }, codex: null },
    screen: null,
    drift: { arm: O1, against: A1, design: 'r3' },
    prices: 'model',
    dropFamilies: [],
    maxSeed: null,
  },
  'r4-on-r3': {
    arms: [A0, A1, A2, A4, A5],
    noMemory: A0,
    sets: ['R', 'N'],
    hookHold: [A2, A5],
    tests: { T1: [A2, A1], T2a: [A2, A1], T2b: [A2, A1], T2c: [A2, A1], H4: [A2, A1], T3: [A2, A5], T2aMiss: [A0, A1] },
    pairs: { resampled: [A2, A1] },
    reported: [],
    seedRule: [{ arms: [A1, A2, A5], tests: ['T1', 'T2a', 'T2b', 'T2c', 'T3', 'H4'] }],
    g2: { claudeCode: null, codex: null },
    screen: null,
    drift: null,
    prices: 'model',
    dropFamilies: ['hu3-f2', 'q133-f2', 'q14-f3', 'q256-f1'],
    maxSeed: 3,
  },
});

const DESIGN_FIELDS = {
  arms: isCodeList, noMemory: isString, sets: isCodeList, hookHold: isCodeList, reported: isCodeList, dropFamilies: isCodeList,
  tests: (v) => isObject(v) && Object.values(v).every(isPair),
  pairs: (v) => isObject(v) && Object.values(v).every(isPair),
  seedRule: (v) => Array.isArray(v) && v.every((g) => isObject(g) && isCodeList(g.arms) && isCodeList(g.tests)),
  g2: (v) => isObject(v) && ['claudeCode', 'codex'].every((h) => own(v, h) && (v[h] === null || (isObject(v[h]) && isString(v[h].taught) && isString(v[h].control) && isCodeList(v[h].needs)))),
  screen: (v) => v === null || (isObject(v) && isString(v.control) && isString(v.taught)),
  drift: (v) => v === null || (isObject(v) && isString(v.arm) && isString(v.against) && isString(v.design)),
  prices: (v) => v === 'tool' || v === 'model',
  maxSeed: (v) => v === null || (Number.isInteger(v) && v >= 1),
};

/** Every arm code a design names, as [field, code]; the `arms` field itself is the planned list. */
function codeRefs(d) {
  const halves = ['claudeCode', 'codex'].map((h) => d.g2[h]).filter((h) => h !== null);
  return [
    ['noMemory', d.noMemory],
    ...d.hookHold.map((c) => ['hookHold', c]),
    ...Object.values(d.tests).flat().map((c) => ['tests', c]),
    ...Object.values(d.pairs).flat().map((c) => ['pairs', c]),
    ...d.seedRule.flatMap((g) => g.arms.map((c) => ['seedRule', c])),
    ...halves.flatMap((h) => [h.taught, h.control, ...h.needs].map((c) => ['g2', c])),
    ...(d.screen === null ? [] : [['screen', d.screen.control], ['screen', d.screen.taught]]),
    ...(d.drift === null ? [] : [['drift', d.drift.arm]]),
  ];
}

function checkArms(d, table, fail) {
  for (const c of d.arms) if (!own(table, c)) fail('arms', `${c} is not an ARM_TABLE code`);
  for (const [field, c] of codeRefs(d)) {
    if (!own(table, c)) fail(field, `${c} is not an ARM_TABLE code`);
    else if (!d.arms.includes(c)) fail(field, `${c} is not in the design's arms`);
  }
  for (const [pairName, pair] of [...Object.entries(d.tests), ...Object.entries(d.pairs)]) {
    if (pair[0] === pair[1]) fail(own(d.tests, pairName) ? 'tests' : 'pairs', `${pairName} holds ${pair[0]} twice`);
  }
}

function checkNames(d, table, designs, fail) {
  for (const t of Object.keys(d.tests)) if (own(d.pairs, t)) fail('pairs', `${t} is in both tests and pairs`);
  for (const n of d.reported) if (!own(d.tests, n) && !own(d.pairs, n)) fail('reported', `${n} is in neither tests nor pairs`);
  const grouped = new Set();
  for (const g of d.seedRule) {
    for (const t of g.tests) if (!own(d.tests, t) && !own(d.pairs, t)) fail('seedRule', `test ${t} is in neither tests nor pairs`);
    for (const c of g.arms) {
      if (grouped.has(c)) fail('seedRule', `${c} is in two seed-rule groups`);
      grouped.add(c);
    }
  }
  const wanted = d.arms.filter((c) => own(table, c) && table[c].seedRule);
  if (d.seedRule.length > 0 && (grouped.size !== wanted.length || wanted.some((c) => !grouped.has(c)))) {
    fail('seedRule', `its groups cover ${[...grouped].join(', ')} but the arms whose row has seedRule are ${wanted.join(', ')}`);
  }
  if (d.drift === null) return;
  if (!own(designs, d.drift.design)) fail('drift', `design ${d.drift.design} is not a design`);
  else if (!designs[d.drift.design].arms.includes(d.drift.against)) fail('drift', `${d.drift.against} is not in the arms of design ${d.drift.design}`);
}

/** Stops, naming the design and the field, on a field that is missing, extra or of the wrong type, a code outside the table or the design, or a test, pair, group or drift that does not hold together. */
export function checkDesigns(designs = DESIGNS, table = ARM_TABLE) {
  for (const [name, d] of Object.entries(designs)) {
    const fail = (field, message) => {
      throw new Error(`DESIGNS.${name}.${field}: ${message}`);
    };
    for (const f of Object.keys(DESIGN_FIELDS)) if (!own(d, f)) fail(f, 'the field is missing');
    for (const f of Object.keys(d)) if (!own(DESIGN_FIELDS, f)) fail(f, 'the field is not a design field');
    for (const f of Object.keys(DESIGN_FIELDS)) if (!DESIGN_FIELDS[f](d[f])) fail(f, 'the value has the wrong type');
    checkArms(d, table, fail);
    checkNames(d, table, designs, fail);
  }
}
checkDesigns();

export const designByName = (name) => {
  if (!own(DESIGNS, name)) throw new Error(`unknown design ${name}; known: ${Object.keys(DESIGNS).join(', ')}`);
  return DESIGNS[name];
};

export const designName = (design) => Object.keys(DESIGNS).find((k) => DESIGNS[k] === design) ?? `(${design.arms.join(', ')})`;

/** Whether the design names a test or pair; a sizing read of a design without one reports it not planned, where `pairOf` stops. */
export const hasPair = (design, name) => own(design.tests, name) || own(design.pairs, name);

/** The [treat, control] of a test or pair by name; an unknown name stops, naming the design. */
export function pairOf(design, name) {
  if (own(design.tests, name)) return design.tests[name];
  if (own(design.pairs, name)) return design.pairs[name];
  throw new Error(`design ${designName(design)} has no test or pair named ${name}`);
}

// Round 3's lists, as views of its design: ARMS is the round 3 arms, and the two set lists split it.
export const ARMS = DESIGNS.r3.arms;
export const RN_ARMS = Object.freeze(ARMS.filter((a) => ARM_TABLE[a].set === 'RN'));
export const X_ARMS = Object.freeze(ARMS.filter((a) => ARM_TABLE[a].set === 'X'));
// Prereg "Seeds": A0's, A4's and X4's gates need a large effect, so they run two.
export const ARM_SEEDS = Object.freeze(Object.fromEntries(ARMS.map((a) => [a, ARM_TABLE[a].seeds])));
/** The set an arm runs: X arms run only set X sequences, the A arms only R and N. */
export const armSet = (arm) => (own(ARM_TABLE, arm) && ARM_TABLE[arm].set === 'X' ? 'X' : 'RN');
export const TOKEN_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

const CAPTURE_EVENTS = ['SessionEnd', 'PreCompact', 'PostCompact', 'PostToolUseFailure'];
const LAUNCHERS = ['hippo', 'hippo.cmd', 'hippo.ps1', 'hippo.exe', 'hippo.bat'];
const REQUIRED_TOOLS = ['node', 'npm', 'npx', 'git'];
const SHAM_COMMANDS = ['remember', 'capture', 'learn', 'outcome'];
// The keys armEnv sets itself: a --pass-env copy would silently override the arm (and a second PATH key on Windows).
const RUNNER_KEYS = [
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HIPPO_HOME', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'HIPPO_AGENT_MEMORY_TOOLS', 'DISABLE_AUTOUPDATER', 'EVAL_SEED', TOKEN_KEY, 'PATH',
  'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
];
// Round 3 prereg item 5a: system names the agent and shells need, as round 2's records carried them. Left out on purpose: provider, CLAUDE_*, AWS_*, CODEX_*, HIPPO_*, OPENAI_*
// and ANTHROPIC_* names, parent session ids (a child would log under the parent's id), and NoDefaultCurrentDirectoryInExePath (cmd.exe then misses a checkout's gradlew.bat).
const SYSTEM_ENV = [
  'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432', 'DriverData',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'OS', 'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE',
  'COMPUTERNAME', 'LOGONSERVER', 'SESSIONNAME', 'PSModulePath', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'TZ',
  // Keep git from opening an editor or a prompt that no one answers.
  'GIT_EDITOR', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE',
  // A path, not a secret; listed so the README's --pass-env route does not fail G1.
  'CLAUDE_CODE_GIT_BASH_PATH',
];
// The union over every toolchain in C:/eval-authors/s3x-env.ps1, which now covers the Android builds of round 3's batch 5, plus COREPACK_ENABLE_AUTO_PIN, which stops corepack editing package.json.
const TOOLCHAIN_ENV = [
  'CI', 'COREPACK_ENABLE_STRICT', 'COREPACK_ENABLE_AUTO_PIN', 'npm_config_manage_package_manager_versions', 'JAVA_HOME', 'GRADLE_USER_HOME', 'MAVEN_ARGS', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'JULIA_DEPOT_PATH', 'JULIA_PKG_PRECOMPILE_AUTO',
  'GEM_HOME', 'GEM_PATH', 'BUNDLE_PATH', 'RI_DEVKIT', 'MAKE', 'RUSTUP_HOME', 'CARGO_HOME', 'CARGO_BUILD_JOBS', 'CARGO_TARGET_DIR', 'MIX_HOME', 'HEX_HOME', 'MIX_ENV',
  'GOROOT', 'GOPATH', 'GOCACHE', 'GOTOOLCHAIN', 'DOTNET_ROOT', 'DOTNET_CLI_HOME', 'NUGET_PACKAGES', 'DOTNET_ROLL_FORWARD', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'DOTNET_NOLOGO',
  'VIRTUAL_ENV', 'PYTHONUTF8', 'PYTHONIOENCODING',
];
/** The only names a session's env may start from; matching is case-insensitive, as on Windows. */
export const ENV_ALLOWLIST = Object.freeze([...RUNNER_KEYS, ...SYSTEM_ENV, ...TOOLCHAIN_ENV]);
// Any allowlisted name that looks like this stops armEnv, so a secret cannot ride in on a list edit.
export const SECRET_SHAPED = /TOKEN|SECRET|PASSW|API_KEY|_KEY$|DSN|CREDENTIAL|ACCOUNT_ID/i;
export const envAllowSet = (list = ENV_ALLOWLIST) => new Set(list.map((name) => name.toUpperCase()));
const PIP_CONSTRAINT = 'PIP_CONSTRAINT';
const R4_ALLOWLIST = Object.freeze([...ENV_ALLOWLIST, PIP_CONSTRAINT]);
/** The names a design's sessions may start from: a round 4 design adds the task env's pip pin, so round 3's list and G1 do not move. */
export const isRound4Design = (design) => design.arms.some((a) => ARM_TABLE[a].round === 'r4');
export const allowlistOf = (design) => (isRound4Design(design) ? R4_ALLOWLIST : ENV_ALLOWLIST);

const rowOf = (arm) => {
  if (!own(ARM_TABLE, arm)) throw new Error(`unknown arm ${arm}; known: ${ALL_ARMS.join(', ')}`);
  return ARM_TABLE[arm];
};

/** The `--settings` file for an arm; `hippoSettings` is what hippo's installer writes for Claude Code. */
export function armSettings(arm, hippoSettings) {
  const r = rowOf(arm);
  if (!r.autoMemory) return { autoMemoryEnabled: false };
  if (r.shim === 'real') return hippoSettings;
  if (r.shim === 'sham') {
    const hooks = Object.fromEntries(Object.entries(hippoSettings.hooks ?? {}).filter(([event]) => !CAPTURE_EVENTS.includes(event)));
    return { ...hippoSettings, hooks };
  }
  return {};
}

function getKey(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** A session's environment: only the parent's allowlisted names, plus the run's own homes and PATH and any --pass-env name.
 * @param {string} arm
 * @param {any} dirs
 * @param {Record<string, string | undefined>} baseEnv
 * @param {{passEnv?: string[], allowlist?: readonly string[], effort?: string}} [options] `allowlist` is for tests; `effort` replaces the row's effort
 * @returns {Record<string, string | undefined>} */
export function armEnv(arm, dirs, baseEnv, { passEnv = [], allowlist = ENV_ALLOWLIST, effort = undefined } = {}) {
  const r = rowOf(arm);
  const reserved = passEnv.find((name) => RUNNER_KEYS.includes(name.toUpperCase()));
  if (reserved !== undefined) throw new Error(`--pass-env ${reserved}: the runner sets ${reserved.toUpperCase()} itself per arm, so it cannot be passed through`);
  if (effort !== undefined && r.effort === null) throw new Error(`arm ${arm} runs with no effort setting, so effort ${effort} cannot replace it`);
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new Error(`effort ${effort} is not one of ${EFFORTS.join(', ')}`);
  const allowed = envAllowSet(allowlist);
  // The runner's own keys are set below, so a base copy under another case would leave two keys.
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([k]) => allowed.has(k.toUpperCase()) && !RUNNER_KEYS.includes(k.toUpperCase())));
  const token = getKey(baseEnv, TOKEN_KEY);
  if (token !== undefined) env[TOKEN_KEY] = token;
  env.CLAUDE_CONFIG_DIR = dirs.claudeConfig;
  env.CODEX_HOME = dirs.codexHome;
  env.HIPPO_HOME = dirs.hippoHome;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = r.autoMemory ? '0' : '1';
  env.HIPPO_AGENT_MEMORY_TOOLS = 'claude-code,codex';
  env.DISABLE_AUTOUPDATER = '1';
  env.EVAL_SEED = String(dirs.seed);
  if (r.effort !== null) {
    env.CLAUDE_CODE_EFFORT_LEVEL = effort ?? r.effort;
    env.CLAUDE_CODE_SUBAGENT_MODEL = r.model;
    env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = '1';
  }
  for (const name of passEnv) {
    const value = getKey(baseEnv, name);
    if (value !== undefined) env[name] = value;
  }
  const key = pathKey(baseEnv);
  const cleaned = cleanPath(baseEnv[key] ?? '', { env: baseEnv }).value;
  env[key] = HIPPO_ARMS.has(arm) ? `${dirs.bin}${path.delimiter}${cleaned}` : cleaned;
  const secret = Object.keys(env).find((k) => k.toUpperCase() !== TOKEN_KEY && SECRET_SHAPED.test(k));
  if (secret !== undefined) throw new Error(`armEnv: ${secret} looks like a secret and would reach the session; remove it from ENV_ALLOWLIST in scripts/token-eval/arms.mjs (or from --pass-env)`);
  return env;
}

/** The warm-up call's env and argv: the design's no-memory arm with the subagent model set to `model` when its row has an effort, and `--model` as an argv flag, since it is no env name. */
export function warmupEnv(design, model, dirs, baseEnv, options = {}) {
  const env = armEnv(design.noMemory, dirs, baseEnv, options);
  // Round 3's warm-up set no subagent model, so a row with no effort keeps armEnv's env as it is.
  if (rowOf(design.noMemory).effort !== null) env.CLAUDE_CODE_SUBAGENT_MODEL = model;
  return { env, args: ['--model', model] };
}

/** The env for setup, tests, init and the homes check: no OAuth token, and (unless keepBin) no run `bin/` on PATH. */
export function childEnv(env, { keepBin = false } = {}) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== TOKEN_KEY));
  if (!keepBin && out.CLAUDE_CONFIG_DIR) {
    // The run's bin/ is its config dir's sibling, so it is found without a second argument.
    const bin = path.join(path.dirname(out.CLAUDE_CONFIG_DIR), 'bin');
    const key = pathKey(out);
    out[key] = (out[key] ?? '').split(path.delimiter).filter((e) => e !== bin).join(path.delimiter);
  }
  return out;
}

/** A `hippo` on PATH that runs this checkout; `sham` turns the capture commands into silent no-ops (A5). */
export function writeHippoShim(binDir, fakeHome, mode) {
  if (mode !== 'real' && mode !== 'sham') throw new Error(`unknown shim mode ${mode}`);
  // A fake HOME keeps hippo off the operator's ~/.claude (MEMORY.md import, capture scans, hook installs).
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });
  // Only the prereg's capture commands are sham; note, customer-note, sleep and import stay real.
  const shCase = mode === 'sham' ? `case "$1" in ${SHAM_COMMANDS.join('|')}) exit 0;; esac\n` : '';
  const cmdIfs = mode === 'sham' ? SHAM_COMMANDS.map((c) => `@if /i "%~1"=="${c}" exit /b 0\r\n`).join('') : '';
  fs.writeFileSync(path.join(binDir, 'hippo'), `#!/bin/sh\n${shCase}export HOME="${fakeHome}" USERPROFILE="${fakeHome}"\nexec "${process.execPath}" "${HIPPO_JS}" "$@"\n`, { mode: 0o755 });
  // @setlocal: a caller that runs hippo inside a longer cmd line keeps its own HOME afterwards.
  fs.writeFileSync(path.join(binDir, 'hippo.cmd'), `@setlocal\r\n${cmdIfs}@set "HOME=${fakeHome}"\r\n@set "USERPROFILE=${fakeHome}"\r\n@"${process.execPath}" "${HIPPO_JS}" %*\r\n`);
}

function normaliseEntry(entry, env, cwd, platform) {
  let e = entry.trim();
  if (e.length >= 2 && e.startsWith('"') && e.endsWith('"')) e = e.slice(1, -1).trim();
  if (e === '') return null;
  if (platform === 'win32') e = e.replace(/%([^%]+)%/g, (m, name) => getKey(env, name) ?? m);
  return path.resolve(cwd, e);
}

const holdsLauncher = (dir) => LAUNCHERS.some((name) => fs.existsSync(path.join(dir, name)));

/** PATH without any dir holding a hippo launcher, so A0 and A1 get the shell's own "not found" and A2/A5 only their shim. */
export function cleanPath(pathValue, { env = process.env, cwd = process.cwd(), platform = process.platform } = {}) {
  const kept = [];
  const removed = [];
  for (const entry of String(pathValue ?? '').split(path.delimiter)) {
    const dir = normaliseEntry(entry, env, cwd, platform);
    if (dir === null) continue;
    if (holdsLauncher(dir)) {
      if (!removed.includes(dir)) removed.push(dir);
      continue;
    }
    kept.push(path.isAbsolute(entry.trim().replace(/^"|"$/g, '')) ? entry : dir);
  }
  return { value: kept.join(path.delimiter), removed };
}

/** The first file `name` resolves to on a PATH value (PATHEXT-aware on win32), or null. */
export function which(name, pathValue, { env = process.env, platform = process.platform } = {}) {
  const exts = platform === 'win32' ? ['', ...(getKey(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const entry of String(pathValue ?? '').split(path.delimiter)) {
    const dir = normaliseEntry(entry, env, process.cwd(), platform);
    if (dir === null) continue;
    for (const ext of exts) {
      const file = path.join(dir, `${name}${ext}`);
      if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
    }
  }
  return null;
}

const firstToken = (cmd) => (cmd.trim().startsWith('"') ? cmd.trim().slice(1).split('"')[0] : cmd.trim().split(/\s+/)[0]);
const isBareName = (cmd) => /^[\w.-]+$/.test(cmd);
const sameDir = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/** A bare `claude` name resolved once to an absolute, quoted path on the uncleaned PATH; a command string is left as is. */
export function resolveClaude(claudeBin, pathValue, opts = {}) {
  if (!isBareName(claudeBin)) return claudeBin;
  const found = which(claudeBin, pathValue, opts);
  if (!found) throw new Error(`${claudeBin} is not on PATH; install Claude Code or pass --claude-bin`);
  return `"${found}"`;
}

/** Refuse to run when hiding the hippo launcher dirs also hid a tool the runner or the agent needs. */
export function assertToolsResolve(cleanedPath, claudeCmd, removed = [], opts = {}) {
  const missing = REQUIRED_TOOLS.filter((t) => !which(t, cleanedPath, opts));
  const claude = firstToken(claudeCmd);
  if (path.isAbsolute(claude)) {
    if (!fs.existsSync(claude) || removed.some((d) => sameDir(path.dirname(claude), d))) missing.push(`claude (${claude})`);
  } else if (!which(claude, cleanedPath, opts)) missing.push(claude);
  if (missing.length === 0) return;
  const dirs = removed.length > 0 ? removed.join(', ') : 'none';
  throw new Error(`with the hippo launcher dirs (${dirs}) off PATH, these no longer resolve: ${missing.join(', ')}. Install hippo in its own prefix, or uninstall the global copy, so those dirs hold no hippo.`);
}

/** Resolve claude and check the cleaned PATH once, before any run: returns the claude command every session spawns. */
export function startupTools(claudeBin, baseEnv) {
  const pathValue = baseEnv[pathKey(baseEnv)] ?? '';
  const { value, removed } = cleanPath(pathValue, { env: baseEnv });
  const claude = resolveClaude(claudeBin, pathValue, { env: baseEnv });
  assertToolsResolve(value, claude, removed, { env: baseEnv });
  return { claude, removed };
}
