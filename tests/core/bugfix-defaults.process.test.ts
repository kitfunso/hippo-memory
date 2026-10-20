/**
 * Regression tests for two defects fixed alongside ROADMAP Part IX:
 *   1. physics scoring was on by default ('auto') although its paired
 *      ablation (benchmarks/physics-ablation/) measured it worse on every
 *      metric with the CI excluding zero;
 *   2. `hippo learn --git` ignored `config.gitLearnPatterns`, which only the
 *      MCP `hippo_learn` tool honoured.
 * Real git, the built CLI, real SQLite. No mocks.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_PHYSICS_CONFIG } from '../../src/core/physics-config.js';
import { loadConfig } from '../../src/core/config.js';
import { hippoOut } from '../_helpers/spawn-hippo.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

describe('physics scoring default', () => {
  it('is off unless a config opts in', () => {
    expect(DEFAULT_PHYSICS_CONFIG.enabled).toBe(false);
    const home = makeRoot('physics-default');
    expect(loadConfig(home).physics.enabled).toBe(false);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ physics: { enabled: 'auto' } }), 'utf8');
    expect(loadConfig(home).physics.enabled).toBe('auto');
  });
});

describe('hippo learn --git honours config.gitLearnPatterns', () => {
  let repo: string;

  beforeEach(() => {
    repo = makeRoot('learn-patterns', { init: false });
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'x', 'utf8');
    git('add', '.');
    git('commit', '-q', '-m', 'oops: parser dropped the trailing newline on windows paths during export');
    initTestStore(join(repo, '.hippo'));
  });

  function learn(): void {
    const env = { ...process.env, HIPPO_HOME: join(repo, 'global') };
    hippoOut(['learn', '--git', '--days', '30'], { cwd: repo, env });
  }
  const learned = (): string[] => loadAllEntries(join(repo, '.hippo'), 'default').map((e) => e.content);

  it('uses the built-in patterns by default', () => {
    learn();
    expect(learned().some((c) => c.includes('trailing newline'))).toBe(false);
  });

  it('uses a custom pattern list from config.json', () => {
    writeFileSync(join(repo, '.hippo', 'config.json'), JSON.stringify({ gitLearnPatterns: ['oops'] }), 'utf8');
    learn();
    expect(learned().some((c) => c.includes('trailing newline'))).toBe(true);
  });
});
