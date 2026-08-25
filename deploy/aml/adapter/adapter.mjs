// deploy/aml/adapter/adapter.mjs
//
// Translating proxy in front of hippo's HTTP API. hippo speaks its own
// /v1/memories contract; the Agent Memory Leaderboard (AML) speaks a
// different one (agentmemories.ai/api-guide, read 2026-08-25). This adapter
// sits between them and does nothing else.
//
// Plain Node 22, zero npm dependencies, single file, no build step.
//
// Config (env):
//   ADAPTER_PORT  port this adapter listens on. Default 8090.
//   HIPPO_URL     base URL of the hippo HTTP server. Default http://127.0.0.1:18080.
//
// Routes:
//   GET  /health   unauthenticated. Mirrors hippo's health as {ok: boolean}.
//   POST /add      AML Add. Joins messages into one transcript, writes it as
//                  one hippo memory scoped to the caller's user_id.
//   POST /search   AML Search. Reads hippo's recall results back into AML's
//                  {data: [...]} shape, scoped to the caller's user_id.
//   anything else  404 {error}.

import { createServer } from 'node:http';

const ADAPTER_PORT = Number(process.env.ADAPTER_PORT || 8090);
const HIPPO_URL = (process.env.HIPPO_URL || 'http://127.0.0.1:18080').replace(/\/+$/, '');
const HIPPO_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 1024 * 1024;

// ---- small helpers ---------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

// Reads the request body up to maxBytes. Throws an error carrying
// statusCode 413 once the cap is crossed, and destroys the socket so the
// client is not kept waiting on a request we have already rejected.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('payload too large');
        err.statusCode = 413;
        req.destroy();
        settle(reject, err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(resolve, Buffer.concat(chunks)));
    req.on('error', (err) => settle(reject, err));
  });
}

async function parseJsonBody(req) {
  const buf = await readBody(req, MAX_BODY_BYTES);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    const err = new Error('invalid JSON body');
    err.statusCode = 400;
    throw err;
  }
}

// Client may send Authorization: Bearer <key>, Authorization: Token <key>,
// or X-Api-Key: <key>. Normalize whichever arrives into one opaque
// credential string, or undefined when none is present. Never logged.
function extractCredential(req) {
  const rawAuth = req.headers['authorization'];
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (isNonEmptyString(auth)) {
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(auth);
    if (bearerMatch) return bearerMatch[1].trim();
    const tokenMatch = /^Token\s+(.+)$/i.exec(auth);
    if (tokenMatch) return tokenMatch[1].trim();
  }
  const rawKey = req.headers['x-api-key'];
  const apiKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
  if (isNonEmptyString(apiKey)) return apiKey.trim();
  return undefined;
}

// Cloudflare stamps the real client address here at the edge; nothing else
// can reach the adapter, so the value is authoritative when present.
function clientIpOf(req) {
  const raw = req.headers['cf-connecting-ip'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return isNonEmptyString(value) ? value : undefined;
}

// Calls hippo. When credential is undefined, no Authorization header is
// sent at all, so hippo's own auth gate decides the outcome (401 when
// hippo requires auth, as the production deployment always does).
// clientIp, when present, is forwarded as cf-connecting-ip so hippo's
// per-client rate limiter keys on the real caller instead of collapsing
// every adapter-relayed request into the adapter's own address. Only the
// Cloudflare-stamped inbound value is ever forwarded; the adapter is not
// reachable except through the tunnel, so the header is trustworthy.
async function callHippo(method, path, { credential, jsonBody, clientIp } = {}) {
  const headers = { Accept: 'application/json' };
  if (jsonBody !== undefined) headers['Content-Type'] = 'application/json';
  if (credential) headers['Authorization'] = `Bearer ${credential}`;
  if (isNonEmptyString(clientIp)) headers['cf-connecting-ip'] = clientIp;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HIPPO_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${HIPPO_URL}${path}`, {
      method,
      headers,
      body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
      signal: controller.signal,
    });
    const text = await upstream.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
    }
    return { status: upstream.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function hippoErrorBody(hippoBody) {
  if (hippoBody && typeof hippoBody === 'object' && isNonEmptyString(hippoBody.error)) {
    return { error: hippoBody.error };
  }
  return { error: 'hippo request failed' };
}

// ---- /health -----------------------------------------------------------

const HEALTH_TIMEOUT_MS = 5_000;

async function handleHealth(_req, res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const upstream = await fetch(`${HIPPO_URL}/health`, { signal: controller.signal });
    const ok = upstream.status >= 200 && upstream.status < 300;
    sendJson(res, ok ? 200 : 503, { ok });
  } catch {
    sendJson(res, 503, { ok: false });
  } finally {
    clearTimeout(timer);
  }
}

// ---- /add ----------------------------------------------------------------

function validateAddBody(body) {
  if (!body || typeof body !== 'object') return 'request body must be a JSON object';
  if (!isNonEmptyString(body.request_id)) return 'request_id is required';
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return 'messages must be a non-empty array';
  }
  for (const message of body.messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      !isNonEmptyString(message.role) ||
      !isNonEmptyString(message.content)
    ) {
      return 'each message requires a role and content';
    }
  }
  if (!isNonEmptyString(body.user_id)) return 'user_id is required';
  if (!isNonEmptyString(body.session_id)) return 'session_id is required';
  return undefined;
}

function joinTranscript(messages) {
  return messages.map((message) => `${message.role}: ${message.content}`).join('\n');
}

async function handleAdd(req, res) {
  const body = await parseJsonBody(req);
  const validationError = validateAddBody(body);
  if (validationError) {
    sendJson(res, 400, { error: validationError });
    return;
  }

  const credential = extractCredential(req);
  const clientIp = clientIpOf(req);
  const transcript = joinTranscript(body.messages);
  const { status, body: hippoBody } = await callHippo('POST', '/v1/memories', {
    credential,
    clientIp,
    jsonBody: {
      content: transcript,
      scope: `aml/${body.user_id}`,
      tags: [`aml-session:${body.session_id}`],
    },
  });

  if (status !== 200) {
    sendJson(res, status, hippoErrorBody(hippoBody));
    return;
  }

  // hippo's remember() writes synchronously before returning 200, so a 200
  // here means the memory is already persisted. Echo the three ids exactly
  // as received, no re-derivation.
  sendJson(res, 200, {
    success: true,
    request_id: body.request_id,
    user_id: body.user_id,
    session_id: body.session_id,
  });
}

// ---- /search ---------------------------------------------------------

function validateSearchBody(body) {
  if (!body || typeof body !== 'object') return 'request body must be a JSON object';
  if (!isNonEmptyString(body.query)) return 'query is required';
  if (!isNonEmptyString(body.user_id)) return 'user_id is required';
  if (typeof body.top_k !== 'number' || !Number.isFinite(body.top_k) || body.top_k <= 0) {
    return 'top_k must be a positive number';
  }
  return undefined;
}

async function handleSearch(req, res) {
  const body = await parseJsonBody(req);
  const validationError = validateSearchBody(body);
  if (validationError) {
    sendJson(res, 400, { error: validationError });
    return;
  }

  const credential = extractCredential(req);
  const clientIp = clientIpOf(req);
  const topK = Math.floor(body.top_k);
  // options is accepted and ignored: hippo takes the query only.
  const params = new URLSearchParams({
    q: body.query,
    limit: String(topK),
    scope: `aml/${body.user_id}`,
  });
  const { status, body: hippoBody } = await callHippo('GET', `/v1/memories?${params.toString()}`, {
    credential,
    clientIp,
  });

  if (status !== 200) {
    sendJson(res, status, hippoErrorBody(hippoBody));
    return;
  }

  const results = Array.isArray(hippoBody.results) ? hippoBody.results : [];
  const data = results.slice(0, topK).map((row) => {
    const item = { id: row.id, content: row.content };
    if (typeof row.score === 'number') item.score = row.score;
    if (isNonEmptyString(row.created_at)) item.created_at = row.created_at;
    return item;
  });

  sendJson(res, 200, { data });
}

// ---- server ------------------------------------------------------------

const server = createServer((req, res) => {
  const start = Date.now();
  const method = req.method || 'GET';
  const path = (req.url || '/').split('?')[0];

  // One line per request, method + path + status + duration only. Never
  // credentials, never memory content.
  res.on('finish', () => {
    console.log(`${method} ${path} ${res.statusCode} ${Date.now() - start}ms`);
  });

  Promise.resolve()
    .then(async () => {
      if (method === 'GET' && path === '/health') {
        await handleHealth(req, res);
        return;
      }
      if (method === 'POST' && path === '/add') {
        await handleAdd(req, res);
        return;
      }
      if (method === 'POST' && path === '/search') {
        await handleSearch(req, res);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    })
    .catch((err) => {
      if (res.headersSent) return;
      const status = typeof err.statusCode === 'number' ? err.statusCode : 502;
      const message = typeof err.statusCode === 'number' ? err.message : 'adapter error';
      sendJson(res, status, { error: message });
    });
});

// Bound the slow-client window: Cloudflare fronts this, but a stalled body
// should not hold a connection for Node's default 300s.
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;

server.listen(ADAPTER_PORT, () => {
  // server.address().port is the actual bound port. Matters when
  // ADAPTER_PORT=0 asks the OS for an ephemeral port (tests do this).
  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : ADAPTER_PORT;
  console.log(`aml adapter listening on :${boundPort}, upstream hippo ${HIPPO_URL}`);
});
