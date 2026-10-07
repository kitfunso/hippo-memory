import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import { detectInstalledTools } from '../src/hooks/shared.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(REPO, 'scripts', 'check-agent-inventory.mjs');
const FRAMEWORKS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];

interface Mode {
  readonly name: string;
  readonly checkpointBeforeLoss: string;
  readonly lessonsBeforeLoss: string;
  readonly fixtureEvidence: readonly string[];
  readonly liveEvidence: readonly string[];
}
interface Entry {
  readonly id: string;
  readonly checked: string;
  readonly names: readonly string[];
  readonly integration: readonly string[];
  readonly sources: readonly string[];
  readonly claims: readonly string[];
  readonly routes: Readonly<Record<string, string | null>>;
  readonly upstream: Readonly<Record<string, string | null>>;
  readonly setup: string | null;
  readonly store?: string | null;
  readonly maxSaveDelay: string | null;
  readonly interface: string | null;
  readonly modes: readonly Mode[];
  readonly owner: string;
  readonly nextAction: string;
  readonly roadmap: string;
}
interface RootParts {
  readonly entry: Entry;
  readonly frameworks: readonly string[];
  readonly mcpReadme: string;
  readonly keywords: readonly string[];
  readonly integrationDocs: readonly string[];
}

function baseEntry(): Entry {
  return {
    id: 'alpha',
    checked: '2026-10-03',
    names: [...FRAMEWORKS, 'Zulu Desktop', 'Any MCP Client'],
    integration: ['native-hooks', 'mcp-recipe'],
    sources: ['extensions/mcp', 'integrations/alpha.md'],
    claims: ['README.md'],
    routes: { promptContext: 'hook', toolFailureCapture: null, preLossSave: 'hook', postCompactExtract: null, sessionEndCapture: null, compactResume: null },
    upstream: { preLossEvent: 'PreCompact', beforeTrimOrReset: null },
    setup: null,
    store: null,
    maxSaveDelay: null,
    interface: null,
    modes: [{ name: 'local', checkpointBeforeLoss: 'shipped', lessonsBeforeLoss: 'planned', fixtureEvidence: ['tests/alpha.test.ts'], liveEvidence: [] }],
    owner: 'maintainer',
    nextAction: 'record a live run',
    roadmap: 'AZ4',
  };
}

function baseParts(): RootParts {
  return {
    entry: baseEntry(),
    frameworks: FRAMEWORKS,
    mcpReadme: 'Works with any MCP-compatible client: Alpha, Zulu Desktop, etc.\n\n## Setup\n\n### Alpha\n\n### Zulu Desktop / Any MCP Client\n\n## Tools\n',
    keywords: ['memory', 'alpha'],
    integrationDocs: ['alpha.md'],
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeRoot(parts: RootParts): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-inventory-'));
  roots.push(root);
  const put = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put('docs/integrations/agent-inventory.json', JSON.stringify({ schemaVersion: 1, nonAgentKeywords: ['memory'], entries: [parts.entry] }));
  put('README.md', ['| Framework | Install |', '|---|---|', ...parts.frameworks.map((f) => `| ${f} | x |`), ''].join('\n'));
  put('extensions/mcp/README.md', parts.mcpReadme);
  put('package.json', JSON.stringify({ keywords: parts.keywords }));
  put('tests/alpha.test.ts', '');
  for (const doc of parts.integrationDocs) put(`integrations/${doc}`, '');
  return root;
}

interface CheckResult {
  readonly status: number | null;
  readonly output: string;
}

function check(root: string): CheckResult {
  const run = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

function failsWith(parts: Partial<RootParts>, message: string): void {
  const result = check(writeRoot({ ...baseParts(), ...parts }));
  expect(result.output).toContain(message);
  expect(result.status).toBe(1);
}

describe('check-agent-inventory', () => {
  it('passes on the real repository', () => {
    const result = check(REPO);
    expect(result.output).toContain('agent inventory:');
    expect(result.status).toBe(0);
  });

  it('passes on the minimal fixture root', () => {
    expect(check(writeRoot(baseParts())).status).toBe(0);
  });

  it('fails when the README names a framework the inventory lacks', () => {
    failsWith({ frameworks: [...FRAMEWORKS, 'Kilo'] }, 'README.md framework table names "Kilo"');
  });

  it('fails when the framework table shrinks below six rows, so a moved table cannot pass silently', () => {
    failsWith({ frameworks: FRAMEWORKS.slice(0, 2) }, 'has 2 rows, expected at least 6');
  });

  it('fails when the MCP client sentence is gone', () => {
    failsWith({ mcpReadme: '## Setup\n\n### Alpha\n\n## Tools\n' }, '"Works with any MCP-compatible client:" list not found');
  });

  it('fails on an unlisted MCP setup heading or package keyword', () => {
    failsWith({ mcpReadme: baseParts().mcpReadme.replace('### Alpha', '### Yankee') }, 'setup heading names "Yankee"');
    failsWith({ keywords: ['memory', 'yankee'] }, 'package.json keywords names "yankee"');
  });

  it('fails when a cited path does not exist', () => {
    failsWith({ entry: { ...baseEntry(), sources: ['extensions/mcp', 'integrations/alpha.md', 'src/gone.ts'] } }, 'path does not exist: src/gone.ts');
  });

  it('fails when an integration doc is cited by no entry', () => {
    failsWith({ integrationDocs: ['alpha.md', 'orphan.md'] }, "integrations/orphan.md is not in any entry's sources");
  });

  it('fails verified without live evidence and shipped without a pre-loss route', () => {
    const mode = { name: 'local', checkpointBeforeLoss: 'verified', lessonsBeforeLoss: 'planned', fixtureEvidence: ['tests/alpha.test.ts'], liveEvidence: [] };
    failsWith({ entry: { ...baseEntry(), modes: [mode] } }, 'checkpointBeforeLoss verified needs liveEvidence');
    failsWith({ entry: { ...baseEntry(), routes: { ...baseEntry().routes, preLossSave: null } } }, 'checkpointBeforeLoss shipped needs a preLossSave route');
  });

  it('fails integration none with sources, and a missing nullable field', () => {
    failsWith({ entry: { ...baseEntry(), integration: ['none'] } }, 'integration none stands alone and lists no sources');
    const { store: _store, ...withoutStore } = baseEntry();
    failsWith({ entry: withoutStore }, 'store must be present, a string or null');
  });

  it('lists every tool hippo setup detects, with the matching integration kind', () => {
    // SAFETY: the check script run in the first test validates this file's schema.
    const inventory = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'integrations', 'agent-inventory.json'), 'utf8')) as {
      entries: { id: string; integration: string[] }[];
    };
    const kindToIntegration = {
      'json-hook': 'native-hooks',
      plugin: 'native-plugin',
      wrapper: 'wrapper',
      'markdown-instruction': 'instruction-file',
    } as const;
    for (const tool of detectInstalledTools()) {
      const entry = inventory.entries.find((e) => e.id === tool.name);
      expect(entry, tool.name).toBeDefined();
      expect(entry!.integration, tool.name).toContain(kindToIntegration[tool.kind]);
    }
  });
});
