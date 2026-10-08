// Pins how each typed-object CLI verb reads an id argument and a --limit flag: the exit code and the lines printed today.
// The verbs run in this process against a real store, since a spawn per case would cost minutes.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { savePrediction } from '../src/predictions/store.js';
import { initStore } from '../src/store/open.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess } from './_helpers/run-in-process.js';
import { maskVolatile, TYPED_OBJECT_SPECS } from './_helpers/typed-object-specs.js';

const ID_FORMS: readonly string[] = [
  'abc',
  '0',
  '-1',
  '1.5',
  // Documents current behaviour: predict and decide read '1abc' as 1 and act on row 1; every other noun refuses it.
  '1abc',
  '',
  '+1',
  '1e2',
  '01',
  ' 1 ',
  '9999',
  '1',
];

/** Each entry is the value after --limit, or null for the flag with no value at all. */
const LIMIT_FORMS: readonly (string | null)[] = ['0', '-1', 'abc', '1.5', '1abc', '', null, 'Infinity', '0x10', '1e2', ' 5 ', '5'];

interface NounSpec {
  readonly command: string;
  /** Writes row 1, the row every accepted id form lands on. */
  readonly seed: (store: string) => void;
  /** A verb that takes an id, followed by the flags that make the call valid once the id is read. */
  readonly idVerbs: readonly (readonly string[])[];
}

function seedOf(type: string): (store: string) => void {
  return (store) => {
    const spec = TYPED_OBJECT_SPECS.find((s) => s.type === type);
    if (!spec) throw new Error(`no typed object named ${type}`);
    spec.save(store, 'default', { label: 'cli' });
  };
}

// Reading verbs come first: the first accepted id on a writing verb uses up row 1, and later ones show the store's refusal.
const NOUNS: readonly NounSpec[] = [
  {
    command: 'predict',
    seed: (store) => { savePrediction(store, 'default', { classTag: 'release', claimText: 'Ships by Friday' }); },
    idVerbs: [['show'], ['close', '--state', 'closed']],
  },
  { command: 'decide', seed: seedOf('decision'), idVerbs: [['get'], ['close']] },
  { command: 'incident', seed: seedOf('incident'), idVerbs: [['get'], ['resolve', '--resolution', 'rolled back'], ['close']] },
  { command: 'process', seed: seedOf('process'), idVerbs: [['get'], ['supersede', '--step', 'sign the build'], ['close']] },
  { command: 'policy', seed: seedOf('policy'), idVerbs: [['get'], ['supersede', '--text', 'Delete logs after 30 days'], ['close']] },
  { command: 'skill', seed: seedOf('skill'), idVerbs: [['get'], ['supersede', '--instructions', 'Check both paths'], ['close']] },
  { command: 'brief', seed: seedOf('project brief'), idVerbs: [['get'], ['supersede', '--summary', 'Storefront and admin app'], ['close']] },
  { command: 'note', seed: seedOf('customer note'), idVerbs: [['get'], ['supersede', '--text', 'Prefers a call'], ['close']] },
];

const savedCwd = process.cwd();
let root: string;

beforeAll(() => {
  root = makeRoot('cli-object-parsers');
  // The CLI looks for the store in `.hippo` under the working directory.
  const store = join(root, '.hippo');
  initStore(store);
  for (const noun of NOUNS) noun.seed(store);
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  // An empty tenant falls through to `default`, whatever the shell running the suite has set.
  vi.stubEnv('HIPPO_TENANT', '');
  process.chdir(root);
});

afterAll(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const flat = (text: string): string => text.trimEnd().split('\n').join(' / ');

/** Exit code, all of stderr, and the first stdout line: the rest of stdout carries the clock. */
async function outcome(args: readonly string[]): Promise<string> {
  const res = await runInProcess(() => runCli(['node', 'hippo', ...args]));
  const parts = [`exit ${res.status}`];
  if (res.stderr) parts.push(`stderr: ${flat(res.stderr)}`);
  if (res.stdout) parts.push(`stdout: ${res.stdout.split('\n')[0]}`);
  return maskVolatile(parts.join(' | '));
}

async function transcript(noun: NounSpec): Promise<string> {
  const lines: string[] = [];
  for (const [verb, ...flags] of noun.idVerbs) {
    lines.push(`${verb} (no id): ${await outcome([noun.command, verb, ...flags])}`);
    for (const id of ID_FORMS) {
      lines.push(`${verb} ${JSON.stringify(id)}: ${await outcome([noun.command, verb, id, ...flags])}`);
    }
  }
  for (const limit of LIMIT_FORMS) {
    const flag = limit === null ? ['--limit'] : [`--limit=${limit}`];
    lines.push(`list ${flag[0]}: ${await outcome([noun.command, 'list', ...flag])}`);
  }
  // The spaced form takes the next token as the value, which is the only way a leading minus reaches the flag unglued.
  lines.push(`list --limit -1: ${await outcome([noun.command, 'list', '--limit', '-1'])}`);
  lines.push(`list --limit 2: ${await outcome([noun.command, 'list', '--limit', '2'])}`);
  return lines.join('\n');
}

const nounOf = (command: string): NounSpec => {
  const noun = NOUNS.find((n) => n.command === command);
  if (!noun) throw new Error(`no noun named ${command}`);
  return noun;
};

describe('typed-object CLI verbs: id and --limit parsing as printed today', () => {
  it('predict', async () => {
    expect(await transcript(nounOf('predict'))).toMatchInlineSnapshot(`
      "show (no id): exit 1 | stderr: Usage: hippo predict show <id>
      show "abc": exit 1 | stderr: Invalid prediction id: "abc"
      show "0": exit 1 | stderr: Invalid prediction id: "0"
      show "-1": exit 1 | stderr: Invalid prediction id: "-1"
      show "1.5": exit 0 | stdout: Prediction #1
      show "1abc": exit 0 | stdout: Prediction #1
      show "": exit 1 | stderr: Usage: hippo predict show <id>
      show "+1": exit 0 | stdout: Prediction #1
      show "1e2": exit 0 | stdout: Prediction #1
      show "01": exit 0 | stdout: Prediction #1
      show " 1 ": exit 0 | stdout: Prediction #1
      show "9999": exit 1 | stderr: Prediction 9999 not found.
      show "1": exit 0 | stdout: Prediction #1
      close (no id): exit 1 | stderr: Usage: hippo predict close <id> --state <closed|closed-unknown> [--actual <v>] [--note "..."]
      close "abc": exit 1 | stderr: Invalid prediction id: "abc"
      close "0": exit 1 | stderr: Invalid prediction id: "0"
      close "-1": exit 1 | stderr: Invalid prediction id: "-1"
      close "1.5": exit 0 | stdout: Prediction 1 closed: state=closed
      close "1abc": exit 1 | stderr: Error: closePrediction: prediction 1 is already closed (state='closed'); cannot re-close. Open predictions only.
      close "": exit 1 | stderr: Usage: hippo predict close <id> --state <closed|closed-unknown> [--actual <v>] [--note "..."]
      close "+1": exit 1 | stderr: Error: closePrediction: prediction 1 is already closed (state='closed'); cannot re-close. Open predictions only.
      close "1e2": exit 1 | stderr: Error: closePrediction: prediction 1 is already closed (state='closed'); cannot re-close. Open predictions only.
      close "01": exit 1 | stderr: Error: closePrediction: prediction 1 is already closed (state='closed'); cannot re-close. Open predictions only.
      close " 1 ": exit 1 | stderr: Error: closePrediction: prediction 1 is already closed (state='closed'); cannot re-close. Open predictions only.
      close "9999": exit 1 | stderr: Error: closePrediction: prediction 9999 not found for tenant default
      close "1": exit 1 | stderr: Error: closePrediction: prediction 1 is already closed (state='closed'); cannot re-close. Open predictions only.
      list --limit=0: exit 1 | stderr: Invalid --limit: "0". Must be a positive integer.
      list --limit=-1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit=abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=1.5: exit 0 | stdout: Found 1 predictions:
      list --limit=1abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=: exit 1 | stderr: --limit requires a numeric value.
      list --limit: exit 1 | stderr: --limit requires a numeric value.
      list --limit=Infinity: exit 1 | stderr: --limit requires a numeric value.
      list --limit=0x10: exit 1 | stderr: Invalid --limit: "0x10". Must be a positive integer.
      list --limit=1e2: exit 0 | stdout: Found 1 predictions:
      list --limit= 5 : exit 0 | stdout: Found 1 predictions:
      list --limit=5: exit 0 | stdout: Found 1 predictions:
      list --limit -1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit 2: exit 0 | stdout: Found 1 predictions:"
    `);
  });

  it('decide', async () => {
    expect(await transcript(nounOf('decide'))).toMatchInlineSnapshot(`
      "get (no id): exit 1 | stderr: Usage: hippo decide get <id>
      get "abc": exit 1 | stderr: Invalid decision id: "abc"
      get "0": exit 1 | stderr: Invalid decision id: "0"
      get "-1": exit 1 | stderr: Invalid decision id: "-1"
      get "1.5": exit 0 | stdout: Decision #1
      get "1abc": exit 0 | stdout: Decision #1
      get "": exit 1 | stderr: Usage: hippo decide get <id>
      get "+1": exit 0 | stdout: Decision #1
      get "1e2": exit 0 | stdout: Decision #1
      get "01": exit 0 | stdout: Decision #1
      get " 1 ": exit 0 | stdout: Decision #1
      get "9999": exit 1 | stderr: Decision 9999 not found.
      get "1": exit 0 | stdout: Decision #1
      close (no id): exit 1 | stderr: Usage: hippo decide close <id>
      close "abc": exit 1 | stderr: Invalid decision id: "abc"
      close "0": exit 1 | stderr: Invalid decision id: "0"
      close "-1": exit 1 | stderr: Invalid decision id: "-1"
      close "1.5": exit 0 | stdout: Decision #1 closed.
      close "1abc": exit 1 | stderr: Error: closeDecision: decision 1 is not active (status='closed'); only active decisions can be closed.
      close "": exit 1 | stderr: Usage: hippo decide close <id>
      close "+1": exit 1 | stderr: Error: closeDecision: decision 1 is not active (status='closed'); only active decisions can be closed.
      close "1e2": exit 1 | stderr: Error: closeDecision: decision 1 is not active (status='closed'); only active decisions can be closed.
      close "01": exit 1 | stderr: Error: closeDecision: decision 1 is not active (status='closed'); only active decisions can be closed.
      close " 1 ": exit 1 | stderr: Error: closeDecision: decision 1 is not active (status='closed'); only active decisions can be closed.
      close "9999": exit 1 | stderr: Error: closeDecision: decision 9999 not found for tenant default
      close "1": exit 1 | stderr: Error: closeDecision: decision 1 is not active (status='closed'); only active decisions can be closed.
      list --limit=0: exit 1 | stderr: Invalid --limit: "0". Must be a positive integer.
      list --limit=-1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit=abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=1.5: exit 0 | stdout: Found 1 decisions:
      list --limit=1abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=: exit 1 | stderr: --limit requires a numeric value.
      list --limit: exit 1 | stderr: --limit requires a numeric value.
      list --limit=Infinity: exit 1 | stderr: --limit requires a numeric value.
      list --limit=0x10: exit 1 | stderr: Invalid --limit: "0x10". Must be a positive integer.
      list --limit=1e2: exit 0 | stdout: Found 1 decisions:
      list --limit= 5 : exit 0 | stdout: Found 1 decisions:
      list --limit=5: exit 0 | stdout: Found 1 decisions:
      list --limit -1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit 2: exit 0 | stdout: Found 1 decisions:"
    `);
  });

  it('incident', async () => {
    expect(await transcript(nounOf('incident'))).toMatchInlineSnapshot(`
      "get (no id): exit 1 | stderr: Usage: hippo incident get <id>
      get "abc": exit 1 | stderr: Invalid incident id: "abc" (expected a positive integer).
      get "0": exit 1 | stderr: Invalid incident id: "0" (expected a positive integer).
      get "-1": exit 1 | stderr: Invalid incident id: "-1" (expected a positive integer).
      get "1.5": exit 1 | stderr: Invalid incident id: "1.5" (expected a positive integer).
      get "1abc": exit 1 | stderr: Invalid incident id: "1abc" (expected a positive integer).
      get "": exit 1 | stderr: Usage: hippo incident get <id>
      get "+1": exit 1 | stderr: Invalid incident id: "+1" (expected a positive integer).
      get "1e2": exit 1 | stderr: Invalid incident id: "1e2" (expected a positive integer).
      get "01": exit 0 | stdout: Incident #1
      get " 1 ": exit 0 | stdout: Incident #1
      get "9999": exit 1 | stderr: Incident 9999 not found.
      get "1": exit 0 | stdout: Incident #1
      resolve (no id): exit 1 | stderr: Usage: hippo incident resolve <id> --resolution "<text>"
      resolve "abc": exit 1 | stderr: Invalid incident id: "abc" (expected a positive integer).
      resolve "0": exit 1 | stderr: Invalid incident id: "0" (expected a positive integer).
      resolve "-1": exit 1 | stderr: Invalid incident id: "-1" (expected a positive integer).
      resolve "1.5": exit 1 | stderr: Invalid incident id: "1.5" (expected a positive integer).
      resolve "1abc": exit 1 | stderr: Invalid incident id: "1abc" (expected a positive integer).
      resolve "": exit 1 | stderr: Usage: hippo incident resolve <id> --resolution "<text>"
      resolve "+1": exit 1 | stderr: Invalid incident id: "+1" (expected a positive integer).
      resolve "1e2": exit 1 | stderr: Invalid incident id: "1e2" (expected a positive integer).
      resolve "01": exit 0 | stdout: Incident #1 resolved.
      resolve " 1 ": exit 1 | stderr: Error: resolveIncident: incident 1 is not open (status='resolved'); only open incidents can be resolved.
      resolve "9999": exit 1 | stderr: Error: resolveIncident: incident 9999 not found for tenant default
      resolve "1": exit 1 | stderr: Error: resolveIncident: incident 1 is not open (status='resolved'); only open incidents can be resolved.
      close (no id): exit 1 | stderr: Usage: hippo incident close <id>
      close "abc": exit 1 | stderr: Invalid incident id: "abc" (expected a positive integer).
      close "0": exit 1 | stderr: Invalid incident id: "0" (expected a positive integer).
      close "-1": exit 1 | stderr: Invalid incident id: "-1" (expected a positive integer).
      close "1.5": exit 1 | stderr: Invalid incident id: "1.5" (expected a positive integer).
      close "1abc": exit 1 | stderr: Invalid incident id: "1abc" (expected a positive integer).
      close "": exit 1 | stderr: Usage: hippo incident close <id>
      close "+1": exit 1 | stderr: Invalid incident id: "+1" (expected a positive integer).
      close "1e2": exit 1 | stderr: Invalid incident id: "1e2" (expected a positive integer).
      close "01": exit 0 | stdout: Incident #1 closed.
      close " 1 ": exit 1 | stderr: Error: closeIncident: incident 1 is already closed (status='closed'); only open or resolved incidents can be closed.
      close "9999": exit 1 | stderr: Error: closeIncident: incident 9999 not found for tenant default
      close "1": exit 1 | stderr: Error: closeIncident: incident 1 is already closed (status='closed'); only open or resolved incidents can be closed.
      list --limit=0: exit 1 | stderr: Invalid --limit: "0". Must be a positive integer.
      list --limit=-1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit=abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=1.5: exit 0 | stdout: Found 1 incidents:
      list --limit=1abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=: exit 1 | stderr: --limit requires a numeric value.
      list --limit: exit 1 | stderr: --limit requires a numeric value.
      list --limit=Infinity: exit 1 | stderr: --limit requires a numeric value.
      list --limit=0x10: exit 1 | stderr: Invalid --limit: "0x10". Must be a positive integer.
      list --limit=1e2: exit 0 | stdout: Found 1 incidents:
      list --limit= 5 : exit 0 | stdout: Found 1 incidents:
      list --limit=5: exit 0 | stdout: Found 1 incidents:
      list --limit -1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit 2: exit 0 | stdout: Found 1 incidents:"
    `);
  });

  it('process', async () => {
    expect(await transcript(nounOf('process'))).toMatchInlineSnapshot(`
      "get (no id): exit 1 | stderr: Usage: hippo process get <id>
      get "abc": exit 1 | stderr: Invalid process id: "abc" (expected a positive integer).
      get "0": exit 1 | stderr: Invalid process id: "0" (expected a positive integer).
      get "-1": exit 1 | stderr: Invalid process id: "-1" (expected a positive integer).
      get "1.5": exit 1 | stderr: Invalid process id: "1.5" (expected a positive integer).
      get "1abc": exit 1 | stderr: Invalid process id: "1abc" (expected a positive integer).
      get "": exit 1 | stderr: Usage: hippo process get <id>
      get "+1": exit 1 | stderr: Invalid process id: "+1" (expected a positive integer).
      get "1e2": exit 1 | stderr: Invalid process id: "1e2" (expected a positive integer).
      get "01": exit 0 | stdout: Process #1
      get " 1 ": exit 0 | stdout: Process #1
      get "9999": exit 1 | stderr: Process 9999 not found.
      get "1": exit 0 | stdout: Process #1
      supersede (no id): exit 1 | stderr: Usage: hippo process supersede <id> --step "<text>" [--step ...] [--change "<summary>"] [--description "<text>"]
      supersede "abc": exit 1 | stderr: Invalid process id: "abc" (expected a positive integer).
      supersede "0": exit 1 | stderr: Invalid process id: "0" (expected a positive integer).
      supersede "-1": exit 1 | stderr: Invalid process id: "-1" (expected a positive integer).
      supersede "1.5": exit 1 | stderr: Invalid process id: "1.5" (expected a positive integer).
      supersede "1abc": exit 1 | stderr: Invalid process id: "1abc" (expected a positive integer).
      supersede "": exit 1 | stderr: Usage: hippo process supersede <id> --step "<text>" [--step ...] [--change "<summary>"] [--description "<text>"]
      supersede "+1": exit 1 | stderr: Invalid process id: "+1" (expected a positive integer).
      supersede "1e2": exit 1 | stderr: Invalid process id: "1e2" (expected a positive integer).
      supersede "01": exit 0 | stdout: Process #2 recorded (v2), superseding #1.
      supersede " 1 ": exit 1 | stderr: Error: saveProcess: process 1 is not active (status='superseded'); only active processes can be superseded.
      supersede "9999": exit 1 | stderr: Process 9999 not found.
      supersede "1": exit 1 | stderr: Error: saveProcess: process 1 is not active (status='superseded'); only active processes can be superseded.
      close (no id): exit 1 | stderr: Usage: hippo process close <id>
      close "abc": exit 1 | stderr: Invalid process id: "abc" (expected a positive integer).
      close "0": exit 1 | stderr: Invalid process id: "0" (expected a positive integer).
      close "-1": exit 1 | stderr: Invalid process id: "-1" (expected a positive integer).
      close "1.5": exit 1 | stderr: Invalid process id: "1.5" (expected a positive integer).
      close "1abc": exit 1 | stderr: Invalid process id: "1abc" (expected a positive integer).
      close "": exit 1 | stderr: Usage: hippo process close <id>
      close "+1": exit 1 | stderr: Invalid process id: "+1" (expected a positive integer).
      close "1e2": exit 1 | stderr: Invalid process id: "1e2" (expected a positive integer).
      close "01": exit 1 | stderr: Error: closeProcess: process 1 is not active (status='superseded'); only active processes can be closed.
      close " 1 ": exit 1 | stderr: Error: closeProcess: process 1 is not active (status='superseded'); only active processes can be closed.
      close "9999": exit 1 | stderr: Error: closeProcess: process 9999 not found for tenant default
      close "1": exit 1 | stderr: Error: closeProcess: process 1 is not active (status='superseded'); only active processes can be closed.
      list --limit=0: exit 1 | stderr: Invalid --limit: "0". Must be a positive integer.
      list --limit=-1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit=abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=1.5: exit 0 | stdout: Found 1 processes:
      list --limit=1abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=: exit 1 | stderr: --limit requires a numeric value.
      list --limit: exit 1 | stderr: --limit requires a numeric value.
      list --limit=Infinity: exit 1 | stderr: --limit requires a numeric value.
      list --limit=0x10: exit 1 | stderr: Invalid --limit: "0x10". Must be a positive integer.
      list --limit=1e2: exit 0 | stdout: Found 1 processes:
      list --limit= 5 : exit 0 | stdout: Found 2 processes:
      list --limit=5: exit 0 | stdout: Found 2 processes:
      list --limit -1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit 2: exit 0 | stdout: Found 2 processes:"
    `);
  });

  it('policy', async () => {
    expect(await transcript(nounOf('policy'))).toMatchInlineSnapshot(`
      "get (no id): exit 1 | stderr: Usage: hippo policy get <id>
      get "abc": exit 1 | stderr: Invalid policy id: "abc" (expected a positive integer).
      get "0": exit 1 | stderr: Invalid policy id: "0" (expected a positive integer).
      get "-1": exit 1 | stderr: Invalid policy id: "-1" (expected a positive integer).
      get "1.5": exit 1 | stderr: Invalid policy id: "1.5" (expected a positive integer).
      get "1abc": exit 1 | stderr: Invalid policy id: "1abc" (expected a positive integer).
      get "": exit 1 | stderr: Usage: hippo policy get <id>
      get "+1": exit 1 | stderr: Invalid policy id: "+1" (expected a positive integer).
      get "1e2": exit 1 | stderr: Invalid policy id: "1e2" (expected a positive integer).
      get "01": exit 0 | stdout: Policy #1
      get " 1 ": exit 0 | stdout: Policy #1
      get "9999": exit 1 | stderr: Policy 9999 not found.
      get "1": exit 0 | stdout: Policy #1
      supersede (no id): exit 1 | stderr: Usage: hippo policy supersede <id> --text "<rule>" [--from <iso>] [--to <iso>] [--change "<summary>"]
      supersede "abc": exit 1 | stderr: Invalid policy id: "abc" (expected a positive integer).
      supersede "0": exit 1 | stderr: Invalid policy id: "0" (expected a positive integer).
      supersede "-1": exit 1 | stderr: Invalid policy id: "-1" (expected a positive integer).
      supersede "1.5": exit 1 | stderr: Invalid policy id: "1.5" (expected a positive integer).
      supersede "1abc": exit 1 | stderr: Invalid policy id: "1abc" (expected a positive integer).
      supersede "": exit 1 | stderr: Usage: hippo policy supersede <id> --text "<rule>" [--from <iso>] [--to <iso>] [--change "<summary>"]
      supersede "+1": exit 1 | stderr: Invalid policy id: "+1" (expected a positive integer).
      supersede "1e2": exit 1 | stderr: Invalid policy id: "1e2" (expected a positive integer).
      supersede "01": exit 0 | stdout: Policy #2 recorded (v2), superseding #1.
      supersede " 1 ": exit 1 | stderr: savePolicy: policy 1 is not active (status='superseded'); only active policies can be superseded.
      supersede "9999": exit 1 | stderr: Policy 9999 not found.
      supersede "1": exit 1 | stderr: savePolicy: policy 1 is not active (status='superseded'); only active policies can be superseded.
      close (no id): exit 1 | stderr: Usage: hippo policy close <id>
      close "abc": exit 1 | stderr: Invalid policy id: "abc" (expected a positive integer).
      close "0": exit 1 | stderr: Invalid policy id: "0" (expected a positive integer).
      close "-1": exit 1 | stderr: Invalid policy id: "-1" (expected a positive integer).
      close "1.5": exit 1 | stderr: Invalid policy id: "1.5" (expected a positive integer).
      close "1abc": exit 1 | stderr: Invalid policy id: "1abc" (expected a positive integer).
      close "": exit 1 | stderr: Usage: hippo policy close <id>
      close "+1": exit 1 | stderr: Invalid policy id: "+1" (expected a positive integer).
      close "1e2": exit 1 | stderr: Invalid policy id: "1e2" (expected a positive integer).
      close "01": exit 1 | stderr: Error: closePolicy: policy 1 is not active (status='superseded'); only active policies can be closed.
      close " 1 ": exit 1 | stderr: Error: closePolicy: policy 1 is not active (status='superseded'); only active policies can be closed.
      close "9999": exit 1 | stderr: Error: closePolicy: policy 9999 not found for tenant default
      close "1": exit 1 | stderr: Error: closePolicy: policy 1 is not active (status='superseded'); only active policies can be closed.
      list --limit=0: exit 1 | stderr: Invalid --limit: "0". Must be a positive integer.
      list --limit=-1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit=abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=1.5: exit 0 | stdout: Found 1 policies:
      list --limit=1abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=: exit 1 | stderr: --limit requires a numeric value.
      list --limit: exit 1 | stderr: --limit requires a numeric value.
      list --limit=Infinity: exit 1 | stderr: --limit requires a numeric value.
      list --limit=0x10: exit 1 | stderr: Invalid --limit: "0x10". Must be a positive integer.
      list --limit=1e2: exit 0 | stdout: Found 1 policies:
      list --limit= 5 : exit 0 | stdout: Found 2 policies:
      list --limit=5: exit 0 | stdout: Found 2 policies:
      list --limit -1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit 2: exit 0 | stdout: Found 2 policies:"
    `);
  });

  it('skill', async () => {
    expect(await transcript(nounOf('skill'))).toMatchInlineSnapshot(`
      "get (no id): exit 1 | stderr: Usage: hippo skill get <id>
      get "abc": exit 1 | stderr: Invalid skill id: "abc" (expected a positive integer).
      get "0": exit 1 | stderr: Invalid skill id: "0" (expected a positive integer).
      get "-1": exit 1 | stderr: Invalid skill id: "-1" (expected a positive integer).
      get "1.5": exit 1 | stderr: Invalid skill id: "1.5" (expected a positive integer).
      get "1abc": exit 1 | stderr: Invalid skill id: "1abc" (expected a positive integer).
      get "": exit 1 | stderr: Usage: hippo skill get <id>
      get "+1": exit 1 | stderr: Invalid skill id: "+1" (expected a positive integer).
      get "1e2": exit 1 | stderr: Invalid skill id: "1e2" (expected a positive integer).
      get "01": exit 0 | stdout: Skill #1
      get " 1 ": exit 0 | stdout: Skill #1
      get "9999": exit 1 | stderr: Skill 9999 not found.
      get "1": exit 0 | stdout: Skill #1
      supersede (no id): exit 1 | stderr: Usage: hippo skill supersede <id> --instructions "<text>" [--trigger "<when>"] [--change "<summary>"]
      supersede "abc": exit 1 | stderr: Invalid skill id: "abc" (expected a positive integer).
      supersede "0": exit 1 | stderr: Invalid skill id: "0" (expected a positive integer).
      supersede "-1": exit 1 | stderr: Invalid skill id: "-1" (expected a positive integer).
      supersede "1.5": exit 1 | stderr: Invalid skill id: "1.5" (expected a positive integer).
      supersede "1abc": exit 1 | stderr: Invalid skill id: "1abc" (expected a positive integer).
      supersede "": exit 1 | stderr: Usage: hippo skill supersede <id> --instructions "<text>" [--trigger "<when>"] [--change "<summary>"]
      supersede "+1": exit 1 | stderr: Invalid skill id: "+1" (expected a positive integer).
      supersede "1e2": exit 1 | stderr: Invalid skill id: "1e2" (expected a positive integer).
      supersede "01": exit 0 | stdout: Skill #2 recorded (v2), superseding #1.
      supersede " 1 ": exit 1 | stderr: saveSkill: skill 1 is not active (status='superseded'); only active skills can be superseded.
      supersede "9999": exit 1 | stderr: Skill 9999 not found.
      supersede "1": exit 1 | stderr: saveSkill: skill 1 is not active (status='superseded'); only active skills can be superseded.
      close (no id): exit 1 | stderr: Usage: hippo skill close <id>
      close "abc": exit 1 | stderr: Invalid skill id: "abc" (expected a positive integer).
      close "0": exit 1 | stderr: Invalid skill id: "0" (expected a positive integer).
      close "-1": exit 1 | stderr: Invalid skill id: "-1" (expected a positive integer).
      close "1.5": exit 1 | stderr: Invalid skill id: "1.5" (expected a positive integer).
      close "1abc": exit 1 | stderr: Invalid skill id: "1abc" (expected a positive integer).
      close "": exit 1 | stderr: Usage: hippo skill close <id>
      close "+1": exit 1 | stderr: Invalid skill id: "+1" (expected a positive integer).
      close "1e2": exit 1 | stderr: Invalid skill id: "1e2" (expected a positive integer).
      close "01": exit 1 | stderr: Error: closeSkill: skill 1 is not active (status='superseded'); only active skills can be closed.
      close " 1 ": exit 1 | stderr: Error: closeSkill: skill 1 is not active (status='superseded'); only active skills can be closed.
      close "9999": exit 1 | stderr: Error: closeSkill: skill 9999 not found for tenant default
      close "1": exit 1 | stderr: Error: closeSkill: skill 1 is not active (status='superseded'); only active skills can be closed.
      list --limit=0: exit 1 | stderr: Invalid --limit: "0". Must be a positive integer.
      list --limit=-1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit=abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=1.5: exit 0 | stdout: Found 1 skills:
      list --limit=1abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=: exit 1 | stderr: --limit requires a numeric value.
      list --limit: exit 1 | stderr: --limit requires a numeric value.
      list --limit=Infinity: exit 1 | stderr: --limit requires a numeric value.
      list --limit=0x10: exit 1 | stderr: Invalid --limit: "0x10". Must be a positive integer.
      list --limit=1e2: exit 0 | stdout: Found 1 skills:
      list --limit= 5 : exit 0 | stdout: Found 2 skills:
      list --limit=5: exit 0 | stdout: Found 2 skills:
      list --limit -1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit 2: exit 0 | stdout: Found 2 skills:"
    `);
  });

  it('brief', async () => {
    expect(await transcript(nounOf('brief'))).toMatchInlineSnapshot(`
      "get (no id): exit 1 | stderr: Usage: hippo brief get <id>
      get "abc": exit 1 | stderr: Invalid brief id: "abc" (expected a positive integer).
      get "0": exit 1 | stderr: Invalid brief id: "0" (expected a positive integer).
      get "-1": exit 1 | stderr: Invalid brief id: "-1" (expected a positive integer).
      get "1.5": exit 1 | stderr: Invalid brief id: "1.5" (expected a positive integer).
      get "1abc": exit 1 | stderr: Invalid brief id: "1abc" (expected a positive integer).
      get "": exit 1 | stderr: Usage: hippo brief get <id>
      get "+1": exit 1 | stderr: Invalid brief id: "+1" (expected a positive integer).
      get "1e2": exit 1 | stderr: Invalid brief id: "1e2" (expected a positive integer).
      get "01": exit 0 | stdout: Project brief #1
      get " 1 ": exit 0 | stdout: Project brief #1
      get "9999": exit 1 | stderr: Project brief 9999 not found.
      get "1": exit 0 | stdout: Project brief #1
      supersede (no id): exit 1 | stderr: Usage: hippo brief supersede <id> --summary "<text>" [--change "<summary>"]
      supersede "abc": exit 1 | stderr: Invalid brief id: "abc" (expected a positive integer).
      supersede "0": exit 1 | stderr: Invalid brief id: "0" (expected a positive integer).
      supersede "-1": exit 1 | stderr: Invalid brief id: "-1" (expected a positive integer).
      supersede "1.5": exit 1 | stderr: Invalid brief id: "1.5" (expected a positive integer).
      supersede "1abc": exit 1 | stderr: Invalid brief id: "1abc" (expected a positive integer).
      supersede "": exit 1 | stderr: Usage: hippo brief supersede <id> --summary "<text>" [--change "<summary>"]
      supersede "+1": exit 1 | stderr: Invalid brief id: "+1" (expected a positive integer).
      supersede "1e2": exit 1 | stderr: Invalid brief id: "1e2" (expected a positive integer).
      supersede "01": exit 0 | stdout: Project brief #2 recorded (v2), superseding #1.
      supersede " 1 ": exit 1 | stderr: saveProjectBrief: brief 1 is not active (status='superseded'); only active briefs can be superseded.
      supersede "9999": exit 1 | stderr: Project brief 9999 not found.
      supersede "1": exit 1 | stderr: saveProjectBrief: brief 1 is not active (status='superseded'); only active briefs can be superseded.
      close (no id): exit 1 | stderr: Usage: hippo brief close <id>
      close "abc": exit 1 | stderr: Invalid brief id: "abc" (expected a positive integer).
      close "0": exit 1 | stderr: Invalid brief id: "0" (expected a positive integer).
      close "-1": exit 1 | stderr: Invalid brief id: "-1" (expected a positive integer).
      close "1.5": exit 1 | stderr: Invalid brief id: "1.5" (expected a positive integer).
      close "1abc": exit 1 | stderr: Invalid brief id: "1abc" (expected a positive integer).
      close "": exit 1 | stderr: Usage: hippo brief close <id>
      close "+1": exit 1 | stderr: Invalid brief id: "+1" (expected a positive integer).
      close "1e2": exit 1 | stderr: Invalid brief id: "1e2" (expected a positive integer).
      close "01": exit 1 | stderr: Error: closeProjectBrief: brief 1 is not active (status='superseded'); only active briefs can be closed.
      close " 1 ": exit 1 | stderr: Error: closeProjectBrief: brief 1 is not active (status='superseded'); only active briefs can be closed.
      close "9999": exit 1 | stderr: Error: closeProjectBrief: brief 9999 not found for tenant default
      close "1": exit 1 | stderr: Error: closeProjectBrief: brief 1 is not active (status='superseded'); only active briefs can be closed.
      list --limit=0: exit 1 | stderr: Invalid --limit: "0". Must be a positive integer.
      list --limit=-1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit=abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=1.5: exit 0 | stdout: Found 1 project briefs:
      list --limit=1abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=: exit 1 | stderr: --limit requires a numeric value.
      list --limit: exit 1 | stderr: --limit requires a numeric value.
      list --limit=Infinity: exit 1 | stderr: --limit requires a numeric value.
      list --limit=0x10: exit 1 | stderr: Invalid --limit: "0x10". Must be a positive integer.
      list --limit=1e2: exit 0 | stdout: Found 1 project briefs:
      list --limit= 5 : exit 0 | stdout: Found 2 project briefs:
      list --limit=5: exit 0 | stdout: Found 2 project briefs:
      list --limit -1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit 2: exit 0 | stdout: Found 2 project briefs:"
    `);
  });

  it('note', async () => {
    expect(await transcript(nounOf('note'))).toMatchInlineSnapshot(`
      "get (no id): exit 1 | stderr: Usage: hippo note get <id>
      get "abc": exit 1 | stderr: Invalid note id: "abc" (expected a positive integer).
      get "0": exit 1 | stderr: Invalid note id: "0" (expected a positive integer).
      get "-1": exit 1 | stderr: Invalid note id: "-1" (expected a positive integer).
      get "1.5": exit 1 | stderr: Invalid note id: "1.5" (expected a positive integer).
      get "1abc": exit 1 | stderr: Invalid note id: "1abc" (expected a positive integer).
      get "": exit 1 | stderr: Usage: hippo note get <id>
      get "+1": exit 1 | stderr: Invalid note id: "+1" (expected a positive integer).
      get "1e2": exit 1 | stderr: Invalid note id: "1e2" (expected a positive integer).
      get "01": exit 0 | stdout: Customer note #1
      get " 1 ": exit 0 | stdout: Customer note #1
      get "9999": exit 1 | stderr: Customer note 9999 not found.
      get "1": exit 0 | stdout: Customer note #1
      supersede (no id): exit 1 | stderr: Usage: hippo note supersede <id> --text "<note>" [--change "<summary>"]
      supersede "abc": exit 1 | stderr: Invalid note id: "abc" (expected a positive integer).
      supersede "0": exit 1 | stderr: Invalid note id: "0" (expected a positive integer).
      supersede "-1": exit 1 | stderr: Invalid note id: "-1" (expected a positive integer).
      supersede "1.5": exit 1 | stderr: Invalid note id: "1.5" (expected a positive integer).
      supersede "1abc": exit 1 | stderr: Invalid note id: "1abc" (expected a positive integer).
      supersede "": exit 1 | stderr: Usage: hippo note supersede <id> --text "<note>" [--change "<summary>"]
      supersede "+1": exit 1 | stderr: Invalid note id: "+1" (expected a positive integer).
      supersede "1e2": exit 1 | stderr: Invalid note id: "1e2" (expected a positive integer).
      supersede "01": exit 0 | stdout: Customer note #2 recorded (v2), superseding #1.
      supersede " 1 ": exit 1 | stderr: saveCustomerNote: note 1 is not active (status='superseded'); only active notes can be superseded.
      supersede "9999": exit 1 | stderr: Customer note 9999 not found.
      supersede "1": exit 1 | stderr: saveCustomerNote: note 1 is not active (status='superseded'); only active notes can be superseded.
      close (no id): exit 1 | stderr: Usage: hippo note close <id>
      close "abc": exit 1 | stderr: Invalid note id: "abc" (expected a positive integer).
      close "0": exit 1 | stderr: Invalid note id: "0" (expected a positive integer).
      close "-1": exit 1 | stderr: Invalid note id: "-1" (expected a positive integer).
      close "1.5": exit 1 | stderr: Invalid note id: "1.5" (expected a positive integer).
      close "1abc": exit 1 | stderr: Invalid note id: "1abc" (expected a positive integer).
      close "": exit 1 | stderr: Usage: hippo note close <id>
      close "+1": exit 1 | stderr: Invalid note id: "+1" (expected a positive integer).
      close "1e2": exit 1 | stderr: Invalid note id: "1e2" (expected a positive integer).
      close "01": exit 1 | stderr: Error: closeCustomerNote: note 1 is not active (status='superseded'); only active notes can be closed.
      close " 1 ": exit 1 | stderr: Error: closeCustomerNote: note 1 is not active (status='superseded'); only active notes can be closed.
      close "9999": exit 1 | stderr: Error: closeCustomerNote: note 9999 not found for tenant default
      close "1": exit 1 | stderr: Error: closeCustomerNote: note 1 is not active (status='superseded'); only active notes can be closed.
      list --limit=0: exit 1 | stderr: Invalid --limit: "0". Must be a positive integer.
      list --limit=-1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit=abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=1.5: exit 0 | stdout: Found 1 customer notes:
      list --limit=1abc: exit 1 | stderr: --limit requires a numeric value.
      list --limit=: exit 1 | stderr: --limit requires a numeric value.
      list --limit: exit 1 | stderr: --limit requires a numeric value.
      list --limit=Infinity: exit 1 | stderr: --limit requires a numeric value.
      list --limit=0x10: exit 1 | stderr: Invalid --limit: "0x10". Must be a positive integer.
      list --limit=1e2: exit 0 | stdout: Found 1 customer notes:
      list --limit= 5 : exit 0 | stdout: Found 2 customer notes:
      list --limit=5: exit 0 | stdout: Found 2 customer notes:
      list --limit -1: exit 1 | stderr: Invalid --limit: "-1". Must be a positive integer.
      list --limit 2: exit 0 | stdout: Found 2 customer notes:"
    `);
  });
});
