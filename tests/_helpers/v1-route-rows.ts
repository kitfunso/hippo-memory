import { routeLabel, V1_ROUTES } from '../../src/server/route-table.js';

/** Every live V1_ROUTES row as `METHOD label` (a regex row reads as its pattern), in dispatch order. */
export const V1_ROWS = V1_ROUTES.map((route) => ({ key: `${route.method} ${routeLabel(route)}`, route }));

/** A row key under one of the seven typed-object kinds' paths. */
export const OBJECT_ROW =
  /^\S+ \/v1\/(decisions|incidents|processes|policies|skills|project-briefs|customer-notes)(\/|$)/;
