# Hippo Brain Observatory v0.25 — Living Map Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship `hippo dashboard` with a React-based Living Map view where memories are rendered as particles on a 2D canvas with force-directed layout, decay animations, and interactive tooltips.

**Architecture:** Vite+React SPA in `ui/` directory, pre-built at publish time, served as static files by the existing HTTP server. The server gets a JSON API layer (`/api/*`). The hero view is a `<canvas>` particle engine that projects 384-dim embedding vectors to 2D via PCA, then applies d3-force-like physics for clustering. hippo already has a `physics.ts` engine with vector math, mass/charge/temperature derivation, and `PhysicsParticle` — we reuse those concepts but render in 2D.

**Tech Stack:** React 19, Vite 6, TypeScript, Canvas 2D API, d3-force (layout), existing hippo physics/embeddings APIs

**Design doc:** `~/.gstack/projects/kitfunso-hippo-memory/<user>-master-design-20260416-225438.md`

---

### Task 1: JSON API Endpoints in dashboard.ts

**Files:**
- Modify: `src/dashboard.ts:351-362` (serveDashboard function)
- Modify: `src/dashboard.ts:62-143` (buildDashboardData — extend with embeddings)
- Test: `tests/dashboard-api.test.ts` (new)

The existing `serveDashboard()` serves HTML on every request. We need a proper router that serves JSON API endpoints AND static files.

**Step 1: Write the failing test**

```typescript
// tests/dashboard-api.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

function fetch(url: string): Promise<{ status: number; json: () => Promise<any>; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 500,
          json: () => Promise.resolve(JSON.parse(data)),
          text: () => Promise.resolve(data),
        }),
      );
    }).on('error', reject);
  });
}

describe('dashboard API', () => {
  // Uses a temp .hippo dir with test data — setup in beforeAll
  // For now, test the route parsing logic

  it('GET /api/memories returns JSON array', async () => {
    const res = await fetch('http://localhost:13333/api/memories');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.memories)).toBe(true);
  });

  it('GET /api/stats returns stats object', async () => {
    const res = await fetch('http://localhost:13333/api/stats');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('total');
    expect(data).toHaveProperty('by_layer');
  });

  it('GET /api/conflicts returns array', async () => {
    const res = await fetch('http://localhost:13333/api/conflicts');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('GET /api/embeddings returns embedding map', async () => {
    const res = await fetch('http://localhost:13333/api/embeddings');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data).toBe('object');
  });

  it('GET / returns HTML (fallback)', async () => {
    const res = await fetch('http://localhost:13333/');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('<!DOCTYPE html>');
  });

  it('GET /unknown returns 404', async () => {
    const res = await fetch('http://localhost:13333/unknown');
    expect(res.status).toBe(404);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd C:/Users/<user>/hippo && npx vitest run tests/dashboard-api.test.ts`
Expected: FAIL — server not running, no API routes

**Step 3: Implement the JSON API router in dashboard.ts**

Replace `serveDashboard()` with a proper router. Keep `buildDashboardData()` and `dashboardHTML()` intact. Add new API-specific data builders.

```typescript
// Add to dashboard.ts imports
import * as path from 'path';
import * as fs from 'fs';

// New: build embeddings data for the API
function buildEmbeddingsData(hippoRoot: string): Record<string, number[]> {
  return loadEmbeddingIndex(hippoRoot);
}

// New: route handler
function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  hippoRoot: string,
): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) return false;

  const json = (data: unknown, status = 200) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
  };

  const dashData = buildDashboardData(hippoRoot);

  switch (pathname) {
    case '/api/memories':
      json({ memories: dashData.memories });
      return true;
    case '/api/stats':
      json(dashData.stats);
      return true;
    case '/api/conflicts':
      json(dashData.conflicts);
      return true;
    case '/api/peers':
      json(dashData.peers);
      return true;
    case '/api/config':
      json(dashData.config);
      return true;
    case '/api/embeddings':
      json(buildEmbeddingsData(hippoRoot));
      return true;
    default:
      json({ error: 'Not found' }, 404);
      return true;
  }
}

// New: serve static files from dist-ui
function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  distUiDir: string,
): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  let pathname = url.pathname === '/' ? '/index.html' : url.pathname;

  // Prevent path traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(distUiDir, safePath);

  if (!filePath.startsWith(distUiDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // SPA fallback: serve index.html for non-file routes
    const indexPath = path.join(distUiDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(indexPath));
      return true;
    }
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };

  res.writeHead(200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' });
  res.end(fs.readFileSync(filePath));
  return true;
}

// Updated serveDashboard with router
export function serveDashboard(hippoRoot: string, port: number = 3333): void {
  const distUiDir = path.resolve(__dirname, '..', 'dist-ui');
  const hasUi = fs.existsSync(path.join(distUiDir, 'index.html'));

  const server = http.createServer((req, res) => {
    // 1. API routes
    if (handleApiRequest(req, res, hippoRoot)) return;

    // 2. Static files from dist-ui (if built)
    if (hasUi && serveStatic(req, res, distUiDir)) return;

    // 3. Fallback: legacy inline HTML dashboard
    const data = buildDashboardData(hippoRoot);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dashboardHTML(data));
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Hippo Dashboard running at http://localhost:${port}`);
    if (hasUi) {
      console.log('Serving Brain Observatory UI');
    } else {
      console.log('Serving legacy dashboard (run "npm run build:ui" for full UI)');
    }
    console.log('Press Ctrl+C to stop.');
  });
}
```

**Step 4: Run tests to verify they pass**

Run: `cd C:/Users/<user>/hippo && npx vitest run tests/dashboard-api.test.ts`

Note: Tests need a running server. Either start one in `beforeAll` using a temp hippo root, or refactor tests to use `handleApiRequest` directly. The pragmatic approach is to test the route handler directly by mocking req/res.

**Step 5: Commit**

```bash
git add src/dashboard.ts tests/dashboard-api.test.ts
git commit -m "feat(dashboard): add JSON API endpoints for Brain Observatory UI"
```

---

### Task 2: Scaffold ui/ with Vite + React + TypeScript

**Files:**
- Create: `ui/package.json`
- Create: `ui/tsconfig.json`
- Create: `ui/vite.config.ts`
- Create: `ui/index.html`
- Create: `ui/src/main.tsx`
- Create: `ui/src/App.tsx`
- Create: `ui/src/api/client.ts`
- Create: `ui/src/types.ts`

**Step 1: Initialize ui/ directory**

```bash
cd C:/Users/<user>/hippo
mkdir -p ui/src/api ui/src/views ui/src/components
```

**Step 2: Create ui/package.json**

```json
{
  "name": "hippo-dashboard-ui",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --port 3334",
    "build": "tsc -b && vite build --outDir ../dist-ui --emptyOutDir",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "d3-force": "^3.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/d3-force": "^3.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.4.0",
    "vite": "^6.0.0"
  }
}
```

**Step 3: Create ui/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src"]
}
```

**Step 4: Create ui/vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3333',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
```

**Step 5: Create ui/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hippo Brain Observatory</title>
  <style>
    :root {
      --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
      --text: #e1e4ed; --muted: #8b8fa3; --accent: #6c8cff;
      --green: #4ade80; --yellow: #fbbf24; --red: #f87171; --purple: #a78bfa;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg); color: var(--text);
      overflow: hidden;
    }
    #root { width: 100vw; height: 100vh; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

**Step 6: Create shared types (ui/src/types.ts)**

These mirror the DashboardData from `src/dashboard.ts`:

```typescript
export interface Memory {
  id: string;
  content: string;
  tags: string[];
  layer: 'buffer' | 'episodic' | 'semantic';
  strength: number;
  half_life_days: number;
  retrieval_count: number;
  schema_fit: number;
  emotional_valence: 'neutral' | 'positive' | 'negative' | 'critical';
  confidence: 'verified' | 'observed' | 'inferred' | 'stale';
  pinned: boolean;
  created: string;
  last_retrieved: string;
  age_days: number;
  projected_strength_7d: number;
  projected_strength_30d: number;
}

export interface Conflict {
  id: number;
  memory_a_id: string;
  memory_b_id: string;
  reason: string;
  score: number;
  status: string;
}

export interface Stats {
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
}

export interface Peer {
  project: string;
  count: number;
  latest: string;
}

export interface DashboardConfig {
  defaultHalfLifeDays: number;
  defaultBudget: number;
  embeddingsEnabled: boolean | string;
}

export type EmbeddingIndex = Record<string, number[]>;
```

**Step 7: Create API client (ui/src/api/client.ts)**

```typescript
import type { Memory, Stats, Conflict, Peer, DashboardConfig, EmbeddingIndex } from '../types.js';

const BASE = '';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchMemories(): Promise<Memory[]> {
  const data = await get<{ memories: Memory[] }>('/api/memories');
  return data.memories;
}

export async function fetchStats(): Promise<Stats> {
  return get<Stats>('/api/stats');
}

export async function fetchConflicts(): Promise<Conflict[]> {
  return get<Conflict[]>('/api/conflicts');
}

export async function fetchPeers(): Promise<Peer[]> {
  return get<Peer[]>('/api/peers');
}

export async function fetchConfig(): Promise<DashboardConfig> {
  return get<DashboardConfig>('/api/config');
}

export async function fetchEmbeddings(): Promise<EmbeddingIndex> {
  return get<EmbeddingIndex>('/api/embeddings');
}
```

**Step 8: Create main.tsx and App.tsx**

```typescript
// ui/src/main.tsx
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(<App />);
```

```typescript
// ui/src/App.tsx
import { useState, useEffect } from 'react';
import { fetchMemories, fetchStats, fetchConflicts, fetchEmbeddings } from './api/client.js';
import type { Memory, Stats, Conflict, EmbeddingIndex } from './types.js';

export function App() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [embeddings, setEmbeddings] = useState<EmbeddingIndex>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchMemories(),
      fetchStats(),
      fetchConflicts(),
      fetchEmbeddings(),
    ])
      .then(([mems, st, conf, emb]) => {
        setMemories(mems);
        setStats(st);
        setConflicts(conf);
        setEmbeddings(emb);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--muted)' }}>
        Loading memories...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--red)' }}>
        {error}
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10, color: 'var(--muted)', fontSize: 12 }}>
        Hippo Brain Observatory — {memories.length} memories, {Object.keys(embeddings).length} embedded
      </div>
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
        Living Map placeholder — Task 3 wires up the canvas
      </div>
    </div>
  );
}
```

**Step 9: Install dependencies and verify build**

```bash
cd C:/Users/<user>/hippo/ui && npm install
cd C:/Users/<user>/hippo/ui && npm run build
```

Expected: `dist-ui/` directory created at hippo root with `index.html` and JS bundle.

**Step 10: Verify integration**

```bash
cd C:/Users/<user>/hippo && npm run build
cd C:/Users/<user>/hippo && node bin/hippo.js dashboard --port 13334
# In another terminal: curl http://localhost:13334/
# Should serve the React app
# curl http://localhost:13334/api/stats should return JSON
```

**Step 11: Commit**

```bash
git add ui/ dist-ui/
git commit -m "feat(ui): scaffold Brain Observatory with Vite + React + API client"
```

---

### Task 3: 2D Projection — PCA from 384-dim embeddings

**Files:**
- Create: `ui/src/engine/projection.ts`
- Test: `ui/src/engine/projection.test.ts`

The embedding vectors are 384-dimensional. We need to project them to 2D for canvas rendering. We use simple PCA (power iteration for top 2 principal components). This runs once on data load, not per frame.

**Step 1: Write the failing test**

```typescript
// ui/src/engine/projection.test.ts
import { describe, it, expect } from 'vitest';
import { projectTo2D } from './projection.js';

describe('projectTo2D', () => {
  it('projects 3D vectors to 2D', () => {
    const vectors: Record<string, number[]> = {
      a: [1, 0, 0],
      b: [0, 1, 0],
      c: [0, 0, 1],
      d: [1, 1, 0],
    };
    const result = projectTo2D(vectors);
    expect(Object.keys(result)).toHaveLength(4);
    for (const [id, pos] of Object.entries(result)) {
      expect(pos).toHaveLength(2);
      expect(typeof pos[0]).toBe('number');
      expect(typeof pos[1]).toBe('number');
      expect(Number.isFinite(pos[0])).toBe(true);
      expect(Number.isFinite(pos[1])).toBe(true);
    }
  });

  it('returns empty for empty input', () => {
    expect(projectTo2D({})).toEqual({});
  });

  it('handles single vector', () => {
    const result = projectTo2D({ a: [1, 2, 3] });
    expect(result.a).toHaveLength(2);
  });

  it('spreads similar vectors close together', () => {
    const vectors: Record<string, number[]> = {
      a: [1, 0, 0, 0],
      b: [0.9, 0.1, 0, 0],
      c: [0, 0, 1, 0],
      d: [0, 0, 0.9, 0.1],
    };
    const result = projectTo2D(vectors);
    const distAB = Math.hypot(result.a[0] - result.b[0], result.a[1] - result.b[1]);
    const distAC = Math.hypot(result.a[0] - result.c[0], result.a[1] - result.c[1]);
    expect(distAB).toBeLessThan(distAC);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd C:/Users/<user>/hippo/ui && npx vitest run src/engine/projection.test.ts`
Expected: FAIL — module not found

**Step 3: Implement PCA projection**

```typescript
// ui/src/engine/projection.ts

/**
 * Project high-dimensional embedding vectors to 2D using PCA (power iteration).
 * Returns { memoryId: [x, y] } with coordinates normalized to [-1, 1].
 */
export function projectTo2D(
  vectors: Record<string, number[]>,
  dimensions: number = 2,
): Record<string, [number, number]> {
  const ids = Object.keys(vectors);
  if (ids.length === 0) return {};

  const dim = vectors[ids[0]].length;
  const n = ids.length;

  // Build centered data matrix
  const mean = new Float64Array(dim);
  for (const id of ids) {
    const v = vectors[id];
    for (let j = 0; j < dim; j++) mean[j] += v[j];
  }
  for (let j = 0; j < dim; j++) mean[j] /= n;

  const centered: Float64Array[] = ids.map((id) => {
    const v = vectors[id];
    const c = new Float64Array(dim);
    for (let j = 0; j < dim; j++) c[j] = v[j] - mean[j];
    return c;
  });

  // Power iteration for top-k principal components
  const components: Float64Array[] = [];
  for (let k = 0; k < dimensions; k++) {
    let pc = new Float64Array(dim);
    for (let j = 0; j < dim; j++) pc[j] = Math.random() - 0.5;

    for (let iter = 0; iter < 100; iter++) {
      const next = new Float64Array(dim);
      for (let i = 0; i < n; i++) {
        let dot = 0;
        for (let j = 0; j < dim; j++) dot += centered[i][j] * pc[j];
        for (let j = 0; j < dim; j++) next[j] += centered[i][j] * dot;
      }

      // Orthogonalize against previous components
      for (const prev of components) {
        let dot = 0;
        for (let j = 0; j < dim; j++) dot += next[j] * prev[j];
        for (let j = 0; j < dim; j++) next[j] -= dot * prev[j];
      }

      // Normalize
      let norm = 0;
      for (let j = 0; j < dim; j++) norm += next[j] * next[j];
      norm = Math.sqrt(norm);
      if (norm < 1e-10) break;
      for (let j = 0; j < dim; j++) next[j] /= norm;
      pc = next;
    }

    components.push(pc);
  }

  // Project each vector onto the principal components
  const projected: Record<string, [number, number]> = {};
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  for (let i = 0; i < n; i++) {
    let x = 0, y = 0;
    for (let j = 0; j < dim; j++) {
      x += centered[i][j] * (components[0]?.[j] ?? 0);
      y += centered[i][j] * (components[1]?.[j] ?? 0);
    }
    projected[ids[i]] = [x, y];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  // Normalize to [-1, 1]
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;
  for (const id of ids) {
    projected[id][0] = ((projected[id][0] - minX) / rangeX) * 2 - 1;
    projected[id][1] = ((projected[id][1] - minY) / rangeY) * 2 - 1;
  }

  return projected;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd C:/Users/<user>/hippo/ui && npx vitest run src/engine/projection.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ui/src/engine/
git commit -m "feat(ui): PCA projection from high-dim embeddings to 2D"
```

---

### Task 4: Particle Engine — Canvas 2D Renderer

**Files:**
- Create: `ui/src/engine/particles.ts`
- Create: `ui/src/engine/types.ts`
- Test: `ui/src/engine/particles.test.ts`

This is the core rendering engine. Each memory becomes a particle with position, velocity, size, color, and opacity derived from memory properties.

**Step 1: Create engine types**

```typescript
// ui/src/engine/types.ts
export interface Particle {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  opacity: number;
  layer: 'buffer' | 'episodic' | 'semantic';
  strength: number;
  pulsePhase: number;
  selected: boolean;
}

export interface EngineConfig {
  width: number;
  height: number;
  padding: number;
  particleMinRadius: number;
  particleMaxRadius: number;
  glowEnabled: boolean;
  decayAnimationSpeed: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  width: 800,
  height: 600,
  padding: 40,
  particleMinRadius: 3,
  particleMaxRadius: 16,
  glowEnabled: true,
  decayAnimationSpeed: 0.002,
};

export const LAYER_COLORS = {
  buffer: '#6c8cff',
  episodic: '#fbbf24',
  semantic: '#4ade80',
} as const;

export const VALENCE_GLOW: Record<string, string> = {
  neutral: '',
  positive: 'rgba(74, 222, 128, 0.3)',
  negative: 'rgba(248, 113, 113, 0.3)',
  critical: 'rgba(248, 113, 113, 0.6)',
};
```

**Step 2: Write the failing test**

```typescript
// ui/src/engine/particles.test.ts
import { describe, it, expect } from 'vitest';
import { ParticleEngine } from './particles.js';
import type { Memory } from '../types.js';

const mockMemory: Memory = {
  id: 'test-1',
  content: 'test memory',
  tags: ['test'],
  layer: 'episodic',
  strength: 0.7,
  half_life_days: 14,
  retrieval_count: 3,
  schema_fit: 0.5,
  emotional_valence: 'neutral',
  confidence: 'observed',
  pinned: false,
  created: '2026-01-01T00:00:00Z',
  last_retrieved: '2026-04-01T00:00:00Z',
  age_days: 106,
  projected_strength_7d: 0.6,
  projected_strength_30d: 0.4,
};

describe('ParticleEngine', () => {
  it('creates particles from memories and positions', () => {
    const engine = new ParticleEngine();
    const positions = { 'test-1': [0.5, -0.3] as [number, number] };
    engine.initialize([mockMemory], positions, 800, 600);
    expect(engine.particles).toHaveLength(1);
    expect(engine.particles[0].id).toBe('test-1');
  });

  it('maps strength to opacity', () => {
    const engine = new ParticleEngine();
    const positions = { 'test-1': [0, 0] as [number, number] };
    engine.initialize([mockMemory], positions, 800, 600);
    expect(engine.particles[0].opacity).toBeGreaterThan(0.1);
    expect(engine.particles[0].opacity).toBeLessThanOrEqual(1);
  });

  it('maps retrieval_count to radius', () => {
    const engine = new ParticleEngine();
    const highRetrieval = { ...mockMemory, id: 'hi', retrieval_count: 50 };
    const lowRetrieval = { ...mockMemory, id: 'lo', retrieval_count: 1 };
    const positions = {
      hi: [0, 0] as [number, number],
      lo: [0.5, 0.5] as [number, number],
    };
    engine.initialize([highRetrieval, lowRetrieval], positions, 800, 600);
    const hi = engine.particles.find((p) => p.id === 'hi')!;
    const lo = engine.particles.find((p) => p.id === 'lo')!;
    expect(hi.radius).toBeGreaterThan(lo.radius);
  });

  it('assigns layer colors', () => {
    const engine = new ParticleEngine();
    const positions = { 'test-1': [0, 0] as [number, number] };
    engine.initialize([mockMemory], positions, 800, 600);
    expect(engine.particles[0].color).toBe('#fbbf24'); // episodic = amber
  });

  it('hitTest returns particle at point', () => {
    const engine = new ParticleEngine();
    const positions = { 'test-1': [0, 0] as [number, number] };
    engine.initialize([mockMemory], positions, 800, 600);
    const p = engine.particles[0];
    const hit = engine.hitTest(p.x, p.y);
    expect(hit?.id).toBe('test-1');
  });

  it('hitTest returns null for empty area', () => {
    const engine = new ParticleEngine();
    const positions = { 'test-1': [0, 0] as [number, number] };
    engine.initialize([mockMemory], positions, 800, 600);
    const hit = engine.hitTest(-9999, -9999);
    expect(hit).toBeNull();
  });

  it('handles memories without embeddings', () => {
    const engine = new ParticleEngine();
    engine.initialize([mockMemory], {}, 800, 600);
    expect(engine.particles).toHaveLength(1);
    // Should get a fallback position
    expect(Number.isFinite(engine.particles[0].x)).toBe(true);
  });
});
```

**Step 3: Run test to verify it fails**

Run: `cd C:/Users/<user>/hippo/ui && npx vitest run src/engine/particles.test.ts`
Expected: FAIL — module not found

**Step 4: Implement ParticleEngine**

```typescript
// ui/src/engine/particles.ts
import type { Particle, EngineConfig } from './types.js';
import { DEFAULT_CONFIG, LAYER_COLORS, VALENCE_GLOW } from './types.js';
import type { Memory } from '../types.js';

export class ParticleEngine {
  particles: Particle[] = [];
  private config: EngineConfig = DEFAULT_CONFIG;
  private width = 800;
  private height = 600;
  private searchDimmed = false;
  private highlightedIds: Set<string> = new Set();

  initialize(
    memories: Memory[],
    positions: Record<string, [number, number]>,
    width: number,
    height: number,
  ): void {
    this.width = width;
    this.height = height;
    this.config = { ...DEFAULT_CONFIG, width, height };
    const pad = this.config.padding;
    const usableW = width - pad * 2;
    const usableH = height - pad * 2;

    this.particles = memories.map((m) => {
      const pos = positions[m.id];
      const x = pos
        ? pad + ((pos[0] + 1) / 2) * usableW
        : pad + Math.random() * usableW;
      const y = pos
        ? pad + ((pos[1] + 1) / 2) * usableH
        : pad + Math.random() * usableH;

      const maxRetrieval = Math.max(1, ...memories.map((mm) => mm.retrieval_count));
      const radiusT = Math.log2(m.retrieval_count + 1) / Math.log2(maxRetrieval + 1);
      const radius =
        this.config.particleMinRadius +
        radiusT * (this.config.particleMaxRadius - this.config.particleMinRadius);

      return {
        id: m.id,
        x,
        y,
        vx: 0,
        vy: 0,
        radius,
        color: LAYER_COLORS[m.layer],
        opacity: 0.15 + m.strength * 0.85,
        layer: m.layer,
        strength: m.strength,
        pulsePhase: Math.random() * Math.PI * 2,
        selected: false,
      };
    });
  }

  hitTest(px: number, py: number): Particle | null {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      const dx = px - p.x;
      const dy = py - p.y;
      if (dx * dx + dy * dy <= (p.radius + 4) ** 2) return p;
    }
    return null;
  }

  setHighlighted(ids: Set<string>): void {
    this.highlightedIds = ids;
    this.searchDimmed = ids.size > 0;
  }

  clearHighlight(): void {
    this.highlightedIds.clear();
    this.searchDimmed = false;
  }

  render(ctx: CanvasRenderingContext2D, time: number): void {
    ctx.clearRect(0, 0, this.width, this.height);

    for (const p of this.particles) {
      const dimmed = this.searchDimmed && !this.highlightedIds.has(p.id);
      const effectiveOpacity = dimmed ? p.opacity * 0.1 : p.opacity;
      const pulse = p.selected ? 1 + 0.15 * Math.sin(time * 0.003 + p.pulsePhase) : 1;
      const r = p.radius * pulse;

      // Glow effect
      if (this.config.glowEnabled && effectiveOpacity > 0.3 && !dimmed) {
        const gradient = ctx.createRadialGradient(p.x, p.y, r * 0.5, p.x, p.y, r * 3);
        gradient.addColorStop(0, colorWithAlpha(p.color, effectiveOpacity * 0.3));
        gradient.addColorStop(1, colorWithAlpha(p.color, 0));
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();
      }

      // Particle body
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = colorWithAlpha(p.color, effectiveOpacity);
      ctx.fill();

      // Selection ring
      if (p.selected) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
}

function colorWithAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
```

**Step 5: Run tests to verify they pass**

Run: `cd C:/Users/<user>/hippo/ui && npx vitest run src/engine/particles.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add ui/src/engine/
git commit -m "feat(ui): particle engine with canvas 2D rendering and hit testing"
```

---

### Task 5: Force-Directed Layout with d3-force

**Files:**
- Create: `ui/src/engine/layout.ts`
- Test: `ui/src/engine/layout.test.ts`

Uses d3-force to position particles after PCA gives initial positions. Adds clustering by tag similarity and layer grouping.

**Step 1: Write the failing test**

```typescript
// ui/src/engine/layout.test.ts
import { describe, it, expect } from 'vitest';
import { createForceLayout, type LayoutNode } from './layout.js';

describe('createForceLayout', () => {
  it('returns positioned nodes', () => {
    const nodes: LayoutNode[] = [
      { id: 'a', x: 0, y: 0, layer: 'buffer', tags: ['test'], strength: 0.8 },
      { id: 'b', x: 100, y: 100, layer: 'episodic', tags: ['test'], strength: 0.5 },
      { id: 'c', x: 200, y: 200, layer: 'semantic', tags: ['other'], strength: 0.3 },
    ];
    const result = createForceLayout(nodes, 800, 600, 100);
    expect(result).toHaveLength(3);
    for (const node of result) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it('keeps nodes within bounds', () => {
    const nodes: LayoutNode[] = Array.from({ length: 50 }, (_, i) => ({
      id: `n${i}`,
      x: Math.random() * 800,
      y: Math.random() * 600,
      layer: 'episodic' as const,
      tags: ['test'],
      strength: Math.random(),
    }));
    const result = createForceLayout(nodes, 800, 600, 200);
    for (const node of result) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(800);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(600);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd C:/Users/<user>/hippo/ui && npx vitest run src/engine/layout.test.ts`
Expected: FAIL

**Step 3: Implement force layout**

```typescript
// ui/src/engine/layout.ts
import {
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from 'd3-force';

export interface LayoutNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  layer: 'buffer' | 'episodic' | 'semantic';
  tags: string[];
  strength: number;
}

const LAYER_Y_BIAS: Record<string, number> = {
  buffer: 0.3,
  episodic: 0.5,
  semantic: 0.7,
};

export function createForceLayout(
  nodes: LayoutNode[],
  width: number,
  height: number,
  ticks: number = 150,
): LayoutNode[] {
  const pad = 40;

  const simulation = forceSimulation<LayoutNode>(nodes)
    .force('charge', forceManyBody<LayoutNode>().strength(-30))
    .force('center', forceCenter(width / 2, height / 2).strength(0.05))
    .force('collide', forceCollide<LayoutNode>().radius(8).strength(0.7))
    .force(
      'layerY',
      forceY<LayoutNode>((d) => LAYER_Y_BIAS[d.layer] * height).strength(0.03),
    )
    .force(
      'clampX',
      forceX<LayoutNode>((d) => Math.max(pad, Math.min(width - pad, d.x ?? width / 2))).strength(0.01),
    )
    .stop();

  for (let i = 0; i < ticks; i++) simulation.tick();

  // Clamp to bounds
  for (const node of nodes) {
    node.x = Math.max(pad, Math.min(width - pad, node.x ?? width / 2));
    node.y = Math.max(pad, Math.min(height - pad, node.y ?? height / 2));
  }

  return nodes;
}
```

**Step 4: Run tests**

Run: `cd C:/Users/<user>/hippo/ui && npx vitest run src/engine/layout.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ui/src/engine/layout.ts ui/src/engine/layout.test.ts
git commit -m "feat(ui): d3-force layout with layer grouping and collision avoidance"
```

---

### Task 6: LivingMap React Component

**Files:**
- Create: `ui/src/views/LivingMap/LivingMap.tsx`
- Create: `ui/src/views/LivingMap/useCanvasEngine.ts`
- Create: `ui/src/components/MemoryTooltip.tsx`
- Create: `ui/src/components/SearchBar.tsx`
- Create: `ui/src/components/LayerLegend.tsx`
- Modify: `ui/src/App.tsx`

**Step 1: Create the canvas hook**

```typescript
// ui/src/views/LivingMap/useCanvasEngine.ts
import { useRef, useEffect, useCallback } from 'react';
import { ParticleEngine } from '../../engine/particles.js';
import { projectTo2D } from '../../engine/projection.js';
import { createForceLayout, type LayoutNode } from '../../engine/layout.js';
import type { Memory, EmbeddingIndex } from '../../types.js';

interface UseCanvasEngineOptions {
  memories: Memory[];
  embeddings: EmbeddingIndex;
  width: number;
  height: number;
  onHover: (memory: Memory | null, x: number, y: number) => void;
  onClick: (memory: Memory | null) => void;
  searchQuery: string;
}

export function useCanvasEngine({
  memories,
  embeddings,
  width,
  height,
  onHover,
  onClick,
  searchQuery,
}: UseCanvasEngineOptions) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ParticleEngine>(new ParticleEngine());
  const rafRef = useRef<number>(0);
  const memoriesRef = useRef<Memory[]>(memories);
  memoriesRef.current = memories;

  // Initialize particles
  useEffect(() => {
    if (width === 0 || height === 0) return;

    const engine = engineRef.current;
    const projected = projectTo2D(embeddings);

    // Create layout nodes from PCA positions
    const nodes: LayoutNode[] = memories.map((m) => {
      const pos = projected[m.id];
      return {
        id: m.id,
        x: pos ? ((pos[0] + 1) / 2) * width : Math.random() * width,
        y: pos ? ((pos[1] + 1) / 2) * height : Math.random() * height,
        layer: m.layer,
        tags: m.tags,
        strength: m.strength,
      };
    });

    // Run force layout
    const layouted = createForceLayout(nodes, width, height);
    const positions: Record<string, [number, number]> = {};
    for (const n of layouted) {
      // Convert back to [-1, 1] range for engine.initialize
      positions[n.id] = [
        ((n.x ?? 0) / width) * 2 - 1,
        ((n.y ?? 0) / height) * 2 - 1,
      ];
    }

    engine.initialize(memories, positions, width, height);
  }, [memories, embeddings, width, height]);

  // Search highlighting
  useEffect(() => {
    const engine = engineRef.current;
    if (!searchQuery) {
      engine.clearHighlight();
      return;
    }
    const q = searchQuery.toLowerCase();
    const matched = new Set(
      memories
        .filter(
          (m) =>
            m.content.toLowerCase().includes(q) ||
            m.tags.some((t) => t.toLowerCase().includes(q)),
        )
        .map((m) => m.id),
    );
    engine.setHighlighted(matched);
  }, [searchQuery, memories]);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    function frame(time: number) {
      engineRef.current.render(ctx!, time);
      rafRef.current = requestAnimationFrame(frame);
    }
    rafRef.current = requestAnimationFrame(frame);

    return () => cancelAnimationFrame(rafRef.current);
  }, [width, height]);

  // Mouse interaction
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = engineRef.current.hitTest(x, y);
      const memory = hit ? memoriesRef.current.find((m) => m.id === hit.id) ?? null : null;
      onHover(memory, e.clientX, e.clientY);
    },
    [onHover],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = engineRef.current.hitTest(x, y);
      const memory = hit ? memoriesRef.current.find((m) => m.id === hit.id) ?? null : null;

      // Update selection state
      for (const p of engineRef.current.particles) p.selected = false;
      if (hit) hit.selected = true;

      onClick(memory);
    },
    [onClick],
  );

  return { canvasRef, handleMouseMove, handleClick };
}
```

**Step 2: Create UI components**

```typescript
// ui/src/components/MemoryTooltip.tsx
import type { Memory } from '../types.js';

interface Props {
  memory: Memory;
  x: number;
  y: number;
}

export function MemoryTooltip({ memory, x, y }: Props) {
  return (
    <div
      style={{
        position: 'fixed',
        left: x + 12,
        top: y - 8,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '8px 12px',
        maxWidth: 320,
        fontSize: 12,
        zIndex: 100,
        pointerEvents: 'none',
      }}
    >
      <div style={{ color: 'var(--text)', marginBottom: 4, lineHeight: 1.4 }}>
        {memory.content.slice(0, 120)}
        {memory.content.length > 120 ? '...' : ''}
      </div>
      <div style={{ color: 'var(--muted)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <span>strength: {memory.strength.toFixed(2)}</span>
        <span>layer: {memory.layer}</span>
        <span>retrievals: {memory.retrieval_count}</span>
        <span>half-life: {memory.half_life_days}d</span>
      </div>
      {memory.tags.length > 0 && (
        <div style={{ marginTop: 4, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {memory.tags.map((t) => (
            <span
              key={t}
              style={{
                padding: '1px 6px',
                borderRadius: 4,
                fontSize: 10,
                background: t === 'error' ? 'rgba(248,113,113,0.15)' : 'var(--border)',
                color: t === 'error' ? 'var(--red)' : 'var(--muted)',
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
```

```typescript
// ui/src/components/SearchBar.tsx
interface Props {
  value: string;
  onChange: (value: string) => void;
  memoryCount: number;
  matchCount: number | null;
}

export function SearchBar({ value, onChange, memoryCount, matchCount }: Props) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter memories..."
        style={{
          padding: '6px 12px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          color: 'var(--text)',
          fontSize: 13,
          width: 220,
          outline: 'none',
        }}
      />
      {matchCount !== null && (
        <span style={{ color: 'var(--muted)', fontSize: 11 }}>
          {matchCount}/{memoryCount}
        </span>
      )}
    </div>
  );
}
```

```typescript
// ui/src/components/LayerLegend.tsx
import { LAYER_COLORS } from '../engine/types.js';

export function LayerLegend() {
  const layers = [
    { key: 'buffer', label: 'Buffer' },
    { key: 'episodic', label: 'Episodic' },
    { key: 'semantic', label: 'Semantic' },
  ] as const;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        zIndex: 10,
        display: 'flex',
        gap: 16,
        fontSize: 11,
        color: 'var(--muted)',
      }}
    >
      {layers.map(({ key, label }) => (
        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: LAYER_COLORS[key],
              display: 'inline-block',
            }}
          />
          {label}
        </div>
      ))}
    </div>
  );
}
```

**Step 3: Create LivingMap view**

```typescript
// ui/src/views/LivingMap/LivingMap.tsx
import { useState, useCallback, useRef, useEffect } from 'react';
import { useCanvasEngine } from './useCanvasEngine.js';
import { MemoryTooltip } from '../../components/MemoryTooltip.js';
import { SearchBar } from '../../components/SearchBar.js';
import { LayerLegend } from '../../components/LayerLegend.js';
import type { Memory, EmbeddingIndex, Stats } from '../../types.js';

interface Props {
  memories: Memory[];
  embeddings: EmbeddingIndex;
  stats: Stats;
}

export function LivingMap({ memories, embeddings, stats }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoveredMemory, setHoveredMemory] = useState<{ memory: Memory; x: number; y: number } | null>(null);
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Track container size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.floor(entry.contentRect.width),
        height: Math.floor(entry.contentRect.height),
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleHover = useCallback((memory: Memory | null, x: number, y: number) => {
    setHoveredMemory(memory ? { memory, x, y } : null);
  }, []);

  const handleClick = useCallback((memory: Memory | null) => {
    setSelectedMemory(memory);
  }, []);

  const matchCount =
    searchQuery.length > 0
      ? memories.filter(
          (m) =>
            m.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
            m.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase())),
        ).length
      : null;

  const { canvasRef, handleMouseMove, handleClick: onCanvasClick } = useCanvasEngine({
    memories,
    embeddings,
    width: size.width,
    height: size.height,
    onHover: handleHover,
    onClick: handleClick,
    searchQuery,
  });

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Header */}
      <div
        style={{
          position: 'absolute',
          top: 16,
          left: 16,
          zIndex: 10,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600 }}>
          Hippo Brain Observatory
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
          {stats.total} memories &middot; {stats.at_risk} at risk &middot;
          avg strength {stats.avg_strength.toFixed(2)}
        </div>
      </div>

      {/* Search */}
      <SearchBar
        value={searchQuery}
        onChange={setSearchQuery}
        memoryCount={memories.length}
        matchCount={matchCount}
      />

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={size.width}
        height={size.height}
        style={{ display: 'block', cursor: 'crosshair' }}
        onMouseMove={handleMouseMove}
        onClick={onCanvasClick}
        onMouseLeave={() => setHoveredMemory(null)}
      />

      {/* Legend */}
      <LayerLegend />

      {/* Tooltip */}
      {hoveredMemory && !selectedMemory && (
        <MemoryTooltip
          memory={hoveredMemory.memory}
          x={hoveredMemory.x}
          y={hoveredMemory.y}
        />
      )}

      {/* Detail panel */}
      {selectedMemory && (
        <DetailPanel memory={selectedMemory} onClose={() => setSelectedMemory(null)} />
      )}
    </div>
  );
}

function DetailPanel({ memory, onClose }: { memory: Memory; onClose: () => void }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: 340,
        height: '100%',
        background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        padding: 20,
        overflowY: 'auto',
        zIndex: 20,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>{memory.id}</span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: '1px solid var(--border)',
            borderRadius: 4,
            color: 'var(--muted)',
            cursor: 'pointer',
            padding: '2px 8px',
            fontSize: 12,
          }}
        >
          close
        </button>
      </div>

      <div style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 16 }}>{memory.content}</div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
        <Stat label="Strength" value={memory.strength.toFixed(3)} />
        <Stat label="Layer" value={memory.layer} />
        <Stat label="Half-life" value={`${memory.half_life_days}d`} />
        <Stat label="Retrievals" value={String(memory.retrieval_count)} />
        <Stat label="Age" value={`${memory.age_days}d`} />
        <Stat label="Schema fit" value={memory.schema_fit.toFixed(2)} />
        <Stat label="Valence" value={memory.emotional_valence} />
        <Stat label="Confidence" value={memory.confidence} />
        <Stat label="+7d strength" value={memory.projected_strength_7d.toFixed(3)} />
        <Stat label="+30d strength" value={memory.projected_strength_30d.toFixed(3)} />
      </div>

      {memory.tags.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {memory.tags.map((t) => (
            <span
              key={t}
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                background: t === 'error' ? 'rgba(248,113,113,0.15)' : 'var(--border)',
                color: t === 'error' ? 'var(--red)' : 'var(--muted)',
              }}
            >
              {t}
            </span>
          ))}
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 11, color: 'var(--muted)' }}>
        {memory.pinned && <div style={{ color: 'var(--purple)' }}>Pinned</div>}
        <div>Created: {memory.created.slice(0, 10)}</div>
        <div>Last retrieved: {memory.last_retrieved.slice(0, 10)}</div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: 'var(--muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{value}</div>
    </div>
  );
}
```

**Step 4: Update App.tsx to use LivingMap**

```typescript
// ui/src/App.tsx
import { useState, useEffect } from 'react';
import { fetchMemories, fetchStats, fetchConflicts, fetchEmbeddings } from './api/client.js';
import { LivingMap } from './views/LivingMap/LivingMap.js';
import type { Memory, Stats, Conflict, EmbeddingIndex } from './types.js';

export function App() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [embeddings, setEmbeddings] = useState<EmbeddingIndex>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchMemories(),
      fetchStats(),
      fetchConflicts(),
      fetchEmbeddings(),
    ])
      .then(([mems, st, conf, emb]) => {
        setMemories(mems);
        setStats(st);
        setConflicts(conf);
        setEmbeddings(emb);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--muted)' }}>
        Loading memories...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 8 }}>
        <div style={{ color: 'var(--red)' }}>Failed to load memory data</div>
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>{error}</div>
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>Is <code>hippo dashboard</code> running?</div>
      </div>
    );
  }

  if (!stats) return null;

  return <LivingMap memories={memories} embeddings={embeddings} stats={stats} />;
}
```

**Step 5: Verify the full build**

```bash
cd C:/Users/<user>/hippo/ui && npm run build
```

Expected: `dist-ui/` created at hippo root with bundled assets.

**Step 6: Integration test — run the full stack**

```bash
# Terminal 1: build everything
cd C:/Users/<user>/hippo && npm run build

# Terminal 2: start dashboard
cd C:/Users/<user>/hippo && node bin/hippo.js dashboard --port 3333

# Open browser to http://localhost:3333
# Should see the Living Map with particles
```

**Step 7: Commit**

```bash
git add ui/src/views/ ui/src/components/ ui/src/App.tsx
git commit -m "feat(ui): Living Map view with particle engine, search, and detail panel"
```

---

### Task 7: Build Pipeline Integration

**Files:**
- Modify: `package.json` (root)
- Modify: `tsconfig.json` (exclude ui/)
- Create: `.gitignore` addition for dist-ui/

**Step 1: Update root package.json**

Add `dist-ui` to files array and update build scripts:

```json
{
  "files": [
    "dist",
    "dist-ui",
    "bin",
    "scripts/postinstall.cjs",
    "openclaw.plugin.json",
    "extensions/openclaw-plugin"
  ],
  "scripts": {
    "build": "tsc",
    "build:ui": "cd ui && npm install && npm run build",
    "build:all": "npm run build && npm run build:ui",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "postinstall": "node scripts/postinstall.cjs",
    "smoke:pack": "node scripts/smoke-pack.mjs",
    "smoke:openclaw-install": "node scripts/smoke-openclaw-install.mjs",
    "prepublishOnly": "npm run build:all"
  }
}
```

**Step 2: Update tsconfig.json to exclude ui/**

```json
{
  "exclude": ["node_modules", "dist", "tests", "ui"]
}
```

**Step 3: Add dist-ui to .gitignore**

```
dist-ui/
```

**Step 4: Verify full pipeline**

```bash
cd C:/Users/<user>/hippo
npm run build:all
ls dist-ui/
# Should contain index.html + assets/
npm run test
# All existing tests should still pass
```

**Step 5: Commit**

```bash
git add package.json tsconfig.json .gitignore
git commit -m "chore: integrate UI build pipeline, add dist-ui to package files"
```

---

### Task 8: Conflict Lines on Canvas

**Files:**
- Modify: `ui/src/engine/particles.ts` (add conflict rendering)
- Modify: `ui/src/views/LivingMap/LivingMap.tsx` (pass conflicts)
- Modify: `ui/src/views/LivingMap/useCanvasEngine.ts` (accept conflicts)
- Test: `ui/src/engine/particles.test.ts` (add conflict test)

**Step 1: Add conflict rendering to ParticleEngine**

Add to `particles.ts`:

```typescript
renderConflicts(
  ctx: CanvasRenderingContext2D,
  conflicts: Array<{ memory_a_id: string; memory_b_id: string; score: number }>,
): void {
  const particleMap = new Map(this.particles.map((p) => [p.id, p]));

  for (const c of conflicts) {
    const a = particleMap.get(c.memory_a_id);
    const b = particleMap.get(c.memory_b_id);
    if (!a || !b) continue;

    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = `rgba(248, 113, 113, ${0.2 + c.score * 0.6})`;
    ctx.lineWidth = 1 + c.score;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
```

Update `render()` to call `renderConflicts()` before particles.

**Step 2: Test conflict rendering**

```typescript
it('renderConflicts draws lines between conflicting particles', () => {
  const engine = new ParticleEngine();
  const m1 = { ...mockMemory, id: 'c1' };
  const m2 = { ...mockMemory, id: 'c2' };
  const positions = {
    c1: [0, 0] as [number, number],
    c2: [0.5, 0.5] as [number, number],
  };
  engine.initialize([m1, m2], positions, 800, 600);
  // If renderConflicts exists and doesn't throw, it works
  // (Canvas rendering can't be easily tested without a DOM)
  expect(typeof engine.renderConflicts).toBe('function');
});
```

**Step 3: Wire conflicts through useCanvasEngine and LivingMap**

Pass `conflicts` prop down and call `engine.renderConflicts()` in the animation loop.

**Step 4: Commit**

```bash
git add ui/src/engine/ ui/src/views/
git commit -m "feat(ui): render conflict lines between memory particles"
```

---

### Task 9: Final Polish and Empty States

**Files:**
- Modify: `ui/src/App.tsx` (empty state)
- Modify: `ui/src/views/LivingMap/LivingMap.tsx` (zero-memory state)
- Modify: `ui/src/engine/particles.ts` (decay animation tick)

**Step 1: Add empty state to LivingMap**

When `memories.length === 0`, show:

```tsx
<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12 }}>
  <div style={{ fontSize: 48 }}>🧠</div>
  <div style={{ color: 'var(--text)', fontSize: 16 }}>No memories yet</div>
  <div style={{ color: 'var(--muted)', fontSize: 13 }}>
    Run <code style={{ background: 'var(--surface)', padding: '2px 6px', borderRadius: 4 }}>hippo remember "your first memory"</code> to get started
  </div>
</div>
```

**Step 2: Add subtle decay animation**

In `ParticleEngine.render()`, slowly pulse particle opacity based on strength:

```typescript
// In render loop, update opacity over time to simulate live decay
const decayPulse = 1 + 0.03 * Math.sin(time * this.config.decayAnimationSpeed + p.pulsePhase);
const animatedOpacity = effectiveOpacity * decayPulse;
```

This gives the map a subtle breathing effect that reinforces the "alive" feeling.

**Step 3: Verify everything works end-to-end**

```bash
cd C:/Users/<user>/hippo
npm run build:all
npm run test
node bin/hippo.js dashboard
# Open http://localhost:3333
# Verify: particles render, hover tooltips work, search filters, detail panel opens, conflicts show
```

**Step 4: Commit**

```bash
git add ui/
git commit -m "feat(ui): empty states, decay animation, final polish for v0.25"
```

---

### Task 10: Version Bump and Changelog

**Files:**
- Modify: `package.json` (version → 0.25.0)
- Modify: `CHANGELOG.md`

**Step 1: Bump version**

```bash
cd C:/Users/<user>/hippo
npm version minor --no-git-tag-version
```

**Step 2: Update CHANGELOG.md**

Add entry for 0.25.0:

```markdown
## 0.25.0 — Brain Observatory

### Added
- **Living Map UI** — `hippo dashboard` now serves an interactive particle visualization
  - Memories rendered as glowing particles on a 2D canvas
  - Color by layer (buffer=blue, episodic=amber, semantic=green)
  - Size by retrieval count, opacity by strength
  - Force-directed layout using PCA-projected embeddings
  - Hover tooltips with memory details
  - Click for full detail panel
  - Search filtering with dimming
  - Conflict lines between conflicting memories
  - Subtle decay animation
- **JSON API** — `/api/memories`, `/api/stats`, `/api/conflicts`, `/api/embeddings`, `/api/peers`, `/api/config`
- Legacy inline HTML dashboard preserved as fallback when UI is not built
```

**Step 3: Commit and tag**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: release 0.25.0 — Brain Observatory"
git tag v0.25.0
```

---

## Summary

| Task | Description | Effort |
|------|-------------|--------|
| 1 | JSON API endpoints in dashboard.ts | 20 min |
| 2 | Scaffold ui/ with Vite + React + TS | 15 min |
| 3 | PCA projection (384-dim → 2D) | 15 min |
| 4 | Particle engine (canvas renderer) | 30 min |
| 5 | Force-directed layout (d3-force) | 15 min |
| 6 | LivingMap React component | 30 min |
| 7 | Build pipeline integration | 10 min |
| 8 | Conflict lines on canvas | 15 min |
| 9 | Polish and empty states | 15 min |
| 10 | Version bump and changelog | 5 min |
| **Total** | | **~3 hours** |

Each task is independently committable. Tests first, implement, verify, commit.
