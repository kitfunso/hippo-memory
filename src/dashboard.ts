/**
 * Hippo Dashboard — local web UI for memory health visualization.
 * Serves a single-page app with memory stats, decay curves, and conflict status.
 *
 * Usage: hippo dashboard [--port 3333]
 */

import * as http from 'http';
import { loadAllEntries, listMemoryConflicts } from './store.js';
import { calculateStrength, resolveConfidence, type MemoryEntry } from './memory.js';
import { loadConfig } from './config.js';
import { listPeers } from './shared.js';
import { loadEmbeddingIndex } from './embeddings.js';

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
  const entries = loadAllEntries(hippoRoot);
  const now = new Date();
  const config = loadConfig(hippoRoot);
  const conflicts = listMemoryConflicts(hippoRoot, 'open');
  const peers = listPeers();
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
      open_conflicts: conflicts.length,
    },
    peers,
    config: {
      defaultHalfLifeDays: config.defaultHalfLifeDays,
      defaultBudget: config.defaultBudget,
      embeddingsEnabled: config.embeddings.enabled,
    },
  };
}

function dashboardHTML(data: DashboardData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hippo Dashboard</title>
<style>
  :root {
    --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
    --text: #e1e4ed; --muted: #8b8fa3; --accent: #6c8cff;
    --green: #4ade80; --yellow: #fbbf24; --red: #f87171; --purple: #a78bfa;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); padding: 24px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 4px; }
  h1 span { font-size: 14px; color: var(--muted); font-weight: normal; margin-left: 8px; }
  h2 { font-size: 16px; color: var(--muted); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { font-size: 28px; font-weight: 600; margin-top: 4px; }
  .card .sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .bar-chart { display: flex; gap: 4px; align-items: flex-end; height: 120px; margin-top: 8px; }
  .bar { flex: 1; min-width: 4px; background: var(--accent); border-radius: 2px 2px 0 0; position: relative; transition: background 0.2s; cursor: default; }
  .bar:hover { background: #8aa4ff; }
  .bar .tooltip { display: none; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: var(--surface); border: 1px solid var(--border); padding: 4px 8px; border-radius: 4px; font-size: 11px; white-space: nowrap; z-index: 10; }
  .bar:hover .tooltip { display: block; }
  .strength-high { background: var(--green); }
  .strength-mid { background: var(--yellow); }
  .strength-low { background: var(--red); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px; border-bottom: 2px solid var(--border); color: var(--muted); font-size: 11px; text-transform: uppercase; }
  td { padding: 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:hover { background: rgba(108, 140, 255, 0.05); }
  .tag { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; background: var(--border); color: var(--muted); margin: 1px; }
  .tag-error { background: rgba(248, 113, 113, 0.15); color: var(--red); }
  .strength-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; }
  .pill-pinned { background: rgba(167, 139, 250, 0.15); color: var(--purple); }
  .pill-stale { background: rgba(251, 191, 36, 0.15); color: var(--yellow); }
  .content-preview { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .section { margin-bottom: 32px; }
  .conflict-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 8px; }
  .conflict-card .reason { color: var(--muted); font-size: 12px; }
  .search { width: 100%; padding: 8px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 14px; margin-bottom: 12px; outline: none; }
  .search:focus { border-color: var(--accent); }
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; }
  .tab { padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; background: var(--surface); border: 1px solid var(--border); color: var(--muted); }
  .tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .footer { text-align: center; color: var(--muted); font-size: 12px; margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); }
</style>
</head>
<body>
<h1>Hippo Dashboard <span>v0.8.0</span></h1>
<p style="color: var(--muted); margin-bottom: 24px;">Memory health at a glance. Auto-refreshes on page load.</p>

<div class="section">
  <h2>Overview</h2>
  <div class="grid" id="stats-grid"></div>
</div>

<div class="section">
  <h2>Strength Distribution</h2>
  <div class="card">
    <div class="bar-chart" id="strength-chart"></div>
    <div style="display: flex; justify-content: space-between; margin-top: 8px; font-size: 11px; color: var(--muted);">
      <span>Weakest</span><span>Strongest</span>
    </div>
  </div>
</div>

<div class="section" id="conflicts-section" style="display:none;">
  <h2>Open Conflicts</h2>
  <div id="conflicts-list"></div>
</div>

<div class="section" id="peers-section" style="display:none;">
  <h2>Shared Memory Peers</h2>
  <div id="peers-list"></div>
</div>

<div class="section">
  <h2>Memories</h2>
  <input type="text" class="search" id="search" placeholder="Filter by content or tag...">
  <div class="tabs" id="tabs">
    <div class="tab active" data-filter="all">All</div>
    <div class="tab" data-filter="strong">Strong (&gt;0.5)</div>
    <div class="tab" data-filter="atrisk">At Risk (&lt;0.1)</div>
    <div class="tab" data-filter="pinned">Pinned</div>
    <div class="tab" data-filter="errors">Errors</div>
  </div>
  <table>
    <thead><tr><th></th><th>Content</th><th>Tags</th><th>Strength</th><th>Half-life</th><th>Retrievals</th><th>Age</th></tr></thead>
    <tbody id="memory-table"></tbody>
  </table>
</div>

<div class="footer">Hippo Memory — biologically-inspired memory for AI agents</div>

<script>
const DATA = ${JSON.stringify(data)};

function strengthColor(s) {
  if (s >= 0.5) return 'var(--green)';
  if (s >= 0.1) return 'var(--yellow)';
  return 'var(--red)';
}
function strengthClass(s) {
  if (s >= 0.5) return 'strength-high';
  if (s >= 0.1) return 'strength-mid';
  return 'strength-low';
}

// Stats grid
const statsGrid = document.getElementById('stats-grid');
const stats = DATA.stats;
const cards = [
  { label: 'Total Memories', value: stats.total, sub: stats.pinned + ' pinned' },
  { label: 'Avg Strength', value: stats.avg_strength.toFixed(2), sub: stats.at_risk + ' at risk' },
  { label: 'Avg Half-life', value: stats.avg_half_life.toFixed(1) + 'd', sub: 'default: ' + DATA.config.defaultHalfLifeDays + 'd' },
  { label: 'Error Memories', value: stats.errors, sub: Math.round(stats.errors / Math.max(1, stats.total) * 100) + '% of total' },
  { label: 'Embedding Coverage', value: Math.round(stats.embedding_coverage * 100) + '%', sub: DATA.config.embeddingsEnabled === 'auto' ? 'auto mode' : String(DATA.config.embeddingsEnabled) },
  { label: 'Open Conflicts', value: stats.open_conflicts, sub: stats.open_conflicts > 0 ? 'needs resolution' : 'all clear' },
];
statsGrid.innerHTML = cards.map(c => '<div class="card"><div class="label">' + c.label + '</div><div class="value">' + c.value + '</div><div class="sub">' + c.sub + '</div></div>').join('');

// Strength chart
const chart = document.getElementById('strength-chart');
const sorted = [...DATA.memories].sort((a, b) => a.strength - b.strength);
if (sorted.length > 0) {
  const maxBars = Math.min(sorted.length, 100);
  const step = Math.max(1, Math.floor(sorted.length / maxBars));
  const sampled = [];
  for (let i = 0; i < sorted.length; i += step) sampled.push(sorted[i]);
  chart.innerHTML = sampled.map(m => {
    const h = Math.max(2, Math.round(m.strength * 100));
    return '<div class="bar ' + strengthClass(m.strength) + '" style="height:' + h + '%"><div class="tooltip">' + m.id + ': ' + m.strength.toFixed(2) + '</div></div>';
  }).join('');
}

// Conflicts
if (DATA.conflicts.length > 0) {
  document.getElementById('conflicts-section').style.display = '';
  document.getElementById('conflicts-list').innerHTML = DATA.conflicts.map(c =>
    '<div class="conflict-card"><strong>conflict_' + c.id + '</strong> (score: ' + c.score.toFixed(2) + ')<br>' +
    '<code>' + c.memory_a_id + '</code> vs <code>' + c.memory_b_id + '</code><br>' +
    '<span class="reason">' + c.reason + '</span></div>'
  ).join('');
}

// Peers
if (DATA.peers.length > 0) {
  document.getElementById('peers-section').style.display = '';
  document.getElementById('peers-list').innerHTML = '<div class="card"><table><thead><tr><th>Project</th><th>Memories</th><th>Latest</th></tr></thead><tbody>' +
    DATA.peers.map(p => '<tr><td>' + p.project + '</td><td>' + p.count + '</td><td>' + p.latest.slice(0, 10) + '</td></tr>').join('') +
    '</tbody></table></div>';
}

// Memory table
function renderTable(filter, search) {
  const tbody = document.getElementById('memory-table');
  let mems = DATA.memories;
  if (filter === 'strong') mems = mems.filter(m => m.strength >= 0.5);
  else if (filter === 'atrisk') mems = mems.filter(m => m.strength < 0.1 && !m.pinned);
  else if (filter === 'pinned') mems = mems.filter(m => m.pinned);
  else if (filter === 'errors') mems = mems.filter(m => m.tags.includes('error'));
  if (search) {
    const q = search.toLowerCase();
    mems = mems.filter(m => m.content.toLowerCase().includes(q) || m.tags.some(t => t.includes(q)));
  }
  mems.sort((a, b) => b.strength - a.strength);
  tbody.innerHTML = mems.slice(0, 200).map(m => {
    const dot = '<span class="strength-dot" style="background:' + strengthColor(m.strength) + '"></span>';
    const pills = [];
    if (m.pinned) pills.push('<span class="pill pill-pinned">pinned</span>');
    if (m.confidence === 'stale') pills.push('<span class="pill pill-stale">stale</span>');
    const tags = m.tags.map(t => '<span class="tag' + (t === 'error' ? ' tag-error' : '') + '">' + t + '</span>').join(' ');
    return '<tr><td>' + dot + pills.join(' ') + '</td>' +
      '<td class="content-preview" title="' + m.content.replace(/"/g, '&quot;') + '">' + m.content.slice(0, 80) + (m.content.length > 80 ? '...' : '') + '</td>' +
      '<td>' + tags + '</td>' +
      '<td>' + m.strength.toFixed(2) + '</td>' +
      '<td>' + m.half_life_days + 'd</td>' +
      '<td>' + m.retrieval_count + '</td>' +
      '<td>' + m.age_days + 'd</td></tr>';
  }).join('');
}

let activeFilter = 'all';
document.getElementById('tabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  activeFilter = tab.dataset.filter;
  renderTable(activeFilter, document.getElementById('search').value);
});
document.getElementById('search').addEventListener('input', e => {
  renderTable(activeFilter, e.target.value);
});
renderTable('all', '');
</script>
</body>
</html>`;
}

export function serveDashboard(hippoRoot: string, port: number = 3333): void {
  const server = http.createServer((_req, res) => {
    const data = buildDashboardData(hippoRoot);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dashboardHTML(data));
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Hippo Dashboard running at http://localhost:${port}`);
    console.log('Press Ctrl+C to stop.');
  });
}
