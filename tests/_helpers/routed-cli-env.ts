// A spawned CLI routes to a running server only when its /health probe is answered before the probe deadline, 300 ms by default.
/** Sets that deadline past the 30 s these tests may run, so the server's answer picks the route and the probe timer never can. */
export const ROUTED_CLI_ENV = { HIPPO_HEALTH_PROBE_MS: '60000' } as const;
