// The dashboard's route shape: the /v1 rows' endpoint forms behind the one auth kind no /v1 row may take.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '../api/index.js';
import type { DashboardReader } from './dashboard-reader.js';
import type { DashboardSession } from './dashboard-session.js';
import type { RouteAuth, RouteEndpoint } from './types.js';

/** What a dashboard handler gets once the session gate has passed. */
export interface DashboardRouteRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly query: URLSearchParams;
  readonly session: DashboardSession;
  /** The api Context the cards and the writes run as: the CLI's tenant, audited as the dashboard. */
  readonly ctx: Context;
  /** The snapshot reads, answered off the server thread. */
  readonly reader: DashboardReader;
  readonly bodyDeadlineMs: number;
  /** The built React app's folder, or null when it is not built. */
  readonly staticRoot: string | null;
}

/** One dashboard row: a JSON path, or the React app's pages. */
export type DashboardRoute = {
  readonly method: string;
  readonly auth: Extract<RouteAuth, 'dashboard-session'>;
} & RouteEndpoint<DashboardRouteRequest>;
