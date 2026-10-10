// Preloaded into a spawned CLI: every fetch answers 401, so a connector's failure path runs with no network.
globalThis.fetch = async () => new Response('{"message":"Bad credentials"}', { status: 401 });
