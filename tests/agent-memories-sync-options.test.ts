// Design 4, 5, 8 and 11: tool switches, busy stores, dry runs, the summary line and the item's own time.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { getContext } from '../src/api.js';
import { summaryLine } from '../src/agent-memories/report.js';
import { importForStore, type Machine, type SyncOptions } from '../src/agent-memories/sync.js';
import type { ImportReport } from '../src/agent-memories/report.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { createMemory } from '../src/memory.js';
import { isContentWorthStoring } from '../src/audit.js';
import { claudeFolderName } from '../src/agent-memories/claude-code.js';
import { isInitialized, writeEntry } from '../src/store.js';
import {
  auditTotal, closeWorld, codexSummary, ctxFor, dormantRows, liveRows, liveTexts, note, openWorld, projectNotes, tally, toolTally, userNotes,
  writeConfig, type World,
} from './_helpers/agent-memories-world.js';

const A = 'Run the schema check before this service deploys.';
const B = 'The staging database moved to the eu-central region.';
const USER_NOTE = 'Prefers short replies with the command first.';
const BULLET = '- Prefers tabs over spaces in Go files.';
// AWS's documented example access key: a public placeholder, not a credential.
const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let w: World;
let dir: string;
beforeEach(() => {
  w = openWorld();
  dir = projectNotes(w);
});
afterEach(() => closeWorld(w));

const withEnv = (env: Machine['env']): Machine => ({ ...w.machine, env });
const sync = (extra: Partial<SyncOptions> = {}): ImportReport => importForStore(w.local, { machine: w.machine, ...extra });
const claude = (report: ImportReport) => toolTally(report, 'claude-code');

describe('agent memory sync: options, time and reporting', () => {
  it('HIPPO_AGENT_MEMORY_TOOLS overrides config; empty and none turn the import off', () => {
    writeConfig(w.local, []);
    note(dir, 'deploy.md', A);
    codexSummary(w, BULLET);

    for (const off of ['', 'none', ' NONE ']) {
      expect(tally(importForStore(w.local, { machine: withEnv({ HIPPO_AGENT_MEMORY_TOOLS: off }) })).imported).toBe(0);
    }
    expect(tally(sync()).imported).toBe(0);
    const report = importForStore(w.local, { machine: withEnv({ HIPPO_AGENT_MEMORY_TOOLS: 'claude-code, codex,nosuchtool' }) });
    expect([claude(report).imported, toolTally(report, 'codex').imported]).toEqual([1, 1]);
    expect(report.warnings.filter((line) => line.includes('"nosuchtool"'))).toHaveLength(2);
  });

  it('agentMemories.tools: [] in a project store stops its project pass and its user pass', () => {
    writeConfig(w.local, []);
    note(dir, 'deploy.md', A);
    note(userNotes(w), 'u.md', USER_NOTE);

    expect(tally(sync()).imported).toBe(0);
    expect(isInitialized(w.global)).toBe(false);
    expect(tally(importForStore(w.global, { machine: w.machine })).imported).toBe(1);
    expect(liveTexts(w.global)).toEqual([USER_NOTE]);
  });

  it('a one-tool list imports that tool only', () => {
    writeConfig(w.local, ['codex']);
    note(dir, 'deploy.md', A);
    codexSummary(w, BULLET);

    const report = sync();
    expect([claude(report).imported, toolTally(report, 'codex').imported]).toEqual([0, 1]);
    expect(liveRows(w.local)).toEqual([]);
  });

  it('a busy container is skipped with one warning and nothing set aside', () => {
    const gone = note(dir, 'gone.md', A);
    sync();
    unlinkSync(gone);
    note(dir, 'new.md', B);
    const holder = openHippoDb(w.local);
    let report: ImportReport;
    try {
      holder.exec('BEGIN IMMEDIATE');
      report = sync({ busyWaitMs: 50 });
    } finally {
      holder.exec('ROLLBACK');
      closeHippoDb(holder);
    }
    expect(report.warnings.filter((line) => line.includes('busy'))).toHaveLength(1);
    expect(claude(report)).toMatchObject({ setAside: 0, imported: 0 });
    expect(liveTexts(w.local)).toEqual([A]);

    expect(claude(sync())).toMatchObject({ setAside: 1, imported: 1 });
    expect(liveTexts(w.local)).toEqual([B]);
  });

  it('a dry run writes nothing and reports what would move', () => {
    const gone = note(dir, 'gone.md', A);
    sync();
    unlinkSync(gone);
    note(dir, 'new.md', B);
    note(userNotes(w), 'u.md', USER_NOTE);
    const before = { ids: liveRows(w.local).map((e) => e.id), audit: auditTotal(w.local) };

    const report = sync({ dryRun: true });
    expect(claude(report)).toMatchObject({ imported: 2, setAside: 1 });
    expect({ ids: liveRows(w.local).map((e) => e.id), audit: auditTotal(w.local) }).toEqual(before);
    expect(dormantRows(w.local)).toEqual([]);
    expect(isInitialized(w.global)).toBe(false);
  });

  it('a dry run counts kept rows in a config folder this run did not list', () => {
    const alt = join(w.home, 'alt-claude');
    const altMachine = withEnv({ CLAUDE_CONFIG_DIR: alt });
    note(join(alt, 'projects', claudeFolderName(w.project), 'memory'), 'alt.md', B);
    importForStore(w.local, { machine: altMachine });
    note(dir, 'deploy.md', A);
    sync();

    expect(sync({ dryRun: true }).tools.find((t) => t.tool === 'claude-code')?.unlisted).toBe(1);
    expect(importForStore(w.local, { machine: altMachine, dryRun: true }).tools.find((t) => t.tool === 'claude-code')?.unlisted).toBe(1);
  });

  it('summaryLine names what moved, and is null when nothing did', () => {
    note(dir, 'a.md', A);
    const bFile = note(dir, 'b.md', B);
    const secret = note(dir, 'secret.md', `Deploys sign in with ${FAKE_KEY} on the build box.`);
    codexSummary(w, BULLET);
    expect(summaryLine(sync())).toBe('Imported 3 agent memories (Claude Code 2, Codex 1); 1 skipped for a secret.');

    unlinkSync(secret);
    expect(summaryLine(sync())).toBeNull();

    note(dir, 'a.md', `${A} Then run the smoke test.`);
    unlinkSync(bFile);
    expect(summaryLine(sync())).toBe('Agent memories: 1 replaced, 1 set aside.');

    note(dir, 'b.md', B);
    expect(summaryLine(sync())).toBe('Agent memories: 1 brought back.');

    const row = liveRows(w.local).find((e) => e.content === B);
    if (row !== undefined) writeEntry(w.local, { ...row, pinned: true });
    unlinkSync(bFile);
    expect(summaryLine(sync())).toBe('Agent memories: 1 pinned memory kept with the note gone.');
  });

  it('created carries the item\'s time as a 24-character Z timestamp, from an offset modified too, capped at now', () => {
    note(dir, 'offset.md', A, 'type: feedback\nmodified: 2026-03-04T10:00:00+02:00');
    const byMtime = note(dir, 'mtime.md', B);
    utimesSync(byMtime, new Date('2025-11-05T06:07:08.123Z'), new Date('2025-11-05T06:07:08.123Z'));
    note(dir, 'future.md', USER_NOTE, 'type: feedback\nmodified: 2099-01-01T00:00:00Z');
    const start = Date.now();
    sync();
    const end = Date.now();

    const byText = new Map(liveRows(w.local).map((e) => [e.content, e]));
    expect([byText.get(A)?.created, byText.get(A)?.valid_from]).toEqual(['2026-03-04T08:00:00.000Z', '2026-03-04T08:00:00.000Z']);
    expect(byText.get(B)?.created).toBe('2025-11-05T06:07:08.123Z');
    const future = Date.parse(byText.get(USER_NOTE)?.created ?? '');
    expect(future >= start - 1000 && future <= end).toBe(true);
    expect(liveRows(w.local).map((e) => ISO_Z.test(e.created))).toEqual([true, true, true]);
  });

  it('a 40-note import leaves the recent-N context slots to newer rows', async () => {
    const monthAgo = new Date(Date.now() - 30 * 86_400_000);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const fresh = Array.from({ length: 5 }, (_, i) => {
      const made = createMemory(`Incident ${i + 700} on the Orders API was fixed by raising the pool to ${i + 20} connections.`, { tenantId: 'default', baseHalfLifeDays: 30 });
      const entry = { ...made, created: yesterday, valid_from: yesterday };
      writeEntry(w.local, entry);
      return entry.id;
    });
    for (let i = 0; i < 40; i++) {
      const file = note(dir, `n${i}.md`, `Build ${i} of the payments service needs flag ${i + 100} set before release.`);
      utimesSync(file, monthAgo, monthAgo);
    }
    expect(claude(sync()).imported).toBe(40);

    const result = await getContext(ctxFor(w.local), { pinnedOnly: true, includeRecent: 5, currentProject: 'proj', budget: 100_000 });
    expect(result.entries.map((e) => e.entry.id).sort()).toEqual([...fresh].sort());
  });

  it('a one-line preference is imported, since the worth check is off', () => {
    const PREF = 'keep replies short';
    expect(isContentWorthStoring(PREF)).toBe(false);
    note(dir, 'pref.md', PREF);
    codexSummary(w, '- likes terse answers');

    const report = sync();
    expect([claude(report).imported, toolTally(report, 'codex').imported]).toEqual([1, 1]);
    expect(liveTexts(w.local)).toEqual([PREF]);
    expect(liveTexts(w.global)).toEqual(['User Profile: likes terse answers']);
  });
});
