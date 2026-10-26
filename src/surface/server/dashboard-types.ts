// The dashboard's route shape: the /v1 rows' endpoint forms behind the one auth kind no /v1 row may take.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ContextWith } from '../../api/types.js';
import type { OptionalGroup } from '../../base/ports/store.js';
import type { DashboardReader } from './dashboard-reader.js';
import type { DashboardSession } from './dashboard-session.js';
import type { StaticFiles } from '../dashboard/static-file.js';
import type { RouteAuth, RouteEndpoint } from './types.js';

/** The groups the Board's cards and the conflict resolve read; the dashboard proves them once, at start. */
export const DASHBOARD_GROUPS = ['cards', 'conflicts'] as const satisfies readonly OptionalGroup[];

/** The api Context every dashboard request runs as, on the store start proved. */
export type DashboardContext = ContextWith<(typeof DASHBOARD_GROUPS)[number]>;

/** What a dashboard handler gets once the session gate has passed. */
export interface DashboardRouteRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly query: URLSearchParams;
  readonly session: DashboardSession;
  /** The api Context the cards and the writes run as: the CLI's tenant, audited as the dashboard. */
  readonly ctx: DashboardContext;
  /** The dashboard reads, answered off the server thread. */
  readonly reader: DashboardReader;
  readonly bodyDeadlineMs: number;
  /** The built React app, read at start, or null when it is not built. */
  readonly staticFiles: StaticFiles | null;
}

/** One dashboard row: a JSON path, or the React app's pages. */
export type DashboardRoute = {
  readonly method: string;
  readonly auth: Extract<RouteAuth, 'dashboard-session'>;
} & RouteEndpoint<DashboardRouteRequest>;
