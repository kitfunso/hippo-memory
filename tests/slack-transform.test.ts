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
});
