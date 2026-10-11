// RequestDeadline.onceIdle must run every function registered while store calls are in flight, not only the last one.
import { describe, expect, it } from 'vitest';
import { RequestDeadline } from '../src/util/request-scope.js';

function pendingCall() {
  let settle!: () => void;
  const call = new Promise<void>((resolve) => { settle = resolve; });
  return { call, settle };
}

describe('RequestDeadline.onceIdle', () => {
  it('runs a function at once when no store call is in flight', () => {
    const ran: string[] = [];
    new RequestDeadline(Date.now() + 1000).onceIdle(() => ran.push('now'));
    expect(ran).toEqual(['now']);
  });

  it('runs every function registered during a call, in order, once the last call settles', async () => {
    const deadline = new RequestDeadline(Date.now() + 1000);
    const first = pendingCall();
    const second = pendingCall();
    deadline.track(first.call);
    deadline.track(second.call);
    const ran: string[] = [];
    deadline.onceIdle(() => ran.push('first'));
    deadline.onceIdle(() => ran.push('second'));

    first.settle();
    await first.call;
    expect(ran).toEqual([]);
    second.settle();
    await second.call;
    expect(ran).toEqual(['first', 'second']);

    // Each ran once: a later idle moment does not replay them.
    const third = pendingCall();
    deadline.track(third.call);
    third.settle();
    await third.call;
    expect(ran).toEqual(['first', 'second']);
  });
});
