globalThis.fetch = async () => new Response('{"message":"Bad credentials"}', { status: 401 });
