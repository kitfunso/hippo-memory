#!/usr/bin/env node
// Fails when an agent hippo names in its docs is missing from docs/integrations/agent-inventory.json, or an entry overclaims.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
const root = rootFlag === -1 ? fileURLToPath(new URL('..', import.meta.url)) : path.resolve(process.argv[rootFlag + 1]);
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const isStr = (v) => String(v) === v;
const isStrOrNull = (v) => v === null || isStr(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const INTEGRATIONS = new Set(['native-hooks', 'native-plugin', 'wrapper', 'instruction-file', 'mcp-recipe', 'none']);
const STATUSES = new Set(['verified', 'shipped', 'planned', 'blocked', 'unknown']);
const ROUTES = ['promptContext', 'toolFailureCapture', 'preLossSave', 'postCompactExtract', 'sessionEndCapture', 'compactResume'];
const NULLABLE = ['interface', 'setup', 'store', 'maxSaveDelay'];
const MIN_FRAMEWORK_ROWS = 6;
const issues = [];

const inventory = JSON.parse(read('docs/integrations/agent-inventory.json'));
if (inventory.schemaVersion !== 1) issues.push(`schemaVersion must be 1, got ${inventory.schemaVersion}`);

const ids = new Set();
const names = new Set();
const cited = new Set();
const exists = (at, p) => {
  if (!existsSync(path.join(root, p))) issues.push(`${at}: path does not exist: ${p}`);
};

function checkMode(at, m, routes) {
  if (!isStr(m?.name) || !m.name) issues.push(`${at}: every mode needs a name`);
  const where = `${at} mode "${m?.name}"`;
  for (const key of ['fixtureEvidence', 'liveEvidence']) {
    if (!Array.isArray(m?.[key])) issues.push(`${where}: ${key} must be an array`);
    else m[key].forEach((p) => exists(where, p));
  }
  for (const key of ['checkpointBeforeLoss', 'lessonsBeforeLoss']) {
    const status = m?.[key];
    if (!STATUSES.has(status)) issues.push(`${where}: ${key} must be one of ${[...STATUSES].join(', ')}`);
    if (status === 'verified' && !m.liveEvidence?.length) issues.push(`${where}: ${key} verified needs liveEvidence`);
    if (status === 'shipped' && !m.fixtureEvidence?.length) issues.push(`${where}: ${key} shipped needs fixtureEvidence`);
    if ((status === 'verified' || status === 'shipped') && !routes?.preLossSave) issues.push(`${where}: ${key} ${status} needs a preLossSave route`);
  }
}

for (const e of inventory.entries ?? []) {
  const at = `entry ${e.id ?? '(no id)'}`;
  if (!e.id || ids.has(e.id)) issues.push(`${at}: id missing or duplicated`);
  ids.add(e.id);
  if (!DATE.test(e.checked ?? '')) issues.push(`${at}: checked must be a YYYY-MM-DD date`);
  for (const key of ['names', 'integration', 'sources', 'claims', 'modes']) {
    if (!Array.isArray(e[key])) issues.push(`${at}: ${key} must be an array`);
  }
  if (!e.names?.length) issues.push(`${at}: names is empty`);
  if (!e.modes?.length) issues.push(`${at}: modes is empty`);
  if (!e.integration?.length || e.integration.some((i) => !INTEGRATIONS.has(i))) {
    issues.push(`${at}: integration must list values from ${[...INTEGRATIONS].join(', ')}`);
  }
  if (e.integration?.includes('none') && (e.integration.length > 1 || e.sources?.length)) {
    issues.push(`${at}: integration none stands alone and lists no sources`);
  }
  for (const key of ROUTES) if (!isStrOrNull(e.routes?.[key])) issues.push(`${at}: routes.${key} must be a string or null`);
  for (const key of ['preLossEvent', 'beforeTrimOrReset']) {
    if (!isStrOrNull(e.upstream?.[key])) issues.push(`${at}: upstream.${key} must be a string or null`);
  }
  for (const key of NULLABLE) if (!(key in e) || !isStrOrNull(e[key])) issues.push(`${at}: ${key} must be present, a string or null`);
  if (!e.owner || !e.nextAction || !e.roadmap) issues.push(`${at}: owner, nextAction and roadmap are required`);
  for (const p of [...(e.sources ?? []), ...(e.claims ?? [])]) exists(at, p);
  for (const p of e.sources ?? []) cited.add(p.replace(/\/$/, ''));
  for (const m of e.modes ?? []) checkMode(at, m, e.routes);
  for (const n of e.names ?? []) names.add(n.toLowerCase());
}

const claimed = [];
const readme = read('README.md').split(/\r?\n/);
const tableStart = readme.findIndex((l) => /^\|\s*Framework\s*\|/.test(l));
const rows = [];
for (let i = tableStart + 2; tableStart !== -1 && i < readme.length && readme[i].startsWith('|'); i++) rows.push(readme[i]);
if (rows.length < MIN_FRAMEWORK_ROWS) {
  issues.push(`README.md: framework table (| Framework | ...) has ${rows.length} rows, expected at least ${MIN_FRAMEWORK_ROWS}`);
}
for (const row of rows) claimed.push(['README.md framework table', row.split('|')[1].trim()]);

const mcp = read('extensions/mcp/README.md');
const clientList = mcp.match(/Works with any MCP-compatible client:\s*([^\n]+)/);
if (!clientList) issues.push('extensions/mcp/README.md: "Works with any MCP-compatible client:" list not found');
else {
  for (const n of clientList[1].replace(/\.$/, '').split(',')) {
    const name = n.trim();
    if (name && name !== 'etc') claimed.push(['extensions/mcp/README.md client list', name]);
  }
}
const setup = mcp.match(/^## Setup\s*$([\s\S]*?)^## /m);
if (!setup) issues.push('extensions/mcp/README.md: ## Setup section not found');
else {
  for (const h of setup[1].matchAll(/^### (.+)$/gm)) {
    for (const n of h[1].split('/')) claimed.push(['extensions/mcp/README.md setup heading', n.trim()]);
  }
}
const generic = new Set(inventory.nonAgentKeywords ?? []);
for (const k of JSON.parse(read('package.json')).keywords ?? []) {
  if (!generic.has(k)) claimed.push(['package.json keywords', k]);
}
for (const [where, name] of claimed) {
  if (!names.has(name.toLowerCase())) issues.push(`${where} names "${name}", which no inventory entry lists in names`);
}

for (const f of readdirSync(path.join(root, 'integrations')).filter((f) => f.endsWith('.md'))) {
  if (!cited.has(`integrations/${f}`)) issues.push(`integrations/${f} is not in any entry's sources`);
}
for (const d of readdirSync(path.join(root, 'extensions'), { withFileTypes: true }).filter((d) => d.isDirectory())) {
  if (!cited.has(`extensions/${d.name}`)) issues.push(`extensions/${d.name} is not in any entry's sources`);
}

if (issues.length) {
  console.error(`agent inventory: ${issues.length} problem(s)\n${issues.map((i) => `  - ${i}`).join('\n')}`);
  process.exit(1);
}
console.log(`agent inventory: ${inventory.entries.length} entries, ${claimed.length} named claims reconciled`);
