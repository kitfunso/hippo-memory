// Cursor reads the root AGENTS.md and its docs no longer mention .cursorrules, so hippo
// writes AGENTS.md and opens .cursorrules only to remove a block an older hippo left there.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');
const START = '<!-- hippo:start -->';
// What hippo wrote to .cursorrules before this change, trimmed.
const OLD_BLOCK = `${START}\n# Project Memory (Hippo)\n#   hippo context --auto --budget 1500\n<!-- hippo:end -->\n`;

let dir: string;
let proj: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cursor-'));
  proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, '.cursor', 'rules'), { recursive: true });
  env = { ...process.env, HIPPO_HOME: path.join(dir, 'global'), HOME: dir, USERPROFILE: dir };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function hippo(...args: string[]): string {
  const r = spawnSync(process.execPath, [HIPPO_JS, ...args], { cwd: proj, env, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}
const write = (f: string, text: string) => fs.writeFileSync(path.join(proj, f), text);
const read = (f: string) => fs.readFileSync(path.join(proj, f), 'utf8');
const exists = (f: string) => fs.existsSync(path.join(proj, f));

describe('Cursor integration writes AGENTS.md', () => {
  it('init in a Cursor project writes the AGENTS.md block and no .cursorrules', () => {
    write('AGENTS.md', '# Agents\n');
    hippo('init', '--no-schedule', '--no-learn');
    expect(read('AGENTS.md')).toContain(START);
    expect(read('AGENTS.md')).toContain('hippo context --auto');
    expect(exists('.cursorrules')).toBe(false);
  });

  it('init leaves an existing .cursorrules untouched', () => {
    write('AGENTS.md', '# Agents\n');
    write('.cursorrules', 'Use tabs.\n');
    hippo('init', '--no-schedule', '--no-learn');
    expect(read('.cursorrules')).toBe('Use tabs.\n');
    expect(read('AGENTS.md')).toContain(START);
  });

  it('init creates neither file when the project has no AGENTS.md', () => {
    hippo('init', '--no-schedule', '--no-learn');
    expect(exists('AGENTS.md')).toBe(false);
    expect(exists('.cursorrules')).toBe(false);
  });

  it('hook install cursor patches AGENTS.md and never .cursorrules', () => {
    write('AGENTS.md', '# Agents\n');
    write('.cursorrules', 'Use tabs.\n');
    hippo('hook', 'install', 'cursor');
    expect(read('AGENTS.md')).toContain(START);
    expect(read('.cursorrules')).toBe('Use tabs.\n');
  });

  it('hook uninstall cursor removes the AGENTS.md block and a legacy .cursorrules block', () => {
    write('AGENTS.md', '# Agents\n');
    hippo('hook', 'install', 'cursor');
    expect(read('AGENTS.md')).toContain('## Project Memory (Hippo)');
    write('.cursorrules', `Use tabs.\n\n${OLD_BLOCK}`);
    hippo('hook', 'uninstall', 'cursor');
    expect(read('AGENTS.md')).toBe('# Agents\n');
    expect(read('.cursorrules')).toBe('Use tabs.\n');
  });

  it('hook uninstall and install cursor leave the block init wrote for Codex', () => {
    write('AGENTS.md', '# Agents\n');
    hippo('init', '--no-schedule', '--no-learn');
    const agentsMd = read('AGENTS.md');
    expect(agentsMd).toContain("Hippo's Codex wrapper");
    write('.cursorrules', `Use tabs.\n\n${OLD_BLOCK}`);
    expect(hippo('hook', 'uninstall', 'cursor')).toContain('hippo wrote it for codex');
    expect(read('AGENTS.md')).toBe(agentsMd);
    expect(read('.cursorrules')).toBe('Use tabs.\n');
    hippo('hook', 'install', 'cursor');
    expect(read('AGENTS.md')).toBe(agentsMd);
  });

  it('hook uninstall cursor leaves an edited block and says hippo cannot tell whose it is', () => {
    write('AGENTS.md', '# Agents\n');
    hippo('hook', 'install', 'cursor');
    const edited = read('AGENTS.md').replace('<!-- hippo:end -->', 'Run the linter before every commit.\n<!-- hippo:end -->');
    write('AGENTS.md', edited);
    expect(hippo('hook', 'uninstall', 'cursor')).toContain('it has been edited, so hippo cannot tell whose it is');
    expect(read('AGENTS.md')).toBe(edited);
  });

  it('hook uninstall cursor deletes a .cursorrules that held only the old hippo block', () => {
    write('.cursorrules', OLD_BLOCK);
    hippo('hook', 'uninstall', 'cursor');
    expect(exists('.cursorrules')).toBe(false);
  });
});
