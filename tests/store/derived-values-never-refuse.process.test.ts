// Values hippo derives from the folder (path tags, compaction cwd and transcript_path, folder project names) never
// refuse a write: a folder named like a key stores in redacted form, and no raw byte of it reaches the store.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { resolveProjectIdentity } from '../../src/host/project-identity.js';
import { buildPromptHookContext } from '../../src/api/prompt-hook.js';
import { adminActor } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { initHippo, runHippo, spawnHippo, transcriptJsonl, withScratchEnv } from '../_helpers/pre-compact-e2e.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';

// A made-up sk-style body, lowercase so the folder name and its lowercased project name hold the same bytes.
const BODY = 'fakefolder0123456789abcdef7';
const FOLDER = runtimeJoin('sk-', BODY);

/** Every file under `dir` that holds `needle`. */
function filesHolding(dir: string, needle: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((f) => fs.readFileSync(f).includes(needle));
}

describe('a folder named like a key', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let root: string;
  let cwd: string;

  beforeEach(async () => {
    ({ dir, env } = withScratchEnv());
    root = path.join(dir, FOLDER);
    cwd = path.join(root, 'src');
    fs.mkdirSync(cwd, { recursive: true });
    await initHippo(root, env);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('remember from inside it succeeds and stores no raw byte of the folder name', async () => {
    const result = await runHippo(['remember', 'the rollback plan runs before every deploy'], cwd, env);
    expect(result.status, result.stderr).toBe(0);
    const db = openHippoDb(path.join(root, '.hippo'));
    try {
      // SAFETY: the SELECT names exactly the two text columns the record holds.
      const row = db.prepare('SELECT tags_json, origin_project FROM memories').get() as Record<string, string>;
      expect(row.tags_json).toContain('path:src');
      expect(JSON.stringify(row)).not.toContain(BODY);
    } finally {
      closeHippoDb(db);
    }
    expect(filesHolding(path.join(root, '.hippo'), BODY)).toEqual([]);
  });

  it('pre-compact from inside it writes its compactions row, with cwd and transcript_path redacted', async () => {
    const transcriptPath = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(
      transcriptPath,
      transcriptJsonl([{ type: 'user', message: { role: 'user', content: 'add rate limiting to the endpoint' } }]),
    );
    const payload = JSON.stringify({
      session_id: 'sess-derived-1',
      transcript_path: transcriptPath,
      cwd,
      hook_event_name: 'PreCompact',
    });
    const result = await spawnHippo(['pre-compact'], cwd, env, payload);
    expect(result.status, result.stderr).toBe(0);
    const db = openHippoDb(path.join(root, '.hippo'));
    try {
      const rows = db.prepare('SELECT cwd, transcript_path, origin_project FROM compactions').all();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(BODY);
      expect(JSON.stringify(rows)).toContain('[REDACTED');
    } finally {
      closeHippoDb(db);
    }
    expect(filesHolding(path.join(root, '.hippo'), BODY)).toEqual([]);
  });

  it('a row a base build stamped with the raw folder name stays in the default context', async () => {
    const store = path.join(root, '.hippo');
    const entry = { ...createMemory('PINNED: the folder keeps its rollback plan'), pinned: true };
    writeEntry(store, entry);
    const db = openHippoDb(store);
    try {
      db.prepare('UPDATE memories SET origin_project = ? WHERE id = ?').run(FOLDER, entry.id);
    } finally {
      closeHippoDb(db);
    }
    const result = await runHippo(['context', '--pinned-only'], cwd, env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('the folder keeps its rollback plan');
  });

  it('a hook call whose project the client resolved from it succeeds', async () => {
    vi.stubEnv('HIPPO_HOME', dir);
    const project = resolveProjectIdentity(cwd);
    expect(JSON.stringify([project.name, project.legacyName, project.aliases])).not.toContain(BODY);
    const ctx = apiCtx(path.join(root, '.hippo'), 'default', adminActor('derived-test'));
    await expect(buildPromptHookContext(ctx, { sessionId: 'sess-derived-2', project })).resolves.toBeDefined();
  });
});
