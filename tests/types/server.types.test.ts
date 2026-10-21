/** The types an integrator sees from `hippo-memory/server` (src/server.ts). */

import { typeOnly } from './_type-only.js';
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  HttpError,
  NotFoundError,
  captureSessionTexts,
  isReservedActor,
  serve,
  type Context,
  type CaptureContext,
  type HippoStore,
  type SessionCaptureRequest,
  type ServeOpts,
  type ServerHandle,
} from '../../src/server.js';
import type { HippoConfig } from '../../src/entry/store-kit.js';
import { hasGroup } from '../../src/entry/store-kit.js';

declare const store: HippoStore;
declare const plain: Context;
declare const sessionReq: SessionCaptureRequest;

describe('hippo-memory/server entry types', () => {
  it('serve takes ServeOpts and resolves to a ServerHandle', () => {
    expectTypeOf(serve).parameters.toEqualTypeOf<[ServeOpts]>();
    expectTypeOf(serve).returns.toEqualTypeOf<Promise<ServerHandle>>();
    // hippoRoot is required, and the argument is an options object
    expectTypeOf<{ port: number }>().not.toMatchTypeOf<ServeOpts>();
    expectTypeOf<string>().not.toMatchTypeOf<ServeOpts>();
  });

  it('ServeOpts pins the fields an integrator sets', () => {
    expectTypeOf<ServeOpts['hippoRoot']>().toEqualTypeOf<string>();
    expectTypeOf<ServeOpts['port']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ServeOpts['host']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ServeOpts['store']>().toEqualTypeOf<HippoStore | undefined>();
    expectTypeOf<ServeOpts['autoSleep']>().toEqualTypeOf<false | undefined>();
  });

  it('ServerHandle exposes the port, url and an async stop', () => {
    expectTypeOf<ServerHandle['port']>().toEqualTypeOf<number>();
    expectTypeOf<ServerHandle['url']>().toEqualTypeOf<string>();
    expectTypeOf<ServerHandle['stop']>().toEqualTypeOf<() => Promise<void>>();
  });

  it('the error classes carry their HTTP status', () => {
    expectTypeOf<ConflictError['status']>().toEqualTypeOf<409>();
    expectTypeOf<NotFoundError['status']>().toEqualTypeOf<404>();
    expectTypeOf<BadRequestError['status']>().toEqualTypeOf<400>();
    expectTypeOf<ForbiddenError['status']>().toEqualTypeOf<403>();
    expectTypeOf<InstanceType<typeof HttpError>>().toMatchTypeOf<Error>();
    expect(new ConflictError('stale').status).toBe(409);
  });

  it('a Context carries the config its composition root loaded', () => {
    expectTypeOf<Context['config']>().toEqualTypeOf<HippoConfig>();
    typeOnly(() => {
      // @ts-expect-error config is required: the api reads no config file of its own
      const ctx: Context = { hippoRoot: '/tmp/root', tenantId: 't', actor: { subject: 'cli', role: 'admin' }, store };
      expectTypeOf(ctx).toEqualTypeOf<Context>();
    });
  });

  it('captureSessionTexts takes a Context whose store has captures, and hasGroup narrows one', () => {
    expectTypeOf(captureSessionTexts).parameter(0).toEqualTypeOf<CaptureContext>();
    // @ts-expect-error a store with no captures group has nowhere to read or write the session's rows
    typeOnly(() => captureSessionTexts(plain, sessionReq));
    typeOnly(() => {
      if (hasGroup(plain.store, 'captures')) captureSessionTexts({ ...plain, store: plain.store }, sessionReq);
    });
  });

  it('isReservedActor takes a subject string', () => {
    expectTypeOf(isReservedActor).toEqualTypeOf<(subject: string) => boolean>();
    // @ts-expect-error the subject is a string
    typeOnly(() => isReservedActor(1));
  });
});
