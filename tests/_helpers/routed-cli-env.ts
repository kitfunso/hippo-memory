/** Sets that deadline past the 30 s these tests may run, so the server's answer picks the route and the probe timer never can. */
export const ROUTED_CLI_ENV = { HIPPO_HEALTH_PROBE_MS: '60000' } as const;
