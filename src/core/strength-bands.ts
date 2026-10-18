// The strength cut points every surface (status, MCP, dashboard) reads, so none can drift from the others.

/** An unpinned memory under this strength is at risk of fading out. */
export const AT_RISK_BELOW = 0.2;

/** A memory at or over this strength is strong; between the two cut points it is fading. */
export const STRONG_FROM = 0.5;
