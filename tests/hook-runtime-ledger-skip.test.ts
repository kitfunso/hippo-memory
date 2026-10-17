// A hook whose delivery recorder cannot start skips the ledger with one leveled warn line and still returns null.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startDeliveryRecorder, startToolFailureRecorder } from '../src/api/prompt-hook.js';
import { adminActor } from '../src/api/types.js';
import { initStore } from '../src/store/open.js';
import { apiCtx } from './_helpers/api-ctx.js';
import { sqliteStore } from '../src/store/sqlite/store.js';

describe('startDeliveryRecorder when the recorder cannot start', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns null and writes one warn line with a space after the colon', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // A number where a root path belongs, for the context and its store: path.join throws on it, which is the start-up
    // failure under test.
    const badRoot: string = JSON.parse('42');
    const ctx = { hippoRoot: badRoot, store: sqliteStore(badRoot), tenantId: 'default', actor: adminActor('cli'), reach: { hasLocal: true, isGlobal: false, shared: false } };
    expect(startDeliveryRecorder(ctx, { stdinText: undefined, runtime: 'claude-code', envSessionId: undefined })).toBeNull();
    expect(err.mock.calls).toHaveLength(1);
    expect(String(err.mock.calls[0][0])).toMatch(/^\[hippo\] warn: delivery ledger skipped: \S.* ts=\S+ errorClass=\w+ stack=.*\n$/);
  });
});

describe('startToolFailureRecorder', () => {
  const saved = process.env.HIPPO_HOME;
  let tmp = '';
  afterEach(() => {
    if (saved === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when the ledger store is not the hook store, and a recorder when they are one', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-tf-recorder-'));
    const globalRoot = path.join(tmp, 'global');
    fs.mkdirSync(globalRoot);
    initStore(globalRoot);
    fs.writeFileSync(path.join(globalRoot, 'config.json'), JSON.stringify({ deliveryLedger: { enabled: true } }));
    process.env.HIPPO_HOME = globalRoot;
    const noStore = path.join(tmp, 'proj', '.hippo');
    const start = { stdinText: '{}', runtime: 'claude-code' as const, envSessionId: undefined };
    expect(startToolFailureRecorder(apiCtx(noStore), start)).toBeNull();
    expect(startToolFailureRecorder(apiCtx(globalRoot), start)).not.toBeNull();
  });
});
