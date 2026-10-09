// The Codex apply_patch reader the session digest uses for its Changed line.
import { describe, expect, it } from 'vitest';
import { patchPaths, shellPatch } from '../src/capture/codex-patch.js';

const patch = (...lines: string[]): string => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

describe('patchPaths', () => {
  it('reads Add, Update, Delete and Move headers in patch order', () => {
    const body = patch(
      '*** Add File: src/new.ts',
      '+export const x = 1;',
      '*** Update File: src/old.ts',
      '*** Move to: src/renamed.ts',
      '@@',
      '-a',
      '+b',
      '*** Delete File: src/gone.ts',
    );
    expect(patchPaths(body)).toEqual(['src/new.ts', 'src/old.ts', 'src/renamed.ts', 'src/gone.ts']);
  });

  it('treats a space-led header inside an update hunk as a context line', () => {
    const body = patch('*** Update File: a.ts', '@@', ' *** Add File: not-a-file.ts', '+x');
    expect(patchPaths(body)).toEqual(['a.ts']);
  });

  it('trims marker lines outside hunks, as the Codex parser does', () => {
    expect(patchPaths('  *** Begin Patch\n  *** Add File: b.ts  \n+x\n*** End Patch')).toEqual(['b.ts']);
  });

  it('stops at End Patch and ignores text with no patch', () => {
    expect(patchPaths(`${patch('*** Add File: a.ts', '+x')}\n*** Add File: after.ts`)).toEqual(['a.ts']);
    expect(patchPaths('Updated src/a.ts by hand.')).toEqual([]);
  });

  it('reads Move to only right after an Update header', () => {
    expect(patchPaths(patch('*** Add File: a.ts', '*** Move to: b.ts'))).toEqual(['a.ts']);
  });
});

describe('shellPatch', () => {
  const body = patch('*** Add File: src/a.ts', '+x');

  it('reads the direct argv form', () => {
    expect(shellPatch(['apply_patch', body])).toEqual({ body, cd: null });
  });

  it('reads a heredoc under bash -lc, with or without a quoted tag', () => {
    expect(shellPatch(['bash', '-lc', `apply_patch <<'EOF'\n${body}\nEOF\n`])?.body).toBe(body);
    expect(shellPatch(['bash', '-lc', `apply_patch <<EOF\n${body}\nEOF`])?.body).toBe(body);
  });

  it('keeps the cd target of a cd-and-patch heredoc', () => {
    expect(shellPatch(['bash', '-lc', `cd "pkg one" && apply_patch <<'PATCH'\n${body}\nPATCH`])).toEqual({ body, cd: 'pkg one' });
  });

  it('reads PowerShell and a plain command string', () => {
    expect(shellPatch(['pwsh', '-NoProfile', '-Command', `apply_patch <<'EOF'\n${body}\nEOF`])?.body).toBe(body);
    expect(shellPatch(`apply_patch <<'EOF'\n${body}\nEOF`)?.body).toBe(body);
  });

  it('returns null for any other command', () => {
    expect(shellPatch(['bash', '-lc', 'ls -la'])).toBeNull();
    expect(shellPatch(['git', 'apply', 'fix.patch'])).toBeNull();
    expect(shellPatch(['bash', '-lc', `apply_patch <<'EOF'\n${body}\nEOF\necho done`])).toBeNull();
  });
});
