import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { importProjectMemories } from '../../src/api/agent-memories.js';
import { totalTally, type Tally } from '../../src/base/memory/agent-memory-report.js';
import { detectSecret } from '../../src/base/util/secret-detect.js';
import { loadConfig } from '../../src/host/config-file.js';
import { sqliteImportStores } from '../../src/store/sqlite/maintenance/agent-import-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { REAL_IO } from '../_helpers/real-io.js';
import { TEST_RUN } from '../_helpers/test-run.js';

const sync = async (root: string, home: string): Promise<Tally> =>
  totalTally(
    await importProjectMemories(root, {
      run: TEST_RUN,
      configAt: loadConfig,
      tenantId: 'default',
      stores: sqliteImportStores({}),
      machine: { home, env: {}, platform: process.platform, ...REAL_IO },
    }),
  );

const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';

let hippoRoot: string;
let homeDir: string;

function writeMemoryFile(name: string, frontmatter: string, body: string): void {
  const project = fs.realpathSync.native(path.dirname(hippoRoot)).replace(/[^a-zA-Z0-9]/g, '-');
  const memDir = path.join(homeDir, '.claude', 'projects', project, 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, name), `---\n${frontmatter}\n---\n${body}\n`, 'utf8');
}

beforeEach(() => {
  hippoRoot = makeRoot('secret-veto-store');
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-secret-veto-home-'));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('agent memory import secret veto', () => {
  it('sanity: the fixture key is flagged by detectSecret', () => {
    expect(detectSecret({ content: `key: ${FAKE_KEY}`, tags: [] }).flagged).toBe(true);
  });

  it('imports a benign memory file but skips a secret-bearing one', async () => {
    writeMemoryFile(
      'reference_some_api_key.md',
      'name: some-api-key\ntype: reference',
      `# Some prod API key\n\nAPI key (raw): \`${FAKE_KEY}\`\nThe plaintext above is the only recoverable copy.`,
    );
    writeMemoryFile(
      'lesson_deploys.md',
      'name: deploy-lesson\ntype: reference',
      'Always run lighthouse after deploys and check the console before shipping.',
    );

    const tally = await sync(hippoRoot, homeDir);

    expect([tally.imported, tally.secret]).toEqual([1, 1]);

    const entries = loadAllEntries(hippoRoot, 'default');
    const joined = entries.map((e) => e.content).join('\n');

    expect(joined).toContain('run lighthouse after deploys');
    expect(joined).not.toContain(FAKE_KEY);
    expect(joined).not.toContain('only recoverable copy');
  });

  it('imports normally when no secret files are present', async () => {
    writeMemoryFile(
      'lesson_one.md',
      'name: one\ntype: reference',
      'Prefer parameterized queries to string concatenation for all SQL.',
    );
    writeMemoryFile(
      'lesson_two.md',
      'name: two\ntype: reference',
      'Pin dependency versions and review before upgrading them.',
    );

    expect((await sync(hippoRoot, homeDir)).imported).toBe(2);
  });
});
