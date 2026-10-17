// E3.1 cross-object references precision measurement (DESCRIPTIVE, not a gate).
// Seeds genuine cross-references + decoys (incl. a generic-word entity name trap),
// runs extractGraph, classifies each emitted `references` edge true/false by construction.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../../dist/store/open.js';
import { loadConfig } from '../../dist/core/config.js';
import { saveDecision } from '../../dist/objects/decisions.js';
import { savePolicy } from '../../dist/objects/policies.js';
import { saveCustomerNote } from '../../dist/objects/customer-notes.js';
import { saveProjectBrief } from '../../dist/objects/project-briefs.js';
import { loadEntities, loadRelations } from '../../dist/store/graph-reads.js';
import { extractGraph } from '../../dist/graph/extract.js';
import { sqliteStore } from '../../dist/store/sqlite/store.js';

const home = mkdtempSync(join(tmpdir(), 'hippo-e3-xobj-'));
mkdirSync(join(home, '.hippo'), { recursive: true });
initStore(home);
const T = 'default';
const objects = sqliteStore(home).objects;
const intended = new Set(); // `${srcName}=>${tgtName}` genuine references

async function decRef(text, srcName, tgtName) { await saveDecision(objects, loadConfig(home).defaultHalfLifeDays, T, { decisionText: text }); if (tgtName) intended.add(`${srcName}=>${tgtName}`); }

// Targets (policies/customers/projects with identifiable names)
await savePolicy(objects, loadConfig(home).defaultHalfLifeDays, T, { policyName: 'RetryBudget', policyText: 'cap retries' });
await savePolicy(objects, loadConfig(home).defaultHalfLifeDays, T, { policyName: 'CacheTTL', policyText: 'ttl 30s' });
await savePolicy(objects, loadConfig(home).defaultHalfLifeDays, T, { policyName: 'DataRetention', policyText: 'delete after 90d' });
await saveCustomerNote(objects, loadConfig(home).defaultHalfLifeDays, T, { customer: 'Northwind', note: 'enterprise tier' });
await saveProjectBrief(objects, loadConfig(home).defaultHalfLifeDays, T, { repo: 'billing-svc', summary: 'invoicing service' });
// A GENERIC-WORD entity name trap (plan-eng LOW): a customer literally named "Core".
await saveCustomerNote(objects, loadConfig(home).defaultHalfLifeDays, T, { customer: 'Core', note: 'a customer literally named Core' });

// GENUINE references (8): decisions/briefs that name a target.
await decRef('We adopt RetryBudget to cap retry storms', 'We adopt RetryBudget to cap retry storms', 'RetryBudget');
await decRef('Lower CacheTTL to reduce staleness', 'Lower CacheTTL to reduce staleness', 'CacheTTL');
await decRef('DataRetention now applies to audit logs too', 'DataRetention now applies to audit logs too', 'DataRetention');
await decRef('Onboard Northwind onto the new plan', 'Onboard Northwind onto the new plan', 'Northwind');
await decRef('Migrate billing-svc to the shared queue', 'Migrate billing-svc to the shared queue', 'billing-svc');
await decRef('RetryBudget and CacheTTL must both be tuned together', 'RetryBudget and CacheTTL must both be tuned together', 'RetryBudget');
intended.add('RetryBudget and CacheTTL must both be tuned together=>CacheTTL'); // 2-target decision
await saveProjectBrief(objects, loadConfig(home).defaultHalfLifeDays, T, { repo: 'audit-svc', summary: 'enforces DataRetention on every write' });
intended.add('audit-svc=>DataRetention');

// DECOYS (should NOT match): word-boundary near-miss + generic prose.
await decRef('the team is retrying flaky steps', 'd-retry', null);   // "retry" not a name; "retrying" != RetryBudget
await decRef('we refactored the core scheduler module', 'd-core', null); // "core" the generic word -> FALSE if it matches the "Core" customer

const r = await extractGraph(sqliteStore(home), T);
const ents = loadEntities(home, T, { limit: 1000 });
const nameById = new Map(ents.map((e) => [e.id, e.name]));
const edges = loadRelations(home, T, { limit: 1000 }).filter((x) => x.relType === 'references');
let truthy = 0, falsy = 0; const falseEdges = [];
for (const e of edges) {
  const key = `${nameById.get(e.fromEntityId)}=>${nameById.get(e.toEntityId)}`;
  if (intended.has(key)) truthy++; else { falsy++; falseEdges.push(key); }
}
const precision = edges.length ? (truthy / edges.length) : 1;
const recall = intended.size ? (truthy / intended.size) : 1;
console.log(JSON.stringify({
  entities: r.entities, supersedes: r.relations - r.references, references: r.references,
  intended_true_refs: intended.size, edges_emitted: edges.length,
  true_positives: truthy, false_positives: falsy,
  precision: Number(precision.toFixed(3)), recall: Number(recall.toFixed(3)),
  false_edges: falseEdges,
}, null, 2));
rmSync(home, { recursive: true, force: true });
