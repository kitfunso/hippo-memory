// Every stored version of a fact survives until one is retired: sleep never drops a value's text, and the paths below never skip a new value as a copy of an old one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { Layer, type MemoryEntry } from '../src/core/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries, readEntry } from '../src/store/entry-reads.js';
import { consolidate } from '../src/consolidate/sleep.js';
import { deduplicateStore } from '../src/consolidate/dedupe.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { queryAuditEvents } from '../src/store/audit.js';
import { insertRejectedValue, normalizeValueForRejection, rejectionDigest } from '../src/store/rejection.js';
import * as api from '../src/api/index.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { importProjectMemories } from '../src/agent-memories/sync.js';
import { totalTally } from '../src/agent-memories/report.js';
import { importEntries } from '../src/importers/core.js';
import { autoShare, getGlobalRoot, initGlobal, searchBoth, searchBothHybrid } from '../src/sharing/shared.js';
import { cmdCapture } from '../src/capture/command.js';
import { extractFromText } from '../src/capture/extract.js';
import { computeSalience } from '../src/core/salience.js';
import { heldTexts, mergedText } from '../src/util/same-text.js';
import { insertDormantRow } from '../src/store/dormant.js';
import { hippoOut } from './_helpers/spawn-hippo.js';

const DAY = 86_400_000;
const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-keep-both-'));
  dirs.push(dir);
  return dir;
}

function newRoot(): string {
  const root = join(tmp(), '.hippo'); // the CLI finds its store at <cwd>/.hippo
  initStore(root);
  // Replay would refresh the sources whose fade these tests watch.
  writeFileSync(join(root, 'config.json'), JSON.stringify({ replay: { count: 0 } }), 'utf8');
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(root: string, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry = { ...createMemory(text, { layer: Layer.Episodic }), ...extra };
  writeEntry(root, entry);
  return entry;
}

// A child process that cannot reach the real stores, the real launchers or a provider key.
function hermeticEnv(): NodeJS.ProcessEnv {
  const home = tmp();
  const env: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: join(home, 'global'), HOME: home, USERPROFILE: home, APPDATA: home, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
  delete env.ANTHROPIC_API_KEY;
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = (env[pathKey] ?? '').split(delimiter).filter((p) => !/[\\/]npm[\\/]?$/i.test(p)).join(delimiter);
  return env;
}

function hippo(root: string, ...args: string[]): string {
  return hippoOut(args, { cwd: dirname(root), env: hermeticEnv() });
}

const json = (out: string): { results: { id: string; content: string }[] } => JSON.parse(out.trim().split('\n').pop()!);

type ToolArgs = { query?: string; fresh_tail_count?: number; days?: number };

async function mcp(root: string, name: string, args: ToolArgs): Promise<string> {
  const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { hippoRoot: root, tenantId: 'default', actor: 'mcp' });
  // SAFETY: the tools/call case always wraps a tool's output as { content: [{ type: 'text', text }] }.
  const result = res?.result as { content?: { text?: string }[] } | undefined;
  return result?.content?.[0]?.text ?? '';
}

const merged = (root: string): MemoryEntry[] => loadAllEntries(root).filter((e) => e.source === 'consolidation');
const activeText = (root: string): string => loadAllEntries(root).map((e) => e.content).join('\n');

function halfLifeKept(root: string, entries: MemoryEntry[]): void {
  for (const e of entries) expect(readEntry(root, e.id)!.half_life_days).toBe(e.half_life_days);
}

function reject(root: string, contents: string[]): void {
  const db = openHippoDb(root);
  try {
    for (const content of contents) {
      insertRejectedValue(db, {
        tenantId: 'default',
        digest: rejectionDigest(content),
        reason: 'rejected before the upgrade',
        rejectedBy: 'test',
        rejectedAt: new Date().toISOString(),
        normalizedChars: normalizeValueForRejection(content).length,
      });
    }
  } finally {
    closeHippoDb(db);
  }
}

// The merge and dedup phases of api.sleep, run daily for a week and once more after demoted sources have faded.
async function sleepMany(root: string): Promise<void> {
  const start = Date.now();
  for (const day of [1, 2, 3, 4, 5, 6, 7, 600]) {
    await consolidate(root, { now: new Date(start + day * DAY) });
    deduplicateStore(root);
  }
}

describe('sleep keeps both versions', () => {
  it('a look-alike pair keeps both facts across several sleeps', async () => {
    const root = newRoot();
    const facts = ['The staging service listens on port 4400.', 'The analytics service listens on port 7700.'];
    for (const text of facts) write(root, text);

    await sleepMany(root);

    for (const text of facts) expect(activeText(root)).toContain(text);
  });

  it('a correction pair keeps the current value', async () => {
    const root = newRoot();
    const corrections = [
      // The old text is longer, so a merge that kept only the longest text kept the old value.
      ['The web app dev server runs on port 3000 for local development work.', 'The web app dev server now runs on port 5173.'],
      // Same wording, so dedup saw a duplicate and kept the old value by content order.
      ['The public API rate limit is 100 requests', 'The public API rate limit is 250 requests'],
    ];
    for (const text of corrections.flat()) write(root, text);

    await sleepMany(root);

    for (const [, current] of corrections) expect(activeText(root)).toContain(current);
  });

  it('repeated sleeps do not re-merge or re-fade the same sources', async () => {
    const root = newRoot();
    const a = write(root, 'The staging service listens on port 4400.');
    const b = write(root, 'The analytics service listens on port 7700.');
    const start = Date.now();

    expect((await consolidate(root, { now: new Date(start + DAY) })).semanticCreated).toBe(1);
    const derived = loadAllEntries(root).filter((e) => e.layer === Layer.Semantic);
    expect(derived).toHaveLength(1);
    expect([...derived[0].parents].sort()).toEqual([a.id, b.id].sort());
    const demoted = readEntry(root, a.id)!.half_life_days;
    expect(demoted).toBeLessThan(a.half_life_days);

    for (const day of [2, 3]) {
      const again = await consolidate(root, { now: new Date(start + day * DAY) });
      expect(again.merged).toBe(0);
      expect(again.semanticCreated).toBe(0);
    }
    expect(readEntry(root, a.id)!.half_life_days).toBe(demoted);
    expect(readEntry(root, b.id)!.half_life_days).toBe(demoted);
    expect(loadAllEntries(root).filter((e) => e.layer === Layer.Semantic)).toHaveLength(1);
  });

  it('dedup keeps a pair whose text differs in a value', () => {
    const root = newRoot();
    const pairs = [
      ['The dev server port is 3000', 'The dev server port is 5173'],
      // The overlap tokenizer drops 1-char tokens, so these two score as identical.
      ['Retry the flaky upload step 3 times', 'Retry the flaky upload step 5 times'],
      ['The team uses npm to install packages in the monorepo', 'The team uses pnpm to install packages in the monorepo'],
    ];
    for (const text of pairs.flat()) writeEntry(root, createMemory(text));

    expect(deduplicateStore(root).removed).toBe(0);
    expect(loadAllEntries(root)).toHaveLength(6);
  });

  it('dedup removes a copy of the same text whatever the threshold says', () => {
    const root = newRoot();
    const text = 'The staging service listens on port 4400.';
    for (const t of [text, text.replace(' ', '  ')]) writeEntry(root, createMemory(t));

    expect(deduplicateStore(root, { threshold: 1 }).removed).toBe(1);
    expect(loadAllEntries(root)).toHaveLength(1);

    const cli = newRoot();
    for (const t of [text, text.replace(' ', '  ')]) writeEntry(cli, createMemory(t));
    hippo(cli, 'dedup', '--threshold', '1');
    expect(loadAllEntries(cli)).toHaveLength(1);
  });
});

describe('merge caps', () => {
  it('merges at most five sources; the rest stay unmerged and keep their half-life', async () => {
    const root = newRoot();
    const sources = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((name) =>
      write(root, `The nightly build for the ${name} service writes its cache to the shared volume.`));

    expect((await consolidate(root, { now: new Date() })).semanticCreated).toBe(1);

    const [row] = merged(root);
    expect(row.parents).toHaveLength(5);
    const left = sources.filter((e) => !row.parents.includes(e.id));
    expect(left).toHaveLength(1);
    expect(row.content).not.toContain(left[0].content);
    halfLifeKept(root, left);
  });

  it('merges at most 2,000 characters of source text', async () => {
    const root = newRoot();
    const body = 'The nightly build writes its cache to the shared volume and prunes entries older than a week. '.repeat(9).trim();
    const sources = ['alpha', 'bravo', 'charlie'].map((name) => write(root, `${name}: ${body}`));
    for (const e of sources) expect(e.content.length).toBeGreaterThan(700); // two fit under the cap, three do not
    for (const e of sources) expect(e.content.length).toBeLessThan(1000);

    expect((await consolidate(root, { now: new Date() })).semanticCreated).toBe(1);

    const [row] = merged(root);
    expect(row.parents).toHaveLength(2);
    halfLifeKept(root, sources.filter((e) => !row.parents.includes(e.id)));
  });

  it('a source over the size cap never seeds a merge of the texts it alone links', async () => {
    const root = newRoot();
    const checklist = 'Deploy checklist: build the image, run the migrations, warm the cache, flip the traffic, watch the error rate. ';
    const seed = write(root, checklist.repeat(20).trim(), { created: new Date(Date.now() - DAY).toISOString() }); // oldest, so it seeds first
    const steps = ['Deploy step: build the image and run the migrations.', 'Deploy step: warm the cache, flip the traffic and watch the error rate.']
      .map((text) => write(root, text));

    expect((await consolidate(root, { now: new Date() })).semanticCreated).toBe(0);
    halfLifeKept(root, [seed, ...steps]);
  });

  it('text with no word tokens never merges', async () => {
    const root = newRoot();
    const rows = ['预发布服务监听端口四千四百', '分析服务监听端口七千七百'].map((text) => write(root, text));

    expect((await consolidate(root, { now: new Date() })).semanticCreated).toBe(0);
    halfLifeKept(root, rows);
  });

  // Seven look-alikes, oldest first, so the first five form the capped merge.
  function sevenLookAlikes(root: string): MemoryEntry[] {
    const start = Date.now() - DAY;
    return ['alpha', 'bravo', 'delta', 'gamma', 'kappa', 'omega', 'sigma'].map((name, i) =>
      write(root, `The nightly build for the ${name} service writes its cache to the shared volume.`, { created: new Date(start + i * 60_000).toISOString() }));
  }

  it('a rejected merge leaves the rows past the cap free to merge', async () => {
    const root = newRoot();
    const rows = sevenLookAlikes(root);
    reject(root, [`[Consolidated pattern from 5 related memories, newest first]\n\n${rows.slice(0, 5).reverse().map((e) => `- ${e.content}`).join('\n')}`]);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await consolidate(root, { now: new Date() })).semanticCreated).toBe(1);
    expect([...merged(root)[0].parents].sort()).toEqual(rows.slice(5).map((e) => e.id).sort());
    const db = openHippoDb(root);
    try {
      expect(queryAuditEvents(db, { tenantId: 'default', op: 'reject_refusal' })[0].metadata.sourceIds).toEqual(rows.slice(0, 5).map((e) => e.id));
    } finally {
      closeHippoDb(db);
    }
  });

  it('a merge rejected before this release still covers the rows past the cap', async () => {
    const root = newRoot();
    const rows = sevenLookAlikes(root);
    reject(root, [`[Consolidated pattern from 7 related memories]\n\n${rows.map((e) => `- ${e.content}`).join('\n')}`]); // the old format merged every look-alike
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await consolidate(root, { now: new Date() })).semanticCreated).toBe(0);
    halfLifeKept(root, rows);
  });
});

describe('merged row', () => {
  it('writes each distinct text once', async () => {
    const root = newRoot();
    const staging = 'The staging service listens on port 4400.';
    for (const text of [staging, staging.replace(' ', '  '), 'The analytics service listens on port 7700.']) write(root, text);

    await consolidate(root, { now: new Date() });

    const [row] = merged(root);
    expect(row.parents).toHaveLength(3);
    expect(row.content.split('port 4400')).toHaveLength(2);
    expect(row.content).toContain('The analytics service listens on port 7700.');
  });

  it('lists its texts newest first, and a rejection of the old format still matches', async () => {
    // The oldest text is also the longest and first by text, so a length or text sort would lead with the old value.
    const texts = [
      'Deploy note: the staging service listens on port 4400 for the internal dashboard traffic.',
      'Deploy note: the staging service listens on port 4401 for the internal dashboard.',
      'Deploy note: the staging service listens on port 4402 for the dashboard.',
    ];
    const writeAll = (root: string): void => texts.forEach((text, i) => { write(root, text, { created: new Date(Date.now() - DAY + i * 60_000).toISOString() }); });
    const root = newRoot();
    writeAll(root);

    await consolidate(root, { now: new Date() });
    expect(merged(root)[0].content).toBe(`[Consolidated pattern from 3 related memories, newest first]\n\n${[...texts].reverse().map((t) => `- ${t}`).join('\n')}`);

    const again = newRoot();
    writeAll(again);
    reject(again, [`[Consolidated pattern from 3 related memories]\n\n${texts.map((t) => `- ${t}`).join('\n')}`]); // the old format: longest first
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await consolidate(again, { now: new Date() })).semanticCreated).toBe(0);
  });

  it('a merge rejected before this release stays rejected', async () => {
    const root = newRoot();
    const pair = ['The staging service listens on port 4400.', 'The analytics service listens on port 7700.'];
    const triple = ['billing', 'orders', 'search'].map((db) => `Nightly backups of the ${db} database run at 02:00 UTC.`);
    const sources = [...pair, ...triple].map((text) => write(root, text));
    // The rows the previous release wrote for these clusters: the longest text alone for two sources, first lines for more.
    reject(root, [
      `[Consolidated from 2 related memories]\n\n${pair[1]}`,
      `[Consolidated pattern from 3 related memories]\n\n${triple.map((t) => `- ${t}`).join('\n')}`,
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await consolidate(root, { now: new Date() })).semanticCreated).toBe(0);
    expect(merged(root)).toHaveLength(0);
    halfLifeKept(root, sources);
  });

  it('reads back every text it holds, lines and all', () => {
    const texts = ['Deploy steps:\n- build the image\n\nthen flip the traffic', 'The staging service listens on port 4400.'];
    const content = mergedText('[Consolidated from 2 related memories, newest first]', texts);
    expect(heldTexts({ content, source: 'consolidation' })).toEqual(texts);
  });
});

describe('a retired version leaves the merged row', () => {
  const OLD = 'The web app dev server runs on port 3000 locally.';
  const NEW = 'The web app dev server now runs on port 5173 locally.';
  const ctx = (root: string): api.Context => ({ hippoRoot: root, tenantId: 'default', actor: api.adminActor('cli') });
  const recalled = (root: string): string => api.recall(ctx(root), { query: 'web app dev server port' }).results.map((r) => r.content).join('\n');
  const current = (root: string): string => loadAllEntries(root).filter((e) => !e.superseded_by).map((e) => e.content).join('\n');

  async function mergedPair(): Promise<{ root: string; old: MemoryEntry; next: MemoryEntry; row: MemoryEntry }> {
    vi.stubEnv('HIPPO_HOME', join(tmp(), 'global'));
    const root = newRoot();
    const old = write(root, OLD, { created: new Date(Date.now() - DAY).toISOString() });
    const next = write(root, NEW);
    await consolidate(root, { now: new Date() });
    const [row] = merged(root);
    expect(row.parents.sort()).toEqual([old.id, next.id].sort());
    return { root, old, next, row };
  }

  it('reject takes the value out of every merged row that holds it, in the same call', async () => {
    const { root, old, next, row } = await mergedPair();
    api.forget(ctx(root), next.id); // as if the demoted source had faded, so only the merged row still holds the new value

    const out = hippo(root, 'reject', old.id, '--reason', 'the port moved');

    const [kept] = merged(root);
    expect(out).toContain(`keep their other texts in: ${kept.id}`);
    expect(loadAllEntries(root).map((e) => e.id)).not.toContain(row.id);
    expect(kept.content).toBe(`[Consolidated from 1 related memory, newest first]\n\n- ${NEW}`);
    expect(kept.parents).toEqual([next.id]);
    expect(current(root)).not.toContain(OLD);
    expect(recalled(root)).toContain(NEW);
    expect(recalled(root)).not.toContain('port 3000');
  });

  it('reject takes the value out of a dormant merged row, so restoring it cannot bring the value back', async () => {
    const { root, old, next, row } = await mergedPair();
    const db = openHippoDb(root);
    try {
      insertDormantRow(db, { entry: row, strength: 0.01, reason: 'decay', dormantAt: new Date().toISOString() });
    } finally {
      closeHippoDb(db);
    }
    api.forget(ctx(root), row.id); // sleep's decay pass moves a row this way: dormant copy in, live row out

    const out = hippo(root, 'reject', old.id, '--reason', 'the port moved');
    const [dormant] = api.listDormant(ctx(root));
    const restored = api.restoreDormant(ctx(root), dormant.id);

    expect(current(root)).not.toContain(OLD);
    expect(recalled(root)).not.toContain('port 3000');
    expect(restored.content).toBe(`[Consolidated from 1 related memory, newest first]\n\n- ${NEW}`);
    expect(restored.parents).toEqual([next.id]);
    expect(out).toContain(`Dormant merged rows that held it keep their other texts in: ${dormant.id}`);
  });

  it('a superseded version leaves the merged row at the next sleep', async () => {
    const { root, old, next } = await mergedPair();
    api.supersede(ctx(root), old.id, 'The web app dev server runs on port 5173, set in vite.config.ts.');

    await consolidate(root, { now: new Date(Date.now() + DAY) });

    expect(current(root)).not.toContain(OLD);
    expect(recalled(root)).not.toContain('port 3000');
    expect(merged(root).map((e) => [e.content, e.parents])).toEqual([[`[Consolidated from 1 related memory, newest first]\n\n- ${NEW}`, [next.id]]]);
  });

  it('sleep takes a rejected text out of merged rows, including rows an older release wrote', async () => {
    const { root, next, row } = await mergedPair();
    const legacy = write(root, `[Consolidated from 2 related memories]\n\n${OLD}`, { layer: Layer.Semantic, source: 'consolidation' });
    reject(root, [OLD]); // a rejection whose sweep missed the merged rows, as resolve --reject-loser leaves it

    await consolidate(root, { now: new Date(Date.now() + DAY) });

    const ids = loadAllEntries(root).map((e) => e.id);
    expect(ids).not.toContain(row.id);
    expect(ids).not.toContain(legacy.id);
    expect(merged(root).map((e) => [e.content, e.parents])).toEqual([[`[Consolidated from 1 related memory, newest first]\n\n- ${NEW}`, [next.id]]]);
  });
});

describe('recall and context show a merged row, not the sources it holds', () => {
  const FACTS = ['General project context: the staging service listens on port 4400.', 'General project context: the analytics service listens on port 7700.'];
  const QUERY = 'service listens port';
  const copies = (text: string): number => text.split('port 4400').length - 1;
  const ctx = (root: string): api.Context => ({ hippoRoot: root, tenantId: 'default', actor: api.adminActor('cli') });

  async function mergedStore(): Promise<{ root: string; row: MemoryEntry }> {
    vi.stubEnv('HIPPO_HOME', join(tmp(), 'global'));
    vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', '');
    const root = newRoot();
    for (const text of FACTS) write(root, text, { kind: 'raw' }); // raw, so the fresh tail offers them too
    await consolidate(root, { now: new Date() });
    const [row] = merged(root);
    return { root, row };
  }

  it('api context', async () => {
    const { root, row } = await mergedStore();
    const got = await api.getContext(ctx(root), { q: QUERY, budget: 4000, crossProject: true });
    expect(got.entries.map((r) => r.entry.id)).toEqual([row.id]);
  });

  it('api recall with a fresh tail', async () => {
    const { root, row } = await mergedStore();
    expect(api.recall(ctx(root), { query: QUERY, freshTailCount: 5 }).results.map((r) => r.id)).toEqual([row.id]);
  });

  it('CLI recall and explain', async () => {
    const { root, row } = await mergedStore();
    for (const cmd of ['recall', 'explain']) expect(json(hippo(root, cmd, QUERY, '--json')).results.map((r) => r.id), cmd).toEqual([row.id]);
  });

  it('CLI recall whose budget cuts the merged row still shows the sources it holds', async () => {
    const { root } = await mergedStore();
    // 140 tokens print both source lines but not the merged row ranked after them.
    const shown = json(hippo(root, 'recall', QUERY, '--json', '--budget', '140', '--min-results', '0')).results.map((r) => r.content);
    expect(shown.sort()).toEqual([...FACTS].sort());
  });

  it('CLI recall filtered to the episodic layer still shows the sources', async () => {
    const { root } = await mergedStore();
    const shown = json(hippo(root, 'recall', QUERY, '--json', '--layer', 'episodic')).results.map((r) => r.content);
    expect(shown.sort()).toEqual([...FACTS].sort());
  });

  it('MCP recall with a fresh tail, and MCP context', async () => {
    const { root, row } = await mergedStore();
    const recalled = await mcp(root, 'hippo_recall', { query: QUERY, fresh_tail_count: 5 });
    expect(recalled).toContain(row.content);
    expect(copies(recalled)).toBe(1);

    const cwd = process.cwd();
    process.chdir(tmp()); // outside a git repo hippo_context has no query and lists by strength
    try {
      const context = await mcp(root, 'hippo_context', {});
      expect(context).toContain(row.content);
      expect(copies(context)).toBe(1);
    } finally {
      process.chdir(cwd);
    }
  });

  it('MCP recall counts the hidden sources as filtered before ranking, as CLI and API recall do', async () => {
    const { root } = await mergedStore();
    expect(await mcp(root, 'hippo_recall', { query: QUERY })).toContain('Showing 1 of 3 candidates; 2 filtered pre-rank.');
  });

  const hookContext = async (root: string): Promise<string[]> =>
    (await api.getContext(ctx(root), { pinnedOnly: true, includeRecent: 5, budget: 4000, crossProject: true })).entries.map((r) => r.entry.id);

  it('a pinned memory never merges, so the per-prompt block still shows it after a sleep', async () => {
    vi.stubEnv('HIPPO_HOME', join(tmp(), 'global'));
    const root = newRoot();
    const pin = write(root, 'Deploy rule: the staging service listens on port 4400.', { pinned: true });
    write(root, 'Deploy rule: the staging service listens on port 4401.');

    expect((await consolidate(root, { now: new Date() })).semanticCreated).toBe(0);
    expect(await hookContext(root)).toContain(pin.id);
  });

  it('a merged row from an older release does not hide a pinned memory it holds', async () => {
    vi.stubEnv('HIPPO_HOME', join(tmp(), 'global'));
    const root = newRoot();
    const text = 'Deploy rule: the staging service listens on port 4400.';
    const pin = write(root, text, { pinned: true, created: new Date(Date.now() - DAY).toISOString() });
    const old = write(root, `[Consolidated from 2 related memories]\n\n${text}`, { layer: Layer.Semantic, source: 'consolidation' });

    expect(await hookContext(root)).toEqual(expect.arrayContaining([old.id, pin.id]));
  });
});

describe('a new value is never skipped as a copy of an old one', () => {
  const OLD = 'the dev server port is 3000 in the vite config for local work';
  const NEW = OLD.replace('3000', '5173');
  // Equal for their first 200 characters, all that the old share and search keys compared.
  const LONG_OLD = `${'The deploy runbook covers build, migrate, warm the cache and flip traffic. '.repeat(3)}The dev server port is 3000.`;
  const LONG_NEW = LONG_OLD.replace('3000', '5173');
  const texts = (root: string): string[] => loadAllEntries(root).map((e) => e.content);

  function commit(repo: string, message: string): void {
    const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, env: hermeticEnv(), stdio: 'ignore' }); };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'x');
    git('add', 'a.txt');
    git('commit', '-q', '-m', message);
  }

  it('CLI learn --git', () => {
    const root = newRoot();
    write(root, OLD);
    commit(dirname(root), `fix: ${NEW}`);

    hippo(root, 'learn', '--git', '--days', '30');
    hippo(root, 'learn', '--git', '--days', '30');

    expect(texts(root).sort()).toEqual([NEW, OLD].sort());
  });

  it('MCP hippo_learn', async () => {
    const root = newRoot();
    write(root, OLD);
    commit(dirname(root), `fix: ${NEW}`);
    const cwd = process.cwd();
    process.chdir(dirname(root)); // hippo_learn reads the git log of its working directory
    try {
      expect(await mcp(root, 'hippo_learn', { days: 30 })).toContain('1 new, 0 duplicates skipped');
      expect(await mcp(root, 'hippo_learn', { days: 30 })).toContain('0 new, 1 duplicates skipped');
    } finally {
      process.chdir(cwd);
    }
  });

  it('Claude Code memory import', () => {
    const root = newRoot();
    write(root, OLD);
    const home = tmp();
    const project = realpathSync.native(dirname(root)).replace(/[^a-zA-Z0-9]/g, '-'); // the import reads only this project's folder
    const memDir = join(home, '.claude', 'projects', project, 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'port.md'), `---\nname: port\n---\n${NEW}\n`);

    const imported = (): number => totalTally(importProjectMemories(root, { machine: { home, env: {}, platform: process.platform } })).imported;
    expect(imported()).toBe(1);
    expect(imported()).toBe(0);
  });

  it('import', () => {
    const root = newRoot();
    write(root, OLD);
    const result = importEntries([NEW, OLD.replace(' ', '  ')], 'test', [], { hippoRoot: root });
    expect([result.imported, result.skipped]).toEqual([1, 1]);
  });

  it('capture', () => {
    const root = newRoot();
    const note = 'decision: cap the connection pool at 15k';
    const [item] = extractFromText(note);
    write(root, item.content.replace('15k', '1.5k')); // the old check dropped punctuation, so 1.5k and 15k read as one text
    const file = join(tmp(), 'session.txt');
    writeFileSync(file, `${note}\n`);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    cmdCapture(root, { source: 'file', filePath: file, dryRun: false, global: false });

    expect(texts(root)).toContain(item.content);
  });

  it('autoShare', () => {
    vi.stubEnv('HIPPO_HOME', join(tmp(), 'global'));
    initGlobal();
    write(getGlobalRoot(), LONG_OLD);
    const root = newRoot();
    write(root, LONG_NEW);
    write(root, LONG_OLD.replace(' ', '  '));

    expect(autoShare(root, { minScore: 0, dryRun: true }).map((e) => e.content)).toEqual([LONG_NEW]);
  });

  it('search across the local and global stores', async () => {
    vi.stubEnv('HIPPO_HOME', join(tmp(), 'global'));
    initGlobal();
    write(getGlobalRoot(), LONG_OLD);
    const root = newRoot();
    write(root, LONG_NEW);
    const contents = (rs: { entry: MemoryEntry }[]): string[] => rs.map((r) => r.entry.content).sort();

    expect(contents(searchBoth('dev server port', root, getGlobalRoot()))).toEqual([LONG_NEW, LONG_OLD].sort());
    expect(contents(await searchBothHybrid('dev server port', root, getGlobalRoot()))).toEqual([LONG_NEW, LONG_OLD].sort());
  });

  it('the salience gate', () => {
    const old = createMemory(OLD);
    expect(computeSalience(NEW, [], [old]).decision).toBe('store');
    expect(computeSalience(OLD.replace(' ', '  '), [], [old]).decision).toBe('skip');
  });
});
