import { describe, it, expect } from 'vitest';
import { messageToRememberOpts } from '../src/connectors/slack/transform.js';

describe('messageToRememberOpts', () => {
  it('produces kind=raw + slack:// artifact_ref + scope from channel privacy', () => {
    const opts = messageToRememberOpts({
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      message: { type: 'message', channel: 'C1', user: 'U1', text: 'incident at 3pm', ts: '1700000000.000100' },
    });
    expect(opts).not.toBeNull();
    expect(opts!.kind).toBe('raw');
    expect(opts!.scope).toBe('slack:public:C1');
    expect(opts!.artifactRef).toBe('slack://T1/C1/1700000000.000100');
    expect(opts!.content).toBe('incident at 3pm');
    expect(opts!.tags).toEqual(expect.arrayContaining(['source:slack', 'channel:C1']));
  });

  it('skips empty bodies (returns null)', () => {
    const opts = messageToRememberOpts({
      teamId: 'T1',
      channel: { id: 'C1' },
      message: { type: 'message', channel: 'C1', ts: '1700000000.000100' },
    });
    expect(opts).toBeNull();
  });

  it('private channel maps to slack:private:<id>', () => {
    const opts = messageToRememberOpts({
      teamId: 'T1',
      channel: { id: 'C2', is_private: true },
      message: { type: 'message', channel: 'C2', user: 'U1', text: 'secret', ts: '1700000000.000100' },
    });
    expect(opts!.scope).toBe('slack:private:C2');
  });

  it('populates owner from message.user so provenance gate passes', () => {
    const opts = messageToRememberOpts({
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      message: { type: 'message', channel: 'C1', user: 'U999', text: 'hello', ts: '1700000000.000100' },
    });
    expect(opts!.owner).toBe('user:U999');
  });

  it('falls back to bot:unknown when neither user nor bot_id is present', () => {
    // v1.4.0: the v0.40.0 provenance gate requires a non-null owner on every
    // raw row. Userless events without bot_id are rare (older REST shapes)
    // but still need a sentinel so the gate stays clean. See codex round 1
    // P1 in docs/plans/2026-05-05-provenance-ci-gate.md.
    const opts = messageToRememberOpts({
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      message: { type: 'message', channel: 'C1', text: 'system note', ts: '1700000000.000100' },
    });
    expect(opts!.owner).toBe('bot:unknown');
  });

  it('derives bot:<bot_id> owner for bot_message subtype with no user', () => {
    const opts = messageToRememberOpts({
      teamId: 'T1',
      channel: { id: 'C1', is_private: false },
      message: {
        type: 'message',
        subtype: 'bot_message',
        channel: 'C1',
        text: 'bot says hi',
        ts: '1700000000.000200',
        bot_id: 'B01ABCD',
      },
    });
    expect(opts!.owner).toBe('bot:B01ABCD');
    expect(opts!.tags).toContain('bot:B01ABCD');
  });
});
