// The PR 2 list from the agent memory plan's Tests section, run against real stores in scratch folders.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dormantRestore, retrieve } from '../../src/api/index.js';
import { supersedeNow } from '../_helpers/supersede-now.js';
import { gateFirstWrite } from '../_helpers/write-gate.js';
import type { ContainerApply } from '../../src/base/ports/store/agent-import.js';
import type { ImportStore, ImportStores } from '../../src/domain/agent-memories/types.js';
import { consolidate } from '../../src/index.js';
import { importAtSessionEnd, importForStore, importProjectMemories } from '../../src/api/agent-memories.js';
import type { Machine } from '../../src/base/util/agent-homes.js';
import type { ImportReport } from '../../src/base/memory/agent-memory-report.js';
import { insertDormantRow } from '../../src/store/sqlite/dormant/dormant-rows.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { deriveOriginProject, isInitialized } from '../../src/host/project-identity.js';
import { removeEntryMirrors } from '../../src/store/sqlite/folder-files/mirrors.js';
import { deleteEntryRowInTx } from '../../src/store/sqlite/entries/entry-writes.js';
import {
  agentRows,
  auditCount,
  closeWorld,
  codexSummary,
  ctxFor,
  dormantRows,
  expectedContainer,
  liveRows,
  liveTexts,
  note,
  openWorld,
  projectNotes,
  sha,
  tally,
  toolTally,
  withDb,
  type World,
} from '../_helpers/agent-memories-world.js';
import { loadConfig } from '../../src/host/config-file.js';
import { sqliteImportStores } from '../../src/store/sqlite/maintenance/agent-import-stores.js';
import { writeEntry, loadAllEntries, readEntry } from '../_helpers/root-forms.js';
import { FIXED_NOW, pinClock } from '../_helpers/fixed-clock.js';
import { TEST_RUN } from '../_helpers/test-run.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';

pinClock();

const DEPLOY = 'Run the schema check before this service deploys.';
const STAGING = 'The staging database moved to the eu-central region.';
// AWS's documented example access key: a public placeholder, not a credential.
const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';
const CAP = 1500;

/** About 340 characters, each one different, so twelve of them pass the cap twice over. */
const paragraph = (i: number): string =>
  `Paragraph ${i} of the long note: ${'the build box keeps its cache warm between runs, '.repeat(6)}end ${i}.`;
const longBody = (n: number, ...tail: string[]): string =>
  [...Array.from({ length: n }, (_, i) => paragraph(i)), ...tail].join('\n\n');

/** Every live row is under the cap and none was cut short. */
function expectWholeParts(rows: readonly MemoryEntry[]): void {
  for (const row of rows) {
    expect(row.content.length).toBeLessThanOrEqual(CAP);
    expect(row.content.endsWith(' [truncated]')).toBe(false);
  }
}

let w: World;
beforeEach(() => {
  w = openWorld();
});
afterEach(() => {
  closeWorld(w);
  vi.unstubAllEnvs();
});

const sync = (): Promise<ImportReport> =>
  importForStore(w.local, {
    run: TEST_RUN,
    configAt: loadConfig,
    tenantId: 'default',
    stores: sqliteImportStores({}),
    machine: w.machine,
  });
const claude = (report: ImportReport) => toolTally(report, 'claude-code');

/** The real stores; `gate` runs once, at the import's first container write, after every read its plan made. */
function gatedStores(gate: (plan: ContainerApply) => Promise<void>): ImportStores {
  const real = sqliteImportStores({});
  const apply = gateFirstWrite(
    (plan: ContainerApply, store: ImportStore) => store.agentImport.applyContainer(plan),
    gate,
  );
  return {
    ...real,
    open: (root, opts) => {
      const store = real.open(root, opts);
      return { ...store, agentImport: { applyContainer: (plan) => apply(plan, store) } };
    },
  };
}

function legacyRow(content: string, file: string): MemoryEntry {
  const entry = createMemory(content, {
    tags: ['claude-code-memory'],
    source: `claude-memory:${file}`,
    tenantId: 'default',
    baseHalfLifeDays: 30,
  });
  writeEntry(w.local, entry);
  return entry;
}

describe('agent memory sync', () => {
  it('a new note is imported as one tagged, distilled row keyed by its folder, file and hash', async () => {
    const dir = projectNotes(w);
    note(dir, 'deploy.md', DEPLOY);

    expect(claude(await sync()).imported).toBe(1);
    const rows = liveRows(w.local);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      content: DEPLOY,
      tags: ['claude-code-memory'],
      kind: 'distilled',
      layer: Layer.Episodic,
      confidence: 'observed',
      originProject: 'proj',
    });
    expect(rows[0].source).toBe(
      `agent-memory:claude-code:${expectedContainer(dir, 'p')}/deploy.md#${sha(DEPLOY).slice(0, 16)}`,
    );
    expect(existsSync(join(w.local, 'episodic', `${rows[0].id}.md`))).toBe(true);
  });

  it('an unchanged note is skipped', async () => {
    note(projectNotes(w), 'deploy.md', DEPLOY);
    await sync();
    const [first] = liveRows(w.local);

    expect(claude(await sync())).toMatchObject({ imported: 0, replaced: 0, unchanged: 1 });
    expect(agentRows(w.local).map((e) => e.id)).toEqual([first.id]);
  });

  it('a deleted note is set aside through the real SQL, as source-deleted, and can be restored', async () => {
    const file = note(projectNotes(w), 'deploy.md', DEPLOY);
    await sync();
    const [row] = liveRows(w.local);

    unlinkSync(file);
    expect(claude(await sync()).setAside).toBe(1);
    expect(liveRows(w.local)).toEqual([]);
    expect(withDb(w.local, (db) => db.prepare('SELECT 1 FROM memories WHERE id = ?').get(row.id))).toBeUndefined();
    expect(existsSync(join(w.local, 'episodic', `${row.id}.md`))).toBe(false);
    const dormant = dormantRows(w.local);
    expect(dormant).toMatchObject([{ id: row.id, content: DEPLOY, reason: 'source-deleted' }]);
    expect(dormant[0].tags).not.toContain('claude-code-memory');
    expect(auditCount(w.local, 'agent_memory_set_aside')).toBe(1);

    expect((await dormantRestore(ctxFor(w.local), row.id)).id).toBe(row.id);
    expect(liveRows(w.local).map((e) => e.id)).toEqual([row.id]);
  });

  it('a missing folder changes nothing', async () => {
    const dir = projectNotes(w);
    note(dir, 'deploy.md', DEPLOY);
    await sync();
    const [row] = liveRows(w.local);

    rmSync(dir, { recursive: true });
    expect(claude(await sync())).toMatchObject({ setAside: 0, untagged: 0, imported: 0 });
    expect(liveRows(w.local)).toMatchObject([{ id: row.id, tags: ['claude-code-memory'] }]);
    expect(dormantRows(w.local)).toEqual([]);
  });

  it("a note whose row went dormant from decay gets its live row back, under the sync's own audit op", async () => {
    note(projectNotes(w), 'deploy.md', DEPLOY);
    await sync();
    const [row] = liveRows(w.local);
    withDb(w.local, (db) => {
      db.exec('BEGIN IMMEDIATE');
      insertDormantRow(db, { entry: row, strength: 0.01, reason: 'decay', dormantAt: new Date().toISOString() });
      deleteEntryRowInTx(db, row, 'test');
      db.exec('COMMIT');
    });
    removeEntryMirrors(w.local, row.id);
    expect(liveRows(w.local)).toEqual([]);

    expect(claude(await sync())).toMatchObject({ restored: 1, imported: 0 });
    expect(liveRows(w.local)).toMatchObject([{ id: row.id, content: DEPLOY, tags: ['claude-code-memory'] }]);
    expect(dormantRows(w.local)).toEqual([]);
    expect(auditCount(w.local, 'agent_memory_restore')).toBe(1);
    expect(auditCount(w.local, 'dormant_restore')).toBe(0);
  });

  it("legacy rows are adopted from the store's own folder only: same text first, then one row per file name", async () => {
    const dir = projectNotes(w);
    const OTHER = 'The billing queue drains at midnight in the other project.';
    note(dir, 'deploy.md', DEPLOY);
    note(dir, 'staging.md', STAGING);
    note(projectNotes(w, join(w.dir, 'other')), 'billing.md', OTHER);
    const renamed = legacyRow(DEPLOY, 'old-deploy-name.md');
    const edited = legacyRow('The staging database lives in us-east.', 'staging.md');
    const foreign = legacyRow(OTHER, 'billing.md');

    expect(claude(await sync())).toMatchObject({ adopted: 1, replaced: 1, imported: 0 });
    expect(readEntry(w.local, renamed.id)).toMatchObject({
      source: `agent-memory:claude-code:${expectedContainer(dir, 'p')}/deploy.md#${sha(DEPLOY).slice(0, 16)}`,
      supersededBy: null,
    });
    const staging = liveRows(w.local).find((e) => e.content === STAGING);
    expect(readEntry(w.local, edited.id)?.supersededBy).toBe(staging?.id);
    expect(readEntry(w.local, foreign.id)).toMatchObject({ source: 'claude-memory:billing.md', supersededBy: null });
    expect(liveTexts(w.local)).toEqual([DEPLOY, STAGING].sort());
  });

  // The legacy match reads its rows before the container's transaction, so only the guarded UPDATE sees the other writer.
  it('a legacy row another writer superseded after the import matched it keeps the successor that writer gave it', async () => {
    note(projectNotes(w), 'staging.md', STAGING);
    const edited = legacyRow('The staging database lives in us-east.', 'staging.md');

    const planned: string[] = [];
    let successorId = '';
    const report = await importForStore(w.local, {
      run: TEST_RUN,
      configAt: loadConfig,
      tenantId: 'default',
      stores: gatedStores(async (plan) => {
        planned.push(...plan.steps.flatMap((step) => (step.kind === 'write' ? step.supersedes : [])));
        successorId = await supersedeNow(ctxFor(w.local), edited.id, 'The staging database lives in ap-south.');
      }),
      machine: w.machine,
    });

    // A plan read after the other writer's commit names its successor instead, a legacy row of the same file.
    expect(planned).toEqual([edited.id]);
    // replaced: the plan still held the row, so the import did reach its supersede step with a stale copy.
    expect(claude(report)).toMatchObject({ replaced: 1, imported: 0 });
    expect(readEntry(w.local, edited.id)?.supersededBy).toBe(successorId);
    expect(auditCount(w.local, 'supersede')).toBe(1);
  });

  it('an old row with an email in clear matches its masked note, and a copy already imported collapses into one row', async () => {
    const MAIL = 'Release notes go to ops-team@example.com before each tag.';
    const MASKED = 'Release notes go to [email] before each tag.';
    const dir = projectNotes(w);
    note(dir, 'release.md', MAIL);
    const renamed = legacyRow(MAIL, 'old-release-name.md');
    expect(claude(await sync())).toMatchObject({ adopted: 1, imported: 0 });
    expect(readEntry(w.local, renamed.id)?.supersededBy).toBeNull();

    note(dir, 'mail.md', MAIL.replace('Release', 'Weekly'));
    await sync();
    const stale = {
      ...createMemory(MAIL.replace('Release', 'Weekly'), {
        tags: ['claude-code-memory'],
        source: 'claude-memory:gone.md',
        tenantId: 'default',
      }),
      created: '2026-01-01T00:00:00.000Z',
    };
    writeEntry(w.local, stale);

    await sync();
    const copy = liveRows(w.local).find((e) => e.content === MASKED.replace('Release', 'Weekly'));
    expect(readEntry(w.local, stale.id)?.supersededBy).toBe(copy?.id);
    expect(liveRows(w.local).filter((e) => e.content.includes('Weekly'))).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'win32')(
    'Windows folder case is normalised: the same folders in another case are the same container',
    async () => {
      note(projectNotes(w), 'deploy.md', DEPLOY);
      await sync();
      const upper: Machine = { ...w.machine, env: { CLAUDE_CONFIG_DIR: join(w.home, '.claude').toUpperCase() } };

      const again = await importProjectMemories(w.local.toUpperCase(), {
        run: TEST_RUN,
        configAt: loadConfig,
        tenantId: 'default',
        stores: sqliteImportStores({}),
        machine: upper,
      });
      expect(claude(again)).toMatchObject({ unchanged: 1, imported: 0, setAside: 0 });
      expect(liveRows(w.local)).toHaveLength(1);
    },
  );

  it('a secret note is skipped and counted, at every sync', async () => {
    const dir = projectNotes(w);
    note(dir, 'key.md', `The staging deploy user signs in with ${FAKE_KEY} on the build box.`);
    note(dir, 'deploy.md', DEPLOY);

    expect(claude(await sync())).toMatchObject({ imported: 1, secret: 1 });
    expect(claude(await sync())).toMatchObject({ imported: 0, secret: 1 });
    expect(liveTexts(w.local)).toEqual([DEPLOY]);
    expect(loadAllEntries(w.local, 'default').some((e) => e.content.includes(FAKE_KEY))).toBe(false);
  });

  it('the sync never writes to stdout or stderr, even when it skips, sets aside and warns', async () => {
    const dir = projectNotes(w);
    const gone = note(dir, 'gone.md', 'This note is deleted before the second sync.');
    await sync();
    unlinkSync(gone);
    note(dir, 'key.md', `The staging deploy user signs in with ${FAKE_KEY} on the build box.`);
    note(dir, 'deploy.md', DEPLOY);
    mkdirSync(join(w.home, '.codex', 'memories'), { recursive: true });
    writeFileSync(join(w.home, '.codex', 'memories', 'memory_summary.md'), 'not a Codex summary', 'utf8');

    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
      ...(['log', 'info', 'warn', 'error'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => undefined),
      ),
    ];
    let report: ImportReport;
    try {
      report = await sync();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(spies.map((s) => s.mock.calls.length)).toEqual(spies.map(() => 0));
    expect(tally(report)).toMatchObject({ imported: 1, setAside: 1, secret: 1 });
    expect(report.warnings.some((line) => line.includes('not a Codex memory summary'))).toBe(true);
  });

  it('imported rows are never merged or sent to extraction by sleep', async () => {
    const BASE = 'Fixed the server crash due to memory overflow in the worker process `pool.ts`';
    const dir = projectNotes(w);
    [BASE, `${BASE} again today`, `${BASE} once more`].forEach((text, i) => note(dir, `crash-${i}.md`, text));
    await sync();
    const before = liveRows(w.local)
      .map((e) => e.id)
      .sort();
    expect(before).toHaveLength(3);

    const result = await consolidate(w.local, { dryRun: false, now: FIXED_NOW });
    expect(result).toMatchObject({ merged: 0, extractionCandidates: 0 });
    expect(
      liveRows(w.local)
        .map((e) => e.id)
        .sort(),
    ).toEqual(before);
    expect(loadAllEntries(w.local, 'default').filter((e) => e.layer === Layer.Semantic)).toEqual([]);
  });

  it('session end in a folder without a store imports the project and session folder notes into the global store with the project as origin', async () => {
    const cwd = join(w.dir, 'hookproj', 'src');
    mkdirSync(join(w.dir, 'hookproj', '.git'), { recursive: true });
    mkdirSync(cwd);
    note(projectNotes(w, cwd), 'deploy.md', DEPLOY);
    const QUEUE = 'The session folder note says the queue drains at midnight.';
    const transcript = join(dirname(note(projectNotes(w, dirname(cwd)), 'queue.md', QUEUE)), '..', 's1.jsonl');
    writeFileSync(transcript, '', 'utf8');

    expect(
      claude(
        await importAtSessionEnd(cwd, transcript, {
          run: TEST_RUN,
          configAt: loadConfig,
          tenantId: 'default',
          stores: sqliteImportStores({}),
          machine: w.machine,
        }),
      ).imported,
    ).toBe(2);
    const origin = deriveOriginProject(cwd);
    expect(origin).not.toBe('');
    expect(liveTexts(w.global)).toEqual([DEPLOY, QUEUE].sort());
    expect(liveRows(w.global).map((e) => e.originProject)).toEqual([origin, origin]);
    expect(isInitialized(join(cwd, '.hippo'))).toBe(false);
    expect(liveRows(w.local)).toEqual([]);
  });
});

describe('agent memory sync: long notes in parts', () => {
  it('a note over the cap is stored whole in parts that open with its name, so its last line is recalled', async () => {
    const TAIL = 'RESOLVED 19 Nov: the docker disk reset fixed the hang.';
    note(projectNotes(w), 'tbench.md', longBody(12, TAIL), 'name: tbench disk hang\ntype: project');

    expect(claude(await sync())).toMatchObject({ secret: 0, setAside: 0 });
    const rows = liveRows(w.local);
    expect(rows.length).toBeGreaterThan(1);
    expectWholeParts(rows);
    expect(rows.every((r) => r.content.startsWith('tbench disk hang\n\n'))).toBe(true);
    const texts = rows.map((r) => r.content).join('\n');
    for (let i = 0; i < 12; i++) expect(texts).toContain(paragraph(i));
    const hits = (await retrieve(ctxFor(w.local), { query: 'docker disk reset hang' })).results;
    expect(hits.some((h) => h.content.includes(TAIL))).toBe(true);
  });

  it('a section under a non-Latin heading pairs only with itself, so a new one never supersedes a gone one', async () => {
    const dir = projectNotes(w);
    const body = `## Body\n\n${longBody(6)}`;
    note(dir, 'long.md', `## 日本語\n\nThe Japanese section says the cache lives on the D drive.\n\n${body}`);
    await sync();
    const gone = liveRows(w.local).find((r) => r.content.includes('Japanese section'));

    note(dir, 'long.md', `## Русский\n\nThe Russian section says the deploy runs on Fridays.\n\n${body}`);
    expect(claude(await sync())).toMatchObject({ imported: 1, replaced: 0, setAside: 1 });
    expect(dormantRows(w.local).map((d) => d.id)).toEqual([gone?.id]);
  });

  it('a paragraph appended to a long note moves one part, and a new section above moves none', async () => {
    const dir = projectNotes(w);
    const body = (...tail: string[]) => `## Alpha\n\n${longBody(6)}\n\n## Beta\n\n${longBody(6, ...tail)}`;
    note(dir, 'long.md', body());
    await sync();
    const first = liveRows(w.local).map((r) => r.id);

    note(dir, 'long.md', body('RESOLVED: the disk reset.'));
    const appended = claude(await sync());
    expect(appended.imported + appended.replaced).toBe(1);
    expect(appended.setAside).toBe(0);
    expect(liveRows(w.local).filter((r) => first.includes(r.id))).toHaveLength(first.length - appended.replaced);
    expect(liveRows(w.local).some((r) => r.content.includes('RESOLVED: the disk reset.'))).toBe(true);

    const second = liveRows(w.local).length;
    note(dir, 'long.md', `## Gamma\n\nThe new section says the cache lives on the D drive.\n\n${body('RESOLVED: the disk reset.')}`);
    expect(claude(await sync())).toMatchObject({ imported: 1, replaced: 0, setAside: 0, unchanged: second });
    expectWholeParts(liveRows(w.local));
  });

  it('a note grown past the cap gives its first part the recall count and outcomes of its old row', async () => {
    const dir = projectNotes(w);
    note(dir, 'grow.md', paragraph(0));
    await sync();
    const [old] = liveRows(w.local);
    writeEntry(w.local, { ...old, retrievalCount: 7, outcomePositive: 2, outcomeNegative: 1, outcomeScore: 1 });

    note(dir, 'grow.md', longBody(12));
    expect(claude(await sync())).toMatchObject({ replaced: 1, setAside: 0 });
    const head = liveRows(w.local).find((r) => r.content.includes(paragraph(0)));
    expect(head).toMatchObject({ retrievalCount: 7, outcomePositive: 2, outcomeNegative: 1, outcomeScore: 1 });
    expect(readEntry(w.local, old.id)?.supersededBy).toBe(head?.id);
    expect(dormantRows(w.local)).toEqual([]);
  });

  it('a note cut back under the cap gets one whole row that supersedes every part, with nothing set aside', async () => {
    const dir = projectNotes(w);
    note(dir, 'long.md', longBody(12));
    await sync();
    const parts = liveRows(w.local).map((r) => r.id);
    expect(parts.length).toBeGreaterThan(1);

    note(dir, 'long.md', paragraph(0));
    expect(claude(await sync())).toMatchObject({ replaced: 1, imported: 0, setAside: 0 });
    const rows = liveRows(w.local);
    expect(rows.map((r) => r.content)).toEqual([paragraph(0)]);
    for (const id of parts) expect(readEntry(w.local, id)?.supersededBy).toBe(rows[0].id);
    expect(dormantRows(w.local)).toEqual([]);
  });

  it('a key block where a cut would fall refuses the one part that holds it, whole, and keeps the rest', async () => {
    const BODY = runtimeJoin('MIIEow', 'IBAAKCAQEA');
    const pem = [
      runtimeJoin('-----BEGIN RSA ', 'PRIVATE KEY-----'),
      ...Array.from({ length: 10 }, (_, i) => `${BODY}${String(i).repeat(48)}`),
      runtimeJoin('-----END RSA ', 'PRIVATE KEY-----'),
    ].join('\n');
    const prose = Array.from({ length: 20 }, (_, i) => `Line ${i}: the deploy key rotates every quarter.`).join('\n');
    const AFTER = 'The tail section says the deploy runs on Fridays.';
    note(projectNotes(w), 'keys.md', `${prose}\n${pem}\n${prose}\n\n## After\n\n${AFTER}`);

    expect(claude(await sync())).toMatchObject({ secret: 1 });
    const texts = liveRows(w.local).map((r) => r.content);
    expect(texts.some((t) => t.includes('Line 0: the deploy key'))).toBe(true);
    expect(texts.some((t) => t.includes(AFTER))).toBe(true);
    expect(texts.some((t) => t.includes(BODY) || t.includes('PRIVATE KEY'))).toBe(false);
    expectWholeParts(liveRows(w.local));
  });

  it.each([
    ['codex', 'codex-memory'],
    ['openclaw', 'openclaw-memory'],
    ['gemini', 'gemini-memory'],
  ] as const)('%s: a bullet over the cap is stored whole in parts', async (tool, tag) => {
    const lines = Array.from({ length: 24 }, (_, i) => `  sub-line ${i}: the release checklist runs the smoke test first.`);
    const bullet = `- The release checklist, step by step:\n${lines.join('\n')}\n  END OF THE CHECKLIST`;
    const file = { openclaw: ['.openclaw', 'workspace', 'MEMORY.md'], gemini: ['.gemini', 'GEMINI.md'] };
    if (tool === 'codex') codexSummary(w, bullet);
    else {
      const path = join(w.home, ...file[tool]);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `## ${tool === 'gemini' ? 'Gemini Added Memories' : 'Facts'}\n\n${bullet}\n`, 'utf8');
    }

    expect(toolTally(await sync(), tool)).toMatchObject({ secret: 0, short: 0 });
    const rows = liveRows(w.global).filter((r) => r.tags.includes(tag));
    expect(rows.length).toBeGreaterThan(1);
    expectWholeParts(rows);
    expect(rows.some((r) => r.content.includes('END OF THE CHECKLIST'))).toBe(true);
    expect(toolTally(await sync(), tool)).toMatchObject({ unchanged: rows.length, imported: 0, setAside: 0 });
  });
});
