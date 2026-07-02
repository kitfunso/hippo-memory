/**
 * Regression: the Claude Code memory importer (learnFromMemoryMd) must never
 * ingest a secret-bearing memory file. Some ~/.claude/projects/<p>/memory/*.md
 * files exist purely to hold a live credential (e.g. an API-key reference).
 *
 * v1.24.0 added the secret veto to share/promote/sync/ambient but missed this
 * ingest path, so a live key could land in the store on `hippo sleep`. v1.24.1
 * gates the importer with detectSecret. This test locks that in.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { learnFromMemoryMd } from '../src/cli.js';
import { initStore, loadAllEntries } from '../src/store.js';
import { detectSecret } from '../src/secret-detect.js';

// AWS's own documented example access key — a well-known non-secret placeholder,
// safe to embed. NEVER put a real credential in a fixture, even here.
const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';

let hippoRoot: string;
let homeDir: string;

function writeMemoryFile(name: string, frontmatter: string, body: string): void {
  const memDir = path.join(homeDir, '.claude', 'projects', 'C--Users-test', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, name), `---\n${frontmatter}\n---\n${body}\n`, 'utf8');
}

beforeEach(() => {
  hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-secret-veto-store-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-secret-veto-home-'));
  initStore(hippoRoot);
});

afterEach(() => {
  fs.rmSync(hippoRoot, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('learnFromMemoryMd secret veto', () => {
  it('sanity: the fixture key is flagged by detectSecret', () => {
    expect(detectSecret({ content: `key: ${FAKE_KEY}`, tags: [] }).flagged).toBe(true);
  });

  it('imports a benign memory file but skips a secret-bearing one', () => {
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

    const imported = learnFromMemoryMd(hippoRoot, homeDir);

    // Only the benign file is ingested.
    expect(imported).toBe(1);

    const entries = loadAllEntries(hippoRoot);
    const joined = entries.map(e => e.content).join('\n');

    // The benign lesson is present...
    expect(joined).toContain('run lighthouse after deploys');
    // ...and the secret never entered the store.
    expect(joined).not.toContain(FAKE_KEY);
    expect(joined).not.toContain('only recoverable copy');
  });

  it('imports normally when no secret files are present', () => {
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

    const imported = learnFromMemoryMd(hippoRoot, homeDir);
    expect(imported).toBe(2);
  });
});
