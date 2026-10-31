// The entity graph verbs: rebuild it from the consolidated objects, print it, or write it out as a diagram.

import * as fs from 'fs';
import { extractGraph } from '../graph/extract.js';
import { buildGraphModel, renderGraphHtml, renderGraphCanvas, DEFAULT_VIEW_LIMIT } from '../graph/view.js';
import { printError } from './output.js';
import { type CliFlags, stringFlag, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { fail } from './exit.js';
import { objectsOf } from '../api/objects/objects.js';
import { cliApiContext } from './api-context.js';
import { openInBrowser } from './open-browser.js';

async function graphExtract(hippoRoot: string, tenantId: string): Promise<void> {
  const ctx = cliApiContext(hippoRoot, tenantId);
  const result = await extractGraph(objectsOf(ctx), hippoRoot, tenantId);
  const byType = Object.entries(result.byType)
    .map(([t, n]) => `${t} ${n}`)
    .join(', ');
  const supersedes = result.relations - result.references;
  const relations = `${result.relations} relations (${supersedes} supersedes, ${result.references} references)`;
  console.log(`Graph extracted: ${result.entities} entities (${byType}) + ${relations}.`);
  if (result.truncated.length > 0) {
    printError(
      `WARNING: under-extracted (hit the per-type cap): ${result.truncated.join(', ')}. ` +
        'The graph is incomplete for those types.',
    );
  }
}

function graphShow(hippoRoot: string, tenantId: string, entity: string | undefined, flags: CliFlags): void {
  const model = buildGraphModel(hippoRoot, tenantId, { entity, limit: DEFAULT_VIEW_LIMIT });
  if (flags['json']) {
    console.log(JSON.stringify(model, null, 2));
    return;
  }
  if (model.nodes.length === 0) {
    console.log(entity ? `No entity named "${entity}".` : 'Graph is empty. Run `hippo graph extract` first.');
    return;
  }
  console.log(
    `Graph: ${model.nodes.length} entities, ${model.edges.length} relations${model.truncated ? ' (truncated)' : ''}`,
  );
  const byType = new Map<string, { id: number; name: string }[]>();
  for (const n of model.nodes) {
    const arr = byType.get(n.type) ?? [];
    arr.push({ id: n.id, name: n.name });
    byType.set(n.type, arr);
  }
  for (const [type, ns] of byType) {
    console.log(`\n${type} (${ns.length}):`);
    for (const n of ns) console.log(`  [${n.id}] ${n.name}`);
  }
  if (model.edges.length > 0) {
    const nameById = new Map(model.nodes.map((n) => [n.id, n.name]));
    console.log('\nrelations:');
    for (const e of model.edges) {
      console.log(`  ${nameById.get(e.from)} --${e.relType}--> ${nameById.get(e.to)}`);
    }
  }
}

function graphView(hippoRoot: string, tenantId: string, entity: string | undefined, flags: CliFlags): void {
  const format = stringFlag(flags, 'format') ?? 'html';
  if (format !== 'html' && format !== 'canvas') {
    fail("graph view: --format must be 'html' or 'canvas'");
  }
  const model = buildGraphModel(hippoRoot, tenantId, { entity, limit: DEFAULT_VIEW_LIMIT });
  const content = format === 'canvas' ? renderGraphCanvas(model) : renderGraphHtml(model);
  const defaultOut = format === 'canvas' ? 'hippo-graph.canvas' : 'hippo-graph.html';
  const out = stringFlag(flags, 'out') ?? defaultOut;
  fs.writeFileSync(out, content, 'utf8');
  const truncated = model.truncated ? ' (truncated)' : '';
  console.log(`Wrote ${model.nodes.length} entities + ${model.edges.length} relations to ${out}${truncated}`);
  if (flags['open'] && format === 'html') openInBrowser(out);
}

export async function handleGraph({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const subcommand = args[0] ?? '';
  if (subcommand === 'extract') return graphExtract(hippoRoot, tenantId);
  const entity = stringFlag(flags, 'entity');
  if (subcommand === 'show') return graphShow(hippoRoot, tenantId, entity, flags);
  if (subcommand === 'view') return graphView(hippoRoot, tenantId, entity, flags);

  fail(
    'Usage:\n' +
      '  hippo graph extract                     Rebuild the entity/relation graph from consolidated objects\n' +
      '  hippo graph show [--entity NAME] [--json]   Inspect entities + their edges (text or JSON)\n' +
      '  hippo graph view [--out FILE] [--open] [--format html|canvas] [--entity NAME]   ' +
      'Generate an interactive node-link diagram',
  );
}
