// Pins the exact 400 body of every field check in the seven typed-object route files, so merged handlers keep each one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectApi, routeOf, type Body } from './_helpers/typed-object-http.js';
import { Transcript } from './_helpers/typed-object-specs.js';

let api: ObjectApi;
beforeAll(async () => {
  api = await ObjectApi.start('a8fields');
});
afterAll(async () => {
  await api.stop();
});

/** A POST to `<path><suffix>`; `'status'` prints only the code of an accepted reply, whose body would be thousands of characters. */
type Case = readonly [label: string, suffix: string, body: Body, show?: 'status'];

const x = (length: number): string => 'x'.repeat(length);
const many = (count: number, item: string): string[] => Array.from({ length: count }, () => item);
const without = (body: Body, field: string): Body => Object.fromEntries(Object.entries(body).filter(([key]) => key !== field));
/** An accepted supersede or resolve uses up its target, so the case asks for a row of its own. */
const onFreshRow = (suffix: string): string => suffix.replace('/1/', '/{new}/');

function requiredText(where: string, suffix: string, base: Body, field: string, cap: number): Case[] {
  return [
    [`${where}, no ${field}`, suffix, without(base, field)],
    [`${where}, ${field} a number`, suffix, { ...base, [field]: 5 }],
    [`${where}, ${field} null`, suffix, { ...base, [field]: null }],
    [`${where}, ${field} empty`, suffix, { ...base, [field]: '' }],
    [`${where}, ${field} blank`, suffix, { ...base, [field]: '   ' }],
    [`${where}, ${field} over the ${cap} cap`, suffix, { ...base, [field]: x(cap + 1) }],
    [`${where}, ${field} at the ${cap} cap`, onFreshRow(suffix), { ...base, [field]: x(cap) }, 'status'],
  ];
}

function optionalText(where: string, suffix: string, base: Body, field: string, cap: number): Case[] {
  return [
    [`${where}, ${field} a number`, suffix, { ...base, [field]: 5 }],
    [`${where}, ${field} over the ${cap} cap`, suffix, { ...base, [field]: x(cap + 1) }],
    [`${where}, ${field} at the ${cap} cap`, onFreshRow(suffix), { ...base, [field]: x(cap) }, 'status'],
    [`${where}, ${field} null`, onFreshRow(suffix), { ...base, [field]: null }, 'status'],
  ];
}

const RAW_BODIES = ['not json', '[1]', '"text"', 'null', ''];

/** Sends every raw body to each suffix, then every case, and returns one line per reply. */
async function refusals(type: string, rawSuffixes: readonly string[], cases: readonly Case[]): Promise<string> {
  const spec = routeOf(type);
  const t = new Transcript();
  t.say('seed row 1', (await api.send('POST', spec.path, spec.create)).status);
  for (const suffix of rawSuffixes) {
    for (const raw of RAW_BODIES) {
      t.say(`POST ${suffix || '(create)'} with body ${JSON.stringify(raw)}`, (await api.sendRaw('POST', `${spec.path}${suffix}`, raw)).line);
    }
  }
  for (const [label, suffix, body, show] of cases) {
    let target = suffix;
    if (suffix.includes('{new}')) {
      const fresh = await api.send('POST', spec.path, spec.create);
      target = suffix.replace('{new}', /"id":(\d+)/.exec(fresh.text)?.[1] ?? '(no id)');
    }
    const reply = await api.send('POST', `${spec.path}${target}`, body);
    const accepted = reply.status >= 200 && reply.status < 300;
    t.say(label, show === 'status' && accepted ? reply.status : reply.line);
  }
  t.say('row 1 afterwards', (await api.send('GET', `${spec.path}/1`)).line);
  return t.text();
}

describe('typed-object routes: field checks', () => {
  it('decision', async () => {
    const create = routeOf('decision').create;
    const revise = { text: 'Use SQLite for billing' };
    expect(await refusals('decision', ['', '/1/supersede'], [
      ...requiredText('create', '', create, 'text', 4096),
      ['create, two-character text', '', { text: 'ab' }],
      ...optionalText('create', '', create, 'context', 4096),
      ['create, supersedesDecisionId a string', '', { ...create, supersedesDecisionId: '1' }],
      ['create, supersedesDecisionId zero', '', { ...create, supersedesDecisionId: 0 }],
      ['create, supersedesDecisionId negative', '', { ...create, supersedesDecisionId: -1 }],
      ['create, supersedesDecisionId a fraction', '', { ...create, supersedesDecisionId: 1.5 }],
      ['create, supersedesDecisionId a boolean', '', { ...create, supersedesDecisionId: true }],
      ['create, supersedesDecisionId null', '', { ...create, supersedesDecisionId: null }, 'status'],
      ['create, bad context and bad supersedesDecisionId', '', { ...create, context: 5, supersedesDecisionId: 0 }],
      ...requiredText('supersede', '/1/supersede', revise, 'text', 4096),
      ...optionalText('supersede', '/1/supersede', revise, 'context', 4096),
      ['supersede, empty body on a missing id', '/9999/supersede', {}],
    ])).toMatchInlineSnapshot(`
      "seed row 1: 201
      POST (create) with body "not json": 400 {"error":"invalid JSON body"}
      POST (create) with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "null": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "": 400 {"error":"text is required (non-empty string)"}
      POST /1/supersede with body "not json": 400 {"error":"invalid JSON body"}
      POST /1/supersede with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "null": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "": 400 {"error":"text is required (non-empty string)"}
      create, no text: 400 {"error":"text is required (non-empty string)"}
      create, text a number: 400 {"error":"text is required (non-empty string)"}
      create, text null: 400 {"error":"text is required (non-empty string)"}
      create, text empty: 400 {"error":"text is required (non-empty string)"}
      create, text blank: 201 {"decision":{"id":2,"memoryId":"<mem>","tenantId":"default","decisionText":"   ","context":"cheaper to run","status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"}}
      create, text over the 4096 cap: 400 {"error":"text exceeds 4096-character cap"}
      create, text at the 4096 cap: 201
      create, two-character text: 400 {"error":"Memory content too short (2 chars, minimum 3): \\"ab\\""}
      create, context a number: 400 {"error":"context must be a string"}
      create, context over the 4096 cap: 400 {"error":"context exceeds 4096-character cap"}
      create, context at the 4096 cap: 201
      create, context null: 201
      create, supersedesDecisionId a string: 400 {"error":"supersedesDecisionId must be a positive integer"}
      create, supersedesDecisionId zero: 400 {"error":"supersedesDecisionId must be a positive integer"}
      create, supersedesDecisionId negative: 400 {"error":"supersedesDecisionId must be a positive integer"}
      create, supersedesDecisionId a fraction: 400 {"error":"supersedesDecisionId must be a positive integer"}
      create, supersedesDecisionId a boolean: 400 {"error":"supersedesDecisionId must be a positive integer"}
      create, supersedesDecisionId null: 201
      create, bad context and bad supersedesDecisionId: 400 {"error":"context must be a string"}
      supersede, no text: 400 {"error":"text is required (non-empty string)"}
      supersede, text a number: 400 {"error":"text is required (non-empty string)"}
      supersede, text null: 400 {"error":"text is required (non-empty string)"}
      supersede, text empty: 400 {"error":"text is required (non-empty string)"}
      supersede, text blank: 400 {"error":"Memory content too short (0 chars, minimum 3): \\"\\""}
      supersede, text over the 4096 cap: 400 {"error":"text exceeds 4096-character cap"}
      supersede, text at the 4096 cap: 201
      supersede, context a number: 400 {"error":"context must be a string"}
      supersede, context over the 4096 cap: 400 {"error":"context exceeds 4096-character cap"}
      supersede, context at the 4096 cap: 201
      supersede, context null: 201
      supersede, empty body on a missing id: 400 {"error":"text is required (non-empty string)"}
      row 1 afterwards: 200 {"decision":{"id":1,"memoryId":"<mem>","tenantId":"default","decisionText":"Use Postgres for billing","context":"cheaper to run","status":"active","supersededBy":null,"supersededAt":null,"closedAt":null,"createdAt":"<ts>"}}"
    `);
  });

  it('incident', async () => {
    const create = routeOf('incident').create;
    const resolve = { resolutionText: 'Rolled the deploy back' };
    expect(await refusals('incident', ['', '/1/resolve'], [
      ...requiredText('create', '', create, 'text', 4096),
      ['create, two-character text', '', { text: 'ab' }],
      ...optionalText('create', '', create, 'context', 4096),
      ['create, linkedMemoryIds a string', '', { ...create, linkedMemoryIds: 'mem_x' }],
      ['create, linkedMemoryIds an object', '', { ...create, linkedMemoryIds: { id: 'mem_x' } }],
      ['create, 257 linkedMemoryIds', '', { ...create, linkedMemoryIds: many(257, 'mem_x') }],
      ['create, 256 linkedMemoryIds that do not exist', '', { ...create, linkedMemoryIds: many(256, 'mem_x') }],
      ['create, a linked id that is a number', '', { ...create, linkedMemoryIds: [5] }],
      ['create, a linked id that is empty', '', { ...create, linkedMemoryIds: [''] }],
      ['create, a linked id over 4096 characters', '', { ...create, linkedMemoryIds: [x(4097)] }],
      ['create, no linked ids', '', { ...create, linkedMemoryIds: [] }, 'status'],
      ['create, linkedMemoryIds null', '', { ...create, linkedMemoryIds: null }, 'status'],
      ...requiredText('resolve', '/1/resolve', resolve, 'resolutionText', 4096),
      ['resolve, empty body on a missing id', '/9999/resolve', {}],
    ])).toMatchInlineSnapshot(`
      "seed row 1: 201
      POST (create) with body "not json": 400 {"error":"invalid JSON body"}
      POST (create) with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "null": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "": 400 {"error":"text is required (non-empty string)"}
      POST /1/resolve with body "not json": 400 {"error":"invalid JSON body"}
      POST /1/resolve with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST /1/resolve with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST /1/resolve with body "null": 400 {"error":"request body must be a JSON object"}
      POST /1/resolve with body "": 400 {"error":"resolutionText is required (non-empty string)"}
      create, no text: 400 {"error":"text is required (non-empty string)"}
      create, text a number: 400 {"error":"text is required (non-empty string)"}
      create, text null: 400 {"error":"text is required (non-empty string)"}
      create, text empty: 400 {"error":"text is required (non-empty string)"}
      create, text blank: 201 {"incident":{"id":2,"memoryId":"<mem>","tenantId":"default","incidentText":"   ","context":"after the deploy","status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}}
      create, text over the 4096 cap: 400 {"error":"text exceeds 4096-character cap"}
      create, text at the 4096 cap: 201
      create, two-character text: 400 {"error":"Memory content too short (2 chars, minimum 3): \\"ab\\""}
      create, context a number: 400 {"error":"context must be a string"}
      create, context over the 4096 cap: 400 {"error":"context exceeds 4096-character cap"}
      create, context at the 4096 cap: 201
      create, context null: 201
      create, linkedMemoryIds a string: 400 {"error":"linkedMemoryIds must be an array of memory ids"}
      create, linkedMemoryIds an object: 400 {"error":"linkedMemoryIds must be an array of memory ids"}
      create, 257 linkedMemoryIds: 400 {"error":"linkedMemoryIds exceeds 256-item cap"}
      create, 256 linkedMemoryIds that do not exist: 409 {"error":"saveIncident: linked memory mem_x not found for tenant default"}
      create, a linked id that is a number: 400 {"error":"each linkedMemoryIds entry must be a non-empty string <= 4096 chars"}
      create, a linked id that is empty: 400 {"error":"each linkedMemoryIds entry must be a non-empty string <= 4096 chars"}
      create, a linked id over 4096 characters: 400 {"error":"each linkedMemoryIds entry must be a non-empty string <= 4096 chars"}
      create, no linked ids: 201
      create, linkedMemoryIds null: 201
      resolve, no resolutionText: 400 {"error":"resolutionText is required (non-empty string)"}
      resolve, resolutionText a number: 400 {"error":"resolutionText is required (non-empty string)"}
      resolve, resolutionText null: 400 {"error":"resolutionText is required (non-empty string)"}
      resolve, resolutionText empty: 400 {"error":"resolutionText is required (non-empty string)"}
      resolve, resolutionText blank: 400 {"error":"resolutionText is required (non-empty string)"}
      resolve, resolutionText over the 4096 cap: 400 {"error":"resolutionText exceeds 4096-character cap"}
      resolve, resolutionText at the 4096 cap: 200
      resolve, empty body on a missing id: 400 {"error":"resolutionText is required (non-empty string)"}
      row 1 afterwards: 200 {"incident":{"id":1,"memoryId":"<mem>","tenantId":"default","incidentText":"Checkout returned 500s","context":"after the deploy","status":"open","resolutionText":null,"resolvedAt":null,"closedAt":null,"linkedMemoryIds":[],"createdAt":"<ts>"}}"
    `);
  });

  it('process', async () => {
    const create = routeOf('process').create;
    const revise = { steps: ['run the tests'] };
    expect(await refusals('process', ['', '/1/supersede'], [
      ...requiredText('create', '', create, 'processName', 4096),
      ['create, no steps', '', { processName: 'Deploy' }],
      ['create, steps null', '', { ...create, steps: null }, 'status'],
      ['create, empty steps', '', { ...create, steps: [] }, 'status'],
      ['create, steps a string', '', { ...create, steps: 'run the tests' }],
      ['create, steps an object', '', { ...create, steps: { first: 'run the tests' } }],
      ['create, 201 steps', '', { ...create, steps: many(201, 'a step') }],
      ['create, 200 steps', '', { ...create, steps: many(200, 'a step') }, 'status'],
      ['create, a step that is a number', '', { ...create, steps: ['run the tests', 5] }],
      ['create, a blank step', '', { ...create, steps: ['run the tests', '  '] }],
      ['create, a step over 2000 characters', '', { ...create, steps: [x(2001)] }],
      ['create, a step of 2000 characters', '', { ...create, steps: [x(2000)] }, 'status'],
      ['create, a blank step and a bad description', '', { ...create, steps: ['  '], description: 5 }],
      ...optionalText('create', '', create, 'description', 4096),
      ['supersede, no steps', '/1/supersede', {}],
      ['supersede, steps null', '/1/supersede', { steps: null }],
      ['supersede, empty steps', '/1/supersede', { steps: [] }],
      ['supersede, steps a string', '/1/supersede', { steps: 'run the tests' }],
      ['supersede, 201 steps', '/1/supersede', { steps: many(201, 'a step') }],
      ['supersede, a step that is a number', '/1/supersede', { steps: [5] }],
      ['supersede, a blank step', '/1/supersede', { steps: ['  '] }],
      ['supersede, a step over 2000 characters', '/1/supersede', { steps: [x(2001)] }],
      ...optionalText('supersede', '/1/supersede', revise, 'changeSummary', 4096),
      ...optionalText('supersede', '/1/supersede', revise, 'description', 4096),
      ['supersede, empty body on a missing id', '/9999/supersede', {}],
    ])).toMatchInlineSnapshot(`
      "seed row 1: 201
      POST (create) with body "not json": 400 {"error":"invalid JSON body"}
      POST (create) with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "null": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "": 400 {"error":"processName is required (non-empty string)"}
      POST /1/supersede with body "not json": 400 {"error":"invalid JSON body"}
      POST /1/supersede with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "null": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "": 400 {"error":"steps is required (at least one step) for a supersession"}
      create, no processName: 400 {"error":"processName is required (non-empty string)"}
      create, processName a number: 400 {"error":"processName is required (non-empty string)"}
      create, processName null: 400 {"error":"processName is required (non-empty string)"}
      create, processName empty: 400 {"error":"processName is required (non-empty string)"}
      create, processName blank: 400 {"error":"processName is required (non-empty string)"}
      create, processName over the 4096 cap: 400 {"error":"processName exceeds 4096-character cap"}
      create, processName at the 4096 cap: 201
      create, no steps: 201 {"process":{"id":3,"memoryId":"<mem>","tenantId":"default","processName":"Deploy","description":null,"steps":[],"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      create, steps null: 201
      create, empty steps: 201
      create, steps a string: 400 {"error":"steps must be an array of strings"}
      create, steps an object: 400 {"error":"steps must be an array of strings"}
      create, 201 steps: 400 {"error":"steps exceeds 200-step cap"}
      create, 200 steps: 201
      create, a step that is a number: 400 {"error":"each step must be a string"}
      create, a blank step: 400 {"error":"a step is empty"}
      create, a step over 2000 characters: 400 {"error":"a step exceeds the 2000-character cap"}
      create, a step of 2000 characters: 201
      create, a blank step and a bad description: 400 {"error":"a step is empty"}
      create, description a number: 400 {"error":"description must be a string"}
      create, description over the 4096 cap: 400 {"error":"description exceeds 4096-character cap"}
      create, description at the 4096 cap: 201
      create, description null: 201
      supersede, no steps: 400 {"error":"steps is required (at least one step) for a supersession"}
      supersede, steps null: 400 {"error":"steps is required (at least one step) for a supersession"}
      supersede, empty steps: 400 {"error":"steps is required (at least one step) for a supersession"}
      supersede, steps a string: 400 {"error":"steps must be an array of strings"}
      supersede, 201 steps: 400 {"error":"steps exceeds 200-step cap"}
      supersede, a step that is a number: 400 {"error":"each step must be a string"}
      supersede, a blank step: 400 {"error":"a step is empty"}
      supersede, a step over 2000 characters: 400 {"error":"a step exceeds the 2000-character cap"}
      supersede, changeSummary a number: 400 {"error":"changeSummary must be a string"}
      supersede, changeSummary over the 4096 cap: 400 {"error":"changeSummary exceeds 4096-character cap"}
      supersede, changeSummary at the 4096 cap: 200
      supersede, changeSummary null: 200
      supersede, description a number: 400 {"error":"description must be a string"}
      supersede, description over the 4096 cap: 400 {"error":"description exceeds 4096-character cap"}
      supersede, description at the 4096 cap: 200
      supersede, description null: 200
      supersede, empty body on a missing id: 400 {"error":"steps is required (at least one step) for a supersession"}
      row 1 afterwards: 200 {"process":{"id":1,"memoryId":"<mem>","tenantId":"default","processName":"Release","description":"weekly cut","steps":["run the tests","tag the build"],"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}"
    `);
  });

  it('skill', async () => {
    const create = routeOf('skill').create;
    const revise = { instructions: 'Check both paths' };
    expect(await refusals('skill', ['', '/1/supersede'], [
      ...requiredText('create', '', create, 'skillName', 256),
      ...requiredText('create', '', create, 'instructions', 8192),
      ...optionalText('create', '', create, 'trigger', 1024),
      ['create, blank trigger', '', { ...create, trigger: '   ' }],
      ...requiredText('supersede', '/1/supersede', revise, 'instructions', 8192),
      ...optionalText('supersede', '/1/supersede', revise, 'trigger', 1024),
      ...optionalText('supersede', '/1/supersede', revise, 'changeSummary', 4096),
      ['supersede, empty body on a missing id', '/9999/supersede', {}],
    ])).toMatchInlineSnapshot(`
      "seed row 1: 201
      POST (create) with body "not json": 400 {"error":"invalid JSON body"}
      POST (create) with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "null": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "": 400 {"error":"skillName is required (non-empty string)"}
      POST /1/supersede with body "not json": 400 {"error":"invalid JSON body"}
      POST /1/supersede with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "null": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "": 400 {"error":"instructions are required (non-empty string)"}
      create, no skillName: 400 {"error":"skillName is required (non-empty string)"}
      create, skillName a number: 400 {"error":"skillName is required (non-empty string)"}
      create, skillName null: 400 {"error":"skillName is required (non-empty string)"}
      create, skillName empty: 400 {"error":"skillName is required (non-empty string)"}
      create, skillName blank: 400 {"error":"skillName is required (non-empty string)"}
      create, skillName over the 256 cap: 400 {"error":"skillName exceeds 256-character cap"}
      create, skillName at the 256 cap: 201
      create, no instructions: 400 {"error":"instructions are required (non-empty string)"}
      create, instructions a number: 400 {"error":"instructions are required (non-empty string)"}
      create, instructions null: 400 {"error":"instructions are required (non-empty string)"}
      create, instructions empty: 400 {"error":"instructions are required (non-empty string)"}
      create, instructions blank: 400 {"error":"instructions are required (non-empty string)"}
      create, instructions over the 8192 cap: 400 {"error":"instructions exceed 8192-character cap"}
      create, instructions at the 8192 cap: 201
      create, trigger a number: 400 {"error":"trigger must be a string"}
      create, trigger over the 1024 cap: 400 {"error":"trigger exceeds 1024-character cap"}
      create, trigger at the 1024 cap: 201
      create, trigger null: 201
      create, blank trigger: 201 {"skill":{"id":6,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path","trigger":null,"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      supersede, no instructions: 400 {"error":"instructions are required (non-empty string)"}
      supersede, instructions a number: 400 {"error":"instructions are required (non-empty string)"}
      supersede, instructions null: 400 {"error":"instructions are required (non-empty string)"}
      supersede, instructions empty: 400 {"error":"instructions are required (non-empty string)"}
      supersede, instructions blank: 400 {"error":"instructions are required (non-empty string)"}
      supersede, instructions over the 8192 cap: 400 {"error":"instructions exceed 8192-character cap"}
      supersede, instructions at the 8192 cap: 200
      supersede, trigger a number: 400 {"error":"trigger must be a string"}
      supersede, trigger over the 1024 cap: 400 {"error":"trigger exceeds 1024-character cap"}
      supersede, trigger at the 1024 cap: 200
      supersede, trigger null: 200
      supersede, changeSummary a number: 400 {"error":"changeSummary must be a string"}
      supersede, changeSummary over the 4096 cap: 400 {"error":"changeSummary exceeds 4096-character cap"}
      supersede, changeSummary at the 4096 cap: 200
      supersede, changeSummary null: 200
      supersede, empty body on a missing id: 400 {"error":"instructions are required (non-empty string)"}
      row 1 afterwards: 200 {"skill":{"id":1,"memoryId":"<mem>","tenantId":"default","skillName":"Review a migration","instructions":"Check the down path","trigger":"a schema change","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}"
    `);
  });

  it('customer note', async () => {
    const create = routeOf('customer note').create;
    const revise = { note: 'Prefers a call' };
    expect(await refusals('customer note', ['', '/1/supersede'], [
      ...requiredText('create', '', create, 'customer', 256),
      ['create, customer padded past the cap', '', { ...create, customer: ` ${x(256)} ` }],
      ...requiredText('create', '', create, 'note', 8192),
      ...requiredText('supersede', '/1/supersede', revise, 'note', 8192),
      ...optionalText('supersede', '/1/supersede', revise, 'changeSummary', 4096),
      ['supersede, empty body on a missing id', '/9999/supersede', {}],
    ])).toMatchInlineSnapshot(`
      "seed row 1: 201
      POST (create) with body "not json": 400 {"error":"invalid JSON body"}
      POST (create) with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "null": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "": 400 {"error":"customer is required (non-empty string)"}
      POST /1/supersede with body "not json": 400 {"error":"invalid JSON body"}
      POST /1/supersede with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "null": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "": 400 {"error":"note is required (non-empty string)"}
      create, no customer: 400 {"error":"customer is required (non-empty string)"}
      create, customer a number: 400 {"error":"customer is required (non-empty string)"}
      create, customer null: 400 {"error":"customer is required (non-empty string)"}
      create, customer empty: 400 {"error":"customer is required (non-empty string)"}
      create, customer blank: 400 {"error":"customer is required (non-empty string)"}
      create, customer over the 256 cap: 400 {"error":"customer exceeds 256-character cap"}
      create, customer at the 256 cap: 201
      create, customer padded past the cap: 400 {"error":"customer exceeds 256-character cap"}
      create, no note: 400 {"error":"note is required (non-empty string)"}
      create, note a number: 400 {"error":"note is required (non-empty string)"}
      create, note null: 400 {"error":"note is required (non-empty string)"}
      create, note empty: 400 {"error":"note is required (non-empty string)"}
      create, note blank: 400 {"error":"note is required (non-empty string)"}
      create, note over the 8192 cap: 400 {"error":"note exceeds 8192-character cap"}
      create, note at the 8192 cap: 201
      supersede, no note: 400 {"error":"note is required (non-empty string)"}
      supersede, note a number: 400 {"error":"note is required (non-empty string)"}
      supersede, note null: 400 {"error":"note is required (non-empty string)"}
      supersede, note empty: 400 {"error":"note is required (non-empty string)"}
      supersede, note blank: 400 {"error":"note is required (non-empty string)"}
      supersede, note over the 8192 cap: 400 {"error":"note exceeds 8192-character cap"}
      supersede, note at the 8192 cap: 200
      supersede, changeSummary a number: 400 {"error":"changeSummary must be a string"}
      supersede, changeSummary over the 4096 cap: 400 {"error":"changeSummary exceeds 4096-character cap"}
      supersede, changeSummary at the 4096 cap: 200
      supersede, changeSummary null: 200
      supersede, empty body on a missing id: 400 {"error":"note is required (non-empty string)"}
      row 1 afterwards: 200 {"note":{"id":1,"memoryId":"<mem>","tenantId":"default","customer":"Acme Ltd","note":"Prefers email","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}"
    `);
  });

  it('policy', async () => {
    const create = routeOf('policy').create;
    const revise = { policyText: 'Delete logs after 30 days', validFrom: '2026-06-01' };
    expect(await refusals('policy', ['', '/1/supersede'], [
      ...requiredText('create', '', create, 'policyName', 4096),
      ...requiredText('create', '', create, 'policyText', 4096),
      ['create, validFrom a number', '', { ...create, validFrom: 5 }],
      ['create, validFrom over the 64 cap', '', { ...create, validFrom: x(65) }],
      ['create, validFrom at the 64 cap', '', { ...create, validFrom: x(64) }],
      ['create, validFrom that does not parse', '', { ...create, validFrom: 'soon' }],
      ['create, validFrom empty', '', { ...create, validFrom: '' }],
      ['create, validTo a number', '', { ...create, validTo: 5 }],
      ['create, validTo over the 64 cap', '', { ...create, validTo: x(65) }],
      ['create, validTo that does not parse', '', { ...create, validTo: 'soon' }],
      ['create, validTo before validFrom', '', { ...create, validTo: '2025-12-31' }],
      ['create, validTo equal to validFrom', '', { ...create, validTo: '2026-01-01' }],
      ['create, validTo null', '', { ...create, validTo: null }, 'status'],
      ['create, bad validFrom and bad validTo', '', { ...create, validFrom: 5, validTo: 5 }],
      ...requiredText('supersede', '/1/supersede', revise, 'policyText', 4096),
      ['supersede, validFrom a number', '/1/supersede', { ...revise, validFrom: 5 }],
      ['supersede, validFrom over the 64 cap', '/1/supersede', { ...revise, validFrom: x(65) }],
      ['supersede, validFrom that does not parse', '/1/supersede', { ...revise, validFrom: 'soon' }],
      ['supersede, validFrom before the predecessor', '/{new}/supersede', { ...revise, validFrom: '2025-06-01' }],
      ['supersede, validTo a number', '/1/supersede', { ...revise, validTo: 5 }],
      ['supersede, validTo over the 64 cap', '/1/supersede', { ...revise, validTo: x(65) }],
      ['supersede, validTo before validFrom', '/1/supersede', { ...revise, validTo: '2026-05-01' }],
      ...optionalText('supersede', '/1/supersede', revise, 'changeSummary', 4096),
      ['supersede, empty body on a missing id', '/9999/supersede', {}],
    ])).toMatchInlineSnapshot(`
      "seed row 1: 201
      POST (create) with body "not json": 400 {"error":"invalid JSON body"}
      POST (create) with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "null": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "": 400 {"error":"policyName is required (non-empty string)"}
      POST /1/supersede with body "not json": 400 {"error":"invalid JSON body"}
      POST /1/supersede with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "null": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "": 400 {"error":"policyText is required (non-empty string)"}
      create, no policyName: 400 {"error":"policyName is required (non-empty string)"}
      create, policyName a number: 400 {"error":"policyName is required (non-empty string)"}
      create, policyName null: 400 {"error":"policyName is required (non-empty string)"}
      create, policyName empty: 400 {"error":"policyName is required (non-empty string)"}
      create, policyName blank: 400 {"error":"policyName is required (non-empty string)"}
      create, policyName over the 4096 cap: 400 {"error":"policyName exceeds 4096-character cap"}
      create, policyName at the 4096 cap: 201
      create, no policyText: 400 {"error":"policyText is required (non-empty string)"}
      create, policyText a number: 400 {"error":"policyText is required (non-empty string)"}
      create, policyText null: 400 {"error":"policyText is required (non-empty string)"}
      create, policyText empty: 400 {"error":"policyText is required (non-empty string)"}
      create, policyText blank: 400 {"error":"policyText is required (non-empty string)"}
      create, policyText over the 4096 cap: 400 {"error":"policyText exceeds 4096-character cap"}
      create, policyText at the 4096 cap: 201
      create, validFrom a number: 400 {"error":"validFrom must be a string"}
      create, validFrom over the 64 cap: 400 {"error":"validFrom exceeds 64-character cap"}
      create, validFrom at the 64 cap: 400 {"error":"policy: invalid valid_from \\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\" (expected an ISO-8601 date or datetime)"}
      create, validFrom that does not parse: 400 {"error":"policy: invalid valid_from \\"soon\\" (expected an ISO-8601 date or datetime)"}
      create, validFrom empty: 400 {"error":"policy: invalid valid_from \\"\\" (expected an ISO-8601 date or datetime)"}
      create, validTo a number: 400 {"error":"validTo must be a string"}
      create, validTo over the 64 cap: 400 {"error":"validTo exceeds 64-character cap"}
      create, validTo that does not parse: 400 {"error":"policy: invalid valid_to \\"soon\\" (expected an ISO-8601 date or datetime)"}
      create, validTo before validFrom: 400 {"error":"policy: valid_to (2025-12-31T00:00:00.000Z) must be strictly after valid_from (2026-01-01T00:00:00.000Z)"}
      create, validTo equal to validFrom: 400 {"error":"policy: valid_to (2026-01-01T00:00:00.000Z) must be strictly after valid_from (2026-01-01T00:00:00.000Z)"}
      create, validTo null: 201
      create, bad validFrom and bad validTo: 400 {"error":"validFrom must be a string"}
      supersede, no policyText: 400 {"error":"policyText is required (non-empty string)"}
      supersede, policyText a number: 400 {"error":"policyText is required (non-empty string)"}
      supersede, policyText null: 400 {"error":"policyText is required (non-empty string)"}
      supersede, policyText empty: 400 {"error":"policyText is required (non-empty string)"}
      supersede, policyText blank: 400 {"error":"policyText is required (non-empty string)"}
      supersede, policyText over the 4096 cap: 400 {"error":"policyText exceeds 4096-character cap"}
      supersede, policyText at the 4096 cap: 200
      supersede, validFrom a number: 400 {"error":"validFrom must be a string"}
      supersede, validFrom over the 64 cap: 400 {"error":"validFrom exceeds 64-character cap"}
      supersede, validFrom that does not parse: 400 {"error":"policy: invalid valid_from \\"soon\\" (expected an ISO-8601 date or datetime)"}
      supersede, validFrom before the predecessor: 200 {"policy":{"id":8,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 30 days","validFrom":"2025-06-01T00:00:00.000Z","validTo":null,"version":2,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}
      supersede, validTo a number: 400 {"error":"validTo must be a string"}
      supersede, validTo over the 64 cap: 400 {"error":"validTo exceeds 64-character cap"}
      supersede, validTo before validFrom: 400 {"error":"policy: valid_to (2026-05-01T00:00:00.000Z) must be strictly after valid_from (2026-06-01T00:00:00.000Z)"}
      supersede, changeSummary a number: 400 {"error":"changeSummary must be a string"}
      supersede, changeSummary over the 4096 cap: 400 {"error":"changeSummary exceeds 4096-character cap"}
      supersede, changeSummary at the 4096 cap: 200
      supersede, changeSummary null: 200
      supersede, empty body on a missing id: 400 {"error":"policyText is required (non-empty string)"}
      row 1 afterwards: 200 {"policy":{"id":1,"memoryId":"<mem>","tenantId":"default","policyName":"Retention","policyText":"Delete logs after 90 days","validFrom":"2026-01-01T00:00:00.000Z","validTo":null,"version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}"
    `);
  });

  it('project brief', async () => {
    const create = routeOf('project brief').create;
    const revise = { summary: 'Storefront and admin app' };
    expect(await refusals('project brief', ['', '/refresh', '/1/supersede'], [
      ...requiredText('create', '', create, 'repo', 256),
      ['create, repo padded past the cap', '', { ...create, repo: ` ${x(256)} ` }],
      ...requiredText('create', '', create, 'summary', 8192),
      ...requiredText('refresh', '/refresh', { repo: 'acme/web' }, 'repo', 256),
      ['refresh, dry run with a blank repo', '/refresh', { repo: '  ', dryRun: true }],
      ...requiredText('supersede', '/1/supersede', revise, 'summary', 8192),
      ...optionalText('supersede', '/1/supersede', revise, 'changeSummary', 4096),
      ['supersede, empty body on a missing id', '/9999/supersede', {}],
    ])).toMatchInlineSnapshot(`
      "seed row 1: 201
      POST (create) with body "not json": 400 {"error":"invalid JSON body"}
      POST (create) with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "null": 400 {"error":"request body must be a JSON object"}
      POST (create) with body "": 400 {"error":"repo is required (non-empty string)"}
      POST /refresh with body "not json": 400 {"error":"invalid JSON body"}
      POST /refresh with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST /refresh with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST /refresh with body "null": 400 {"error":"request body must be a JSON object"}
      POST /refresh with body "": 400 {"error":"repo is required (non-empty string)"}
      POST /1/supersede with body "not json": 400 {"error":"invalid JSON body"}
      POST /1/supersede with body "[1]": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "\\"text\\"": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "null": 400 {"error":"request body must be a JSON object"}
      POST /1/supersede with body "": 400 {"error":"summary is required (non-empty string)"}
      create, no repo: 400 {"error":"repo is required (non-empty string)"}
      create, repo a number: 400 {"error":"repo is required (non-empty string)"}
      create, repo null: 400 {"error":"repo is required (non-empty string)"}
      create, repo empty: 400 {"error":"repo is required (non-empty string)"}
      create, repo blank: 400 {"error":"repo is required (non-empty string)"}
      create, repo over the 256 cap: 400 {"error":"repo exceeds 256-character cap"}
      create, repo at the 256 cap: 201
      create, repo padded past the cap: 400 {"error":"repo exceeds 256-character cap"}
      create, no summary: 400 {"error":"summary is required (non-empty string)"}
      create, summary a number: 400 {"error":"summary is required (non-empty string)"}
      create, summary null: 400 {"error":"summary is required (non-empty string)"}
      create, summary empty: 400 {"error":"summary is required (non-empty string)"}
      create, summary blank: 400 {"error":"summary is required (non-empty string)"}
      create, summary over the 8192 cap: 400 {"error":"summary exceeds 8192-character cap"}
      create, summary at the 8192 cap: 201
      refresh, no repo: 400 {"error":"repo is required (non-empty string)"}
      refresh, repo a number: 400 {"error":"repo is required (non-empty string)"}
      refresh, repo null: 400 {"error":"repo is required (non-empty string)"}
      refresh, repo empty: 400 {"error":"repo is required (non-empty string)"}
      refresh, repo blank: 400 {"error":"repo is required (non-empty string)"}
      refresh, repo over the 256 cap: 400 {"error":"repo exceeds 256-character cap"}
      refresh, repo at the 256 cap: 200
      refresh, dry run with a blank repo: 400 {"error":"repo is required (non-empty string)"}
      supersede, no summary: 400 {"error":"summary is required (non-empty string)"}
      supersede, summary a number: 400 {"error":"summary is required (non-empty string)"}
      supersede, summary null: 400 {"error":"summary is required (non-empty string)"}
      supersede, summary empty: 400 {"error":"summary is required (non-empty string)"}
      supersede, summary blank: 400 {"error":"summary is required (non-empty string)"}
      supersede, summary over the 8192 cap: 400 {"error":"summary exceeds 8192-character cap"}
      supersede, summary at the 8192 cap: 200
      supersede, changeSummary a number: 400 {"error":"changeSummary must be a string"}
      supersede, changeSummary over the 4096 cap: 400 {"error":"changeSummary exceeds 4096-character cap"}
      supersede, changeSummary at the 4096 cap: 200
      supersede, changeSummary null: 200
      supersede, empty body on a missing id: 400 {"error":"summary is required (non-empty string)"}
      row 1 afterwards: 200 {"brief":{"id":1,"memoryId":"<mem>","tenantId":"default","repo":"acme/web","summary":"Storefront app","version":1,"status":"active","supersededBy":null,"supersededAt":null,"changeSummary":null,"closedAt":null,"createdAt":"<ts>"}}"
    `);
  });
});
