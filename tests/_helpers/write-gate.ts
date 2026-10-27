// A race test's other writer runs at the loser's first write, after its reads, so no timer decides which comes first.
import type { ConnectorContext } from '../../src/surface/connectors/ingest.js';

/** `write` with `gate` run once before the first call goes through; later calls wait on the same gate. */
export function gateFirstWrite<A extends unknown[], R>(
  write: (...args: A) => Promise<R>,
  gate: (...args: A) => Promise<void>,
): (...args: A) => Promise<R> {
  let passed: Promise<void> | undefined;
  return async (...args) => {
    passed ??= gate(...args);
    await passed;
    return write(...args);
  };
}

/** A connector context whose first write is gated, and whether each of its event-log pre-checks saw the event. */
export interface GatedConnector<C> {
  readonly ctx: C;
  readonly preChecks: boolean[];
}

/** `ctx` whose first connector write runs `gate` first. */
export function gateConnectorWrite<C extends ConnectorContext>(ctx: C, gate: () => Promise<void>): GatedConnector<C> {
  const preChecks: boolean[] = [];
  const { connectorEvents, connectorWrites } = ctx.store;
  const eventRecord: typeof connectorEvents.eventRecord = async (...args) => {
    const record = await connectorEvents.eventRecord(...args);
    preChecks.push(record.seen);
    return record;
  };
  const writeConnectorEntry = gateFirstWrite(
    (...args: Parameters<typeof connectorWrites.writeConnectorEntry>) => connectorWrites.writeConnectorEntry(...args),
    gate,
  );
  const store = {
    ...ctx.store,
    connectorEvents: { ...connectorEvents, eventRecord },
    connectorWrites: { ...connectorWrites, writeConnectorEntry },
  };
  return { ctx: { ...ctx, store }, preChecks };
}
