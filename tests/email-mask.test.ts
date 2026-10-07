// No raw email address is stored: the session digest, capture from a transcript and the handoff fields all mask it.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdCapture } from '../src/capture/command.js';
import { transcriptWorkingState } from '../src/capture/working-state.js';
import { maskEmails } from '../src/secret-detect.js';
import { writeSessionDigest } from '../src/session-digest.js';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';

const EMAIL = 'alice@example.com';
const REPLY = `Updated ${EMAIL} in customer.ts because the export failed.`;
const PROMPT = `We decided to send the customer.ts export to ${EMAIL} because billing reads it.`;

let tmp: string;
let repo: string;
let hippoRoot: string;
let origHippoHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-email-mask-'));
  repo = path.join(tmp, 'repo');
  hippoRoot = path.join(repo, '.hippo');
  initStore(hippoRoot);
  origHippoHome = process.env.HIPPO_HOME;
  process.env.HIPPO_HOME = path.join(tmp, 'global');
});

afterEach(() => {
  if (origHippoHome !== undefined) process.env.HIPPO_HOME = origHippoHome;
  else delete process.env.HIPPO_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function transcript(): string {
  const file = path.join(tmp, 's1.jsonl');
  const records = [
    { type: 'user', cwd: repo, message: { role: 'user', content: PROMPT } },
    { type: 'assistant', cwd: repo, message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] } },
  ];
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

describe('maskEmails', () => {
  it('masks addresses and leaves asset names, version pins and scopes alone', () => {
    expect(maskEmails(`mail ${EMAIL} or bob.smith+ci@mail.example.co.uk`)).toBe('mail [email] or [email]');
    expect(maskEmails('logo@2x.png react@18.2.0 @scope/pkg')).toBe('logo@2x.png react@18.2.0 @scope/pkg');
  });
});

describe('no stored text holds an email address', () => {
  it('in the session digest', () => {
    const edits = [{ filePath: path.join(repo, 'exports', `${EMAIL}.csv`), base: null }];
    const scan = { turns: [{ role: 'user' as const, text: 'the export keeps failing' }], finalText: REPLY, cwd: repo, edits };
    expect(writeSessionDigest(hippoRoot, scan, { key: 's1', tenantId: 'default' }).written).toBe(true);
    expect(loadAllEntries(hippoRoot).map((e) => e.content)).toEqual(['Updated [email] in customer.ts because the export failed.\nChanged: exports/[email]']);
  });

  it('in capture from a transcript', () => {
    cmdCapture(hippoRoot, { source: 'last-session', transcriptPath: transcript(), dryRun: false, global: false });
    const rows = JSON.stringify(loadAllEntries(hippoRoot));
    expect(rows).toContain('[email]');
    expect(rows).not.toContain(EMAIL);
  });

  it('in the handoff fields read from a transcript', () => {
    const state = JSON.stringify(transcriptWorkingState(transcript(), () => undefined));
    expect(state).toContain('[email]');
    expect(state).not.toContain(EMAIL);
  });
});
