/**
 * Hippo Dashboard — local web UI for memory health visualization.
 * Serves a single-page app with memory stats, decay curves, and conflict status.
 *
 * Usage: hippo dashboard [--port 3333]
 */

import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { loadAllEntries, listMemoryConflicts, readEntry, writeEntry } from './store.js';
import { calculateStrength, resolveConfidence, type MemoryEntry } from './memory.js';
import { loadConfig } from './config.js';
import { listPeers } from './shared.js';
import { loadEmbeddingIndex } from './embeddings.js';
import { resolveTenantId } from './tenant.js';

interface DashboardData {
  memories: Array<{
    id: string;
    content: string;
    tags: string[];
    layer: string;
    strength: number;
    half_life_days: number;
    retrieval_count: number;
    schema_fit: number;
    emotional_valence: string;
    confidence: string;
    pinned: boolean;
    created: string;
    last_retrieved: string;
    age_days: number;
    projected_strength_7d: number;
    projected_strength_30d: number;
    parents: string[];
    starred: boolean;
    conflicts_with: string[];
  }>;
  conflicts: Array<{
    id: number;
    memory_a_id: string;
    memory_b_id: string;
    reason: string;
    score: number;
    status: string;
  }>;
  stats: {
    total: number;
    pinned: number;
    errors: number;
    at_risk: number;
    avg_strength: number;
    avg_half_life: number;
    by_layer: Record<string, number>;
    by_confidence: Record<string, number>;
    embedding_coverage: number;
    open_conflicts: number;
  };
  peers: Array<{ project: string; count: number; latest: string }>;
  config: {
    defaultHalfLifeDays: number;
    defaultBudget: number;
    embeddingsEnabled: boolean | string;
  };
}

function buildDashboardData(hippoRoot: string): DashboardData {
  // A5: scope dashboard to active tenant. Without this, the UI surfaces every
  // tenant's memories on a multi-tenant deployment.
  const tenantId = resolveTenantId({});
  const entries = loadAllEntries(hippoRoot, tenantId);
  const now = new Date();
  const config = loadConfig(hippoRoot);
  // v0.28 — fetch ALL conflict statuses (open + resolved) so the UI can
  // render resolved conflicts as faded historical context, not just open
  // conflicts. The open_conflicts stat below still counts only 'open' rows
  // to preserve the existing badge meaning.
  const conflicts = listMemoryConflicts(hippoRoot, '*');
  // D4 v1.12.10: tenant-scope peer discovery in the dashboard (matches the
  // tenantId already used for loadAllEntries on line 72).
  const peers = listPeers(undefined, tenantId);
  const embeddingIndex = loadEmbeddingIndex(hippoRoot);
  const embeddedCount = Object.keys(embeddingIndex).length;

  let totalStrength = 0;
  let totalHalfLife = 0;
  let atRisk = 0;
  const byLayer: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};

  const memories = entries.map((e) => {
    const strength = calculateStrength(e, now);
    const confidence = resolveConfidence(e, now);
    const ageDays = (now.getTime() - new Date(e.created).getTime()) / (1000 * 60 * 60 * 24);

    totalStrength += strength;
    totalHalfLife += e.half_life_days;
    if (strength < 0.1 && !e.pinned) atRisk++;
    byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1;
    byConfidence[confidence] = (byConfidence[confidence] ?? 0) + 1;

    // Project strength at +7d and +30d
    const future7 = { ...e, last_retrieved: e.last_retrieved };
    const future30 = { ...e, last_retrieved: e.last_retrieved };
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const in30d = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    return {
      id: e.id,
      content: e.content,
      tags: e.tags,
      layer: e.layer,
      strength,
      half_life_days: e.half_life_days,
      retrieval_count: e.retrieval_count,
      schema_fit: e.schema_fit,
      emotional_valence: e.emotional_valence,
      confidence,
      pinned: e.pinned,
      created: e.created,
      last_retrieved: e.last_retrieved,
      age_days: Math.round(ageDays * 10) / 10,
      projected_strength_7d: calculateStrength(future7, in7d),
      projected_strength_30d: calculateStrength(future30, in30d),
      parents: e.parents ?? [],
      starred: Boolean(e.starred),
      conflicts_with: e.conflicts_with ?? [],
    };
  });

  return {
    memories,
    conflicts: conflicts.map((c) => ({
      id: c.id,
      memory_a_id: c.memory_a_id,
      memory_b_id: c.memory_b_id,
      reason: c.reason,
      score: c.score,
      status: c.status,
    })),
    stats: {
      total: entries.length,
      pinned: entries.filter((e) => e.pinned).length,
      errors: entries.filter((e) => e.tags.includes('error')).length,
      at_risk: atRisk,
      avg_strength: entries.length > 0 ? totalStrength / entries.length : 0,
      avg_half_life: entries.length > 0 ? totalHalfLife / entries.length : 0,
      by_layer: byLayer,
      by_confidence: byConfidence,
      embedding_coverage: entries.length > 0 ? embeddedCount / entries.length : 0,
      // v0.28 — open_conflicts must count only 'open' rows now that
      // `conflicts` includes all statuses. Preserves the existing badge
      // meaning (plan-eng-critic R1 must-fix #2).
      open_conflicts: conflicts.filter((c) => c.status === 'open').length,
    },
    peers,
    config: {
      defaultHalfLifeDays: config.defaultHalfLifeDays,
      defaultBudget: config.defaultBudget,
      embeddingsEnabled: config.embeddings.enabled,
    },
  };
}


const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function jsonResponse(res: http.ServerResponse, data: unknown, status: number = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function serveStaticFile(res: http.ServerResponse, filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext];
  if (!mime) return false;

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

export function serveDashboard(hippoRoot: string, port: number = 3333): http.Server {
  const distUiDir = path.resolve(import.meta.dirname, '..', 'dist-ui');
  const hasDistUi = fs.existsSync(path.join(distUiDir, 'index.html'));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // --- API routes ---
    if (pathname.startsWith('/api/')) {
      // POST /api/star/:id - toggle starred on a memory
      const starMatch = pathname.match(/^\/api\/star\/([A-Za-z0-9_\-]+)$/);
      if (starMatch && req.method === 'POST') {
        const id = starMatch[1];
        const entry = readEntry(hippoRoot, id, resolveTenantId({}));
        if (!entry) return jsonResponse(res, { error: 'Not found' }, 404);
        entry.starred = !entry.starred;
        writeEntry(hippoRoot, entry);
        return jsonResponse(res, { id, starred: entry.starred });
      }

      const data = buildDashboardData(hippoRoot);

      if (pathname === '/api/memories') return jsonResponse(res, data.memories);
      if (pathname === '/api/stats') return jsonResponse(res, data.stats);
      if (pathname === '/api/conflicts') return jsonResponse(res, data.conflicts);
      if (pathname === '/api/peers') return jsonResponse(res, data.peers);
      if (pathname === '/api/config') return jsonResponse(res, data.config);
      if (pathname === '/api/embeddings') {
        const index = loadEmbeddingIndex(hippoRoot);
        return jsonResponse(res, index);
      }

      return jsonResponse(res, { error: 'Not found' }, 404);
    }

    // --- Static file serving from dist-ui/ ---
    if (hasDistUi) {
      // Normalize and prevent path traversal
      const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(distUiDir, safePath);

      // Block traversal outside dist-ui
      if (!filePath.startsWith(distUiDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      // Try exact file
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        if (serveStaticFile(res, filePath)) return;
      }

      // SPA fallback: serve index.html for non-file routes
      const indexPath = path.join(distUiDir, 'index.html');
      if (serveStaticFile(res, indexPath)) return;
    }

    // --- SPA not built: prompt to build (the dashboardHTML SSR fallback
    // was removed in the hybrid-v4 revamp E1 since dist-ui/ is now the
    // sole UI surface). ---
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html lang="en"><head><title>Hippo Dashboard</title><meta charset="utf-8"></head>
<body style="font-family:Georgia,'Palatino Linotype',serif;max-width:640px;margin:60px auto;padding:24px;line-height:1.6;background:#f4efe6;color:#3a3228">
<h1 style="color:#c45c3c">Hippo Dashboard</h1>
<p>The React UI bundle is not built yet. Run:</p>
<pre style="background:#faf7f2;padding:16px;border:1px solid #c4b9a8;border-radius:3px;font-family:Consolas,monospace">cd ui && npm install && npm run build</pre>
<p>Then refresh this page. The dashboard server will serve <code>dist-ui/index.html</code> automatically once present.</p>
</body></html>`);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Hippo Dashboard running at http://localhost:${port}`);
    if (hasDistUi) console.log(`Serving React UI from ${distUiDir}`);
    console.log('Press Ctrl+C to stop.');
  });

  return server;
}
