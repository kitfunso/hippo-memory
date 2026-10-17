// Cursor reads the root AGENTS.md and its docs no longer mention .cursorrules, so hippo
// writes AGENTS.md and opens .cursorrules only to remove a block an older hippo left there.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
const START = '<!-- hippo:start -->';
// What hippo wrote to .cursorrules before this change, trimmed.
const OLD_BLOCK = `${START}\n# Project Memory (Hippo)\n#   hippo context --auto --budget 1500\n<!-- hippo:end -->\n`;
// The block every release up to 1.52.6 wrote to .cursorrules, verbatim.
const RELEASED_BLOCK = '# Project Memory (Hippo)\n# Before each task, load context:\n#   hippo context --auto --budget 1500\n# After errors:\n#   hippo remember "<error description>" --error\n# After completing:\n#   hippo outcome --good';

const savedCwd = process.cwd();
let dir: string;
let proj: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cursor-'));
  proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, '.cursor', 'rules'), { recursive: true });
  vi.stubEnv('HIPPO_HOME', path.join(dir, 'global'));
  vi.stubEnv('HOME', dir);
  vi.stubEnv('USERPROFILE', dir);
  process.chdir(proj);
});
afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function hippo(...args: string[]): Promise<string> {
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    // A verb that sets process.exitCode instead of exiting fails here, as the real process would on exit.
    expect(r.status || Number(process.exitCode ?? 0), r.stderr).toBe(0);
    return r.stdout;
  } finally {
    process.exitCode = undefined;
  }
}
const write = (f: string, text: string) => fs.writeFileSync(path.join(proj, f), text);
const read = (f: string) => fs.readFileSync(path.join(proj, f), 'utf8');
const exists = (f: string) => fs.existsSync(path.join(proj, f));

describe('Cursor integration writes AGENTS.md', () => {
  it('init in a Cursor project writes the AGENTS.md block and no .cursorrules', async () => {
    write('AGENTS.md', '# Agents\n');
    await hippo('init', '--no-schedule', '--no-learn');
    expect(read('AGENTS.md')).toContain(START);
    expect(read('AGENTS.md')).toContain('hippo context --auto');
    expect(exists('.cursorrules')).toBe(false);
  });

  it('init leaves an existing .cursorrules untouched', async () => {
    write('AGENTS.md', '# Agents\n');
    write('.cursorrules', 'Use tabs.\n');
    await hippo('init', '--no-schedule', '--no-learn');
    expect(read('.cursorrules')).toBe('Use tabs.\n');
    expect(read('AGENTS.md')).toContain(START);
  });

  it('init creates neither file when the project has no AGENTS.md', async () => {
    await hippo('init', '--no-schedule', '--no-learn');
    expect(exists('AGENTS.md')).toBe(false);
    expect(exists('.cursorrules')).toBe(false);
  });

  it('hook install cursor patches AGENTS.md and never .cursorrules', async () => {
    write('AGENTS.md', '# Agents\n');
    write('.cursorrules', 'Use tabs.\n');
    await hippo('hook', 'install', 'cursor');
    expect(read('AGENTS.md')).toContain(START);
    expect(read('.cursorrules')).toBe('Use tabs.\n');
  });

  it('hook uninstall cursor removes the AGENTS.md block and a legacy .cursorrules block', async () => {
    write('AGENTS.md', '# Agents\n');
    await hippo('hook', 'install', 'cursor');
    expect(read('AGENTS.md')).toContain('## Project Memory (Hippo)');
    write('.cursorrules', `Use tabs.\n\n${OLD_BLOCK}`);
    await hippo('hook', 'uninstall', 'cursor');
    expect(read('AGENTS.md')).toBe('# Agents\n');
    expect(read('.cursorrules')).toBe('Use tabs.\n');
  });

  it('hook uninstall and install cursor leave the block init wrote for Codex', async () => {
    write('AGENTS.md', '# Agents\n');
    await hippo('init', '--no-schedule', '--no-learn');
    const agentsMd = read('AGENTS.md');
    expect(agentsMd).toContain("Hippo's Codex wrapper");
    write('.cursorrules', `Use tabs.\n\n${OLD_BLOCK}`);
    expect(await hippo('hook', 'uninstall', 'cursor')).toContain('hippo wrote it for codex');
    expect(read('AGENTS.md')).toBe(agentsMd);
    expect(read('.cursorrules')).toBe('Use tabs.\n');
    await hippo('hook', 'install', 'cursor');
    expect(read('AGENTS.md')).toBe(agentsMd);
  });

  it('hook uninstall cursor leaves an edited block and says hippo cannot tell whose it is', async () => {
    write('AGENTS.md', '# Agents\n');
    await hippo('hook', 'install', 'cursor');
    const edited = read('AGENTS.md').replace('<!-- hippo:end -->', 'Run the linter before every commit.\n<!-- hippo:end -->');
    write('AGENTS.md', edited);
    expect(await hippo('hook', 'uninstall', 'cursor')).toContain('it has been edited, so hippo cannot tell whose it is');
    expect(read('AGENTS.md')).toBe(edited);
  });

  it("hook uninstall cursor removes a released Cursor block a user moved into AGENTS.md", async () => {
    write('AGENTS.md', `# Agents\n\n${START}\n${RELEASED_BLOCK}\n<!-- hippo:end -->\n`);
    expect(await hippo('hook', 'uninstall', 'cursor')).not.toContain('edited');
    expect(read('AGENTS.md')).toBe('# Agents\n');
  });

  it('hook uninstall cursor deletes a .cursorrules that held only the old hippo block', async () => {
    write('.cursorrules', OLD_BLOCK);
    await hippo('hook', 'uninstall', 'cursor');
    expect(exists('.cursorrules')).toBe(false);
  });
});
