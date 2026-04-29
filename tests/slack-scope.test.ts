import { describe, it, expect } from 'vitest';
import { scopeFromChannel } from '../src/connectors/slack/scope.js';

describe('scopeFromChannel', () => {
  it('public channel → slack:public:<id>', () => {
    expect(scopeFromChannel({ id: 'C123', is_private: false, is_im: false, is_mpim: false })).toBe('slack:public:C123');
  });
  it('private channel → slack:private:<id>', () => {
    expect(scopeFromChannel({ id: 'C456', is_private: true })).toBe('slack:private:C456');
  });
  it('DM (im) → slack:private:<id>', () => {
    expect(scopeFromChannel({ id: 'D1', is_im: true })).toBe('slack:private:D1');
  });
  it('group DM (mpim) → slack:private:<id>', () => {
    expect(scopeFromChannel({ id: 'G1', is_mpim: true })).toBe('slack:private:G1');
  });
  it('unknown → defaults to private (fail closed)', () => {
    expect(scopeFromChannel({ id: 'X1' })).toBe('slack:private:X1');
  });
});
