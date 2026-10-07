// hippo logo round 5: one three.js scene shared by render.html (stills) and live.html (orbit).
import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';

export const INK = '#0b0f0c', MINT = '#7ce38b', AMBER = '#f2b84b';
const S = 1 / 20; // 64-unit SVG grid to scene units
const G = (x, y) => new THREE.Vector2((x - 32) * S, (32 - y) * S);

export const DEFAULTS = {
  form: 'echo', mat: 'ghost', env: 'a', tone: 'neutral', bg: 'dark', yaw: -22, pitch: 14, dist: 9.5,
  bev: 1.5, thick: 7, tile: '', ao: 1, bloom: 1, zoff: 0, exposure: 1, glow: 3, floor: 1, shadow: 1, bz: -9, bs: 24, mark: 1, key: 1,
};

// ---------- stroke centreline -> filled outline (distance field + marching squares) ----------

// Round-capped stroke of radius r around polylines, returned as closed loops in grid units.
export function strokeOutline(polylines, r, res = 8) {
  const segs = [];
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const pl of polylines) for (let i = 0; i + 1 < pl.length; i++) {
    const a = pl[i], b = pl[i + 1];
    segs.push(a.x, a.y, b.x, b.y);
    minX = Math.min(minX, a.x, b.x); maxX = Math.max(maxX, a.x, b.x);
    minY = Math.min(minY, a.y, b.y); maxY = Math.max(maxY, a.y, b.y);
  }
  const x0 = minX - r - 1, y0 = minY - r - 1;
  const nx = Math.ceil((maxX - minX + 2 * r + 2) * res) + 1, ny = Math.ceil((maxY - minY + 2 * r + 2) * res) + 1;
  const f = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = x0 + i / res, y = y0 + j / res;
    let d = Infinity;
    for (let s = 0; s < segs.length; s += 4) {
      const ax = segs[s], ay = segs[s + 1], dx = segs[s + 2] - ax, dy = segs[s + 3] - ay, l2 = dx * dx + dy * dy;
      let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - x, ey = ay + t * dy - y, dd = ex * ex + ey * ey;
      if (dd < d) d = dd;
    }
    f[j * nx + i] = Math.sqrt(d) - r;
  }
  return marchingSquares(f, nx, ny, (i, j) => [x0 + i / res, y0 + j / res]);
}

function marchingSquares(f, nx, ny, toXY) {
  const H = (i, j) => 2 * (j * nx + i), V = (i, j) => 2 * (j * nx + i) + 1;
  const pts = new Map(), adj = new Map();
  const lerp = (i0, j0, i1, j1) => {
    const a = f[j0 * nx + i0], b = f[j1 * nx + i1], t = a / (a - b);
    const [xa, ya] = toXY(i0, j0), [xb, yb] = toXY(i1, j1);
    return [xa + (xb - xa) * t, ya + (yb - ya) * t];
  };
  const link = (e0, p0, e1, p1) => {
    pts.set(e0, p0); pts.set(e1, p1);
    if (!adj.has(e0)) adj.set(e0, []); if (!adj.has(e1)) adj.set(e1, []);
    adj.get(e0).push(e1); adj.get(e1).push(e0);
  };
  const TABLE = { 1: [[0, 1]], 2: [[1, 2]], 3: [[0, 2]], 4: [[2, 3]], 5: [[0, 1], [2, 3]], 6: [[1, 3]], 7: [[0, 3]],
    8: [[3, 0]], 9: [[1, 3]], 10: [[1, 2], [3, 0]], 11: [[2, 3]], 12: [[2, 0]], 13: [[1, 2]], 14: [[0, 1]] };
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    const code = (f[j * nx + i] < 0 ? 1 : 0) | (f[j * nx + i + 1] < 0 ? 2 : 0) | (f[(j + 1) * nx + i + 1] < 0 ? 4 : 0) | (f[(j + 1) * nx + i] < 0 ? 8 : 0);
    if (code === 0 || code === 15) continue;
    // edge order: 0 left, 1 top, 2 right, 3 bottom
    const ids = [V(i, j), H(i, j), V(i + 1, j), H(i, j + 1)];
    const cross = [() => lerp(i, j, i, j + 1), () => lerp(i, j, i + 1, j), () => lerp(i + 1, j, i + 1, j + 1), () => lerp(i, j + 1, i + 1, j + 1)];
    for (const [a, b] of TABLE[code]) link(ids[a], cross[a](), ids[b], cross[b]());
  }
  const seen = new Set(), loops = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let prev = -1, cur = start;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur); loop.push(pts.get(cur));
      const n = adj.get(cur), next = n[0] === prev ? n[1] : n[0];
      prev = cur; cur = next;
    }
    if (loop.length > 8) loops.push(loop);
  }
  return loops;
}

// Even arc-length resample through a closed Catmull-Rom so the bevel normals stay smooth.
function smoothLoop(loop, spacing = 0.12) {
  const pts = loop.map(([x, y]) => [x, y]);
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < pts.length; i++) {
    const a = loop[(i + pts.length - 1) % pts.length], c = loop[(i + 1) % pts.length];
    pts[i] = [0.25 * a[0] + 0.5 * loop[i][0] + 0.25 * c[0], 0.25 * a[1] + 0.5 * loop[i][1] + 0.25 * c[1]];
  }
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, y]) => new THREE.Vector3(x, y, 0)), true, 'centripetal');
  curve.arcLengthDivisions = pts.length * 3;
  const n = Math.max(32, Math.round(curve.getLength() / spacing));
  return curve.getSpacedPoints(n).slice(0, -1).map((p) => [p.x, p.y]);
}

const area = (l) => l.reduce((a, [x, y], i) => { const [x2, y2] = l[(i + 1) % l.length]; return a + x * y2 - x2 * y; }, 0) / 2;

// Largest loop is the outline, the rest are holes; grid coords become centred scene coords.
export function loopsToShape(loops, spacing = 0.12) {
  const cvt = (l) => smoothLoop(l, spacing).map(([x, y]) => G(x, y));
  const sorted = loops.map((l) => [Math.abs(area(l)), l]).sort((a, b) => b[0] - a[0]);
  const shape = new THREE.Shape(cvt(sorted[0][1]));
  for (const [, l] of sorted.slice(1)) shape.holes.push(new THREE.Path(cvt(l)));
  return shape;
}

// Bevelled slab centred on z=0; merged so the bevel shades smoothly, planar uv for anisotropy.
export function extrude(shape, depth, bevel, segs = 12) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: 0, bevelSegments: segs, curveSegments: 24 });
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  const m = BGU.mergeVertices(g, 1e-4);
  m.computeVertexNormals();
  m.translate(0, 0, -depth / 2);
  const p = m.attributes.position, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[2 * i] = p.getX(i); uv[2 * i + 1] = p.getY(i); }
  m.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return m;
}

async function centrelines(file) {
  const data = new SVGLoader().parse(await (await fetch(file)).text());
  const lines = [];
  for (const p of data.paths) for (const sp of p.subPaths) lines.push(sp.getSpacedPoints(Math.max(8, Math.round(sp.getLength() * 3))));
  return lines;
}

// Log-spiral band whose section halves each turn: the half-life as one solid.
function coilGeometry() {
  const turns = 1.9, R0 = 1.12, Rend = 0.24, k = Math.log(R0 / Rend) / (turns * 2 * Math.PI);
  const N = 480, M = 40, n = 4.5, pos = [], idx = [];
  const ring = (t) => {
    const th = t * turns * 2 * Math.PI, r = R0 * Math.exp(-k * th);
    const T = new THREE.Vector2(-k * Math.cos(th) - Math.sin(th), -k * Math.sin(th) + Math.cos(th)).normalize();
    const w = 0.29 * r * (1 - Math.exp(-2 * Math.PI * k)), h = 0.22 * r;
    const out = [];
    for (let j = 0; j <= M; j++) {
      const a = (j / M) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
      const u = w * Math.sign(c) * Math.pow(Math.abs(c), 2 / n), v = h * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
      out.push(r * Math.cos(th) - u * T.y, r * Math.sin(th) + u * T.x, v);
    }
    return out;
  };
  for (let i = 0; i <= N; i++) pos.push(...ring(i / N));
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
    const a = i * (M + 1) + j, b = a + M + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  for (const [row, flip] of [[0, true], [N, false]]) {
    const c = pos.length / 3, base = row * (M + 1);
    let cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < M; j++) { cx += pos[3 * (base + j)]; cy += pos[3 * (base + j) + 1]; cz += pos[3 * (base + j) + 2]; }
    pos.push(cx / M, cy / M, cz / M);
    for (let j = 0; j < M; j++) idx.push(c, base + (flip ? j + 1 : j), base + (flip ? j : j + 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const m = BGU.mergeVertices(g.toNonIndexed(), 1e-5);
  m.computeVertexNormals();
  m.rotateZ(2.2);
  const q = m.attributes.position, uv = new Float32Array(q.count * 2);
  for (let i = 0; i < q.count; i++) { uv[2 * i] = q.getX(i); uv[2 * i + 1] = q.getY(i); }
  m.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); // anisotropic metals need uv or the frame goes NaN-black
  return m;
}

function tileShape(size, radius) {
  const s = new THREE.Shape(), h = size / 2, r = radius;
  s.moveTo(-h + r, -h); s.lineTo(h - r, -h); s.absarc(h - r, -h + r, r, -Math.PI / 2, 0, false);
  s.lineTo(h, h - r); s.absarc(h - r, h - r, r, 0, Math.PI / 2, false);
  s.lineTo(-h + r, h); s.absarc(-h + r, h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-h, -h + r); s.absarc(-h + r, -h + r, r, Math.PI, 1.5 * Math.PI, false);
  return s;
}

// Each form is a list of [slot, geometry, lightCore?]; slots are main, echo, core.
async function buildForm(p) {
  const bev = +p.bev * S, depth = (+p.thick - 2 * +p.bev) * S, r = 3 - +p.bev;
  const parts = [];
  // Thin inner slab along the same centreline: the light source inside a frosted shell.
  const core = (lines) => extrude(loopsToShape(strokeOutline(lines, 1.3)), depth * 0.35, 0.25 * S, 4);
  if (p.form === 'curl') {
    const data = new SVGLoader().parse(await (await fetch('curl.svg')).text());
    const shapes = data.paths.flatMap((path) => SVGLoader.createShapes(path));
    shapes.forEach((sh, i) => {
      const loop = sh.extractPoints(64).shape.map((v) => [v.x, v.y]);
      const slab = extrude(loopsToShape([loop], 0.1), i ? depth * 1.25 : depth, i ? bev : bev * 0.6);
      if (!i) return parts.push(['main', slab]);
      const cx = loop.reduce((a, q) => a + q[0], 0) / loop.length, cy = loop.reduce((a, q) => a + q[1], 0) / loop.length;
      const inner = loop.map(([x, y]) => [cx + (x - cx) * 0.55, cy + (y - cy) * 0.55]);
      parts.push(['echo', slab, extrude(loopsToShape([inner], 0.1), depth * 0.45, 0.25 * S, 4)]);
    });
  } else if (p.form === 'coil') {
    parts.push(['main', coilGeometry()]);
  } else {
    const lines = await centrelines(p.form === 'decay' ? 'decay-h.svg' : 'echo-h.svg');
    if (p.form === 'echo') {
      parts.push(['main', extrude(loopsToShape(strokeOutline(lines.slice(0, 2), r)), depth, bev), core(lines.slice(0, 2))]);
      parts.push(['echo', extrude(loopsToShape(strokeOutline([lines[2]], r)), depth, bev), core([lines[2]])]);
    } else if (p.form === 'core') {
      parts.push(['main', extrude(loopsToShape(strokeOutline(lines, r)), depth, bev)]);
      const inner = [lines[0], lines[1], lines[2].slice(0, Math.round(lines[2].length * 0.5))];
      parts.push(['core', extrude(loopsToShape(strokeOutline(inner, 0.9)), depth * 0.3, 0.3 * S, 6)]);
    } else {
      parts.push(['main', extrude(loopsToShape(strokeOutline(lines, r)), depth, bev), core(lines)]);
    }
  }
  return parts;
}

// ---------- materials ----------

const PM = (o) => new THREE.MeshPhysicalMaterial(o);
export const MATS = {
  glassMint: () => PM({ color: '#e4fbe8', transmission: 1, roughness: 0.3, thickness: 0.5, ior: 1.5, dispersion: 0.12, attenuationColor: MINT, attenuationDistance: 0.4, envMapIntensity: 2.2 }),
  glassClear: () => PM({ color: '#ffffff', transmission: 1, roughness: 0.2, thickness: 0.4, ior: 1.5, dispersion: 0.1, attenuationColor: '#bdf0c6', attenuationDistance: 0.7, envMapIntensity: 2.2 }),
  glassFrost: () => PM({ color: '#f4fff6', transmission: 1, roughness: 0.45, thickness: 0.5, ior: 1.46, attenuationColor: '#a9ecb4', attenuationDistance: 0.6, envMapIntensity: 2 }),
  glassAmber: () => PM({ color: '#fff3dc', transmission: 1, roughness: 0.2, thickness: 0.4, ior: 1.5, attenuationColor: AMBER, attenuationDistance: 0.3, envMapIntensity: 2 }),
  glassGlow: () => PM({ color: '#eafff0', transmission: 0.9, roughness: 0.4, thickness: 0.6, ior: 1.46, attenuationColor: MINT, attenuationDistance: 0.5, emissive: MINT, emissiveIntensity: 0.55, envMapIntensity: 1.8 }),
  glassMilk: () => PM({ color: '#d9f3de', transmission: 0.7, roughness: 0.5, thickness: 0.8, ior: 1.46, attenuationColor: '#a9ecb4', attenuationDistance: 0.8, envMapIntensity: 1.6 }),
  ceramicMint: () => PM({ color: '#4fb865', roughness: 0.38, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.22, envMapIntensity: 0.6 }),
  ceramicClay: () => PM({ color: '#48b060', roughness: 0.55, metalness: 0, sheen: 0.5, sheenColor: '#ffffff', sheenRoughness: 0.6, envMapIntensity: 0.8 }),
  ceramicInk: () => PM({ color: '#151b17', roughness: 0.48, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.3, sheen: 0.3, sheenColor: MINT, sheenRoughness: 0.8, envMapIntensity: 1 }),
  ceramicBone: () => PM({ color: '#dde5de', roughness: 0.42, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.3, envMapIntensity: 0.9 }),
  metalDark: () => PM({ color: '#39423b', metalness: 1, roughness: 0.34, anisotropy: 0.8, envMapIntensity: 1.4 }),
  metalMint: () => PM({ color: '#a4e8ae', metalness: 1, roughness: 0.26, anisotropy: 0.6, envMapIntensity: 1.2 }),
  metalPolished: () => PM({ color: '#cdd5cf', metalness: 1, roughness: 0.1, envMapIntensity: 1.4 }),
  emissive: (k) => new THREE.MeshStandardMaterial({ color: MINT, emissive: MINT, emissiveIntensity: k, roughness: 1 }),
};

// slot -> material name; the mark's second body is where the pairing lives.
export const RECIPES = {
  glass: { main: 'glassMint', echo: 'glassMint', core: 'ceramicMint' },
  frost: { main: 'glassFrost', echo: 'glassFrost', core: 'ceramicMint' },
  ghost: { main: 'ceramicMint', echo: 'glassClear', core: 'ceramicMint' },
  bone: { main: 'ceramicBone', echo: 'glassMint', core: 'ceramicMint' },
  inkglass: { main: 'ceramicInk', echo: 'glassMint', core: 'ceramicMint' },
  metal: { main: 'metalDark', echo: 'glassMint', core: 'ceramicMint' },
  mintmetal: { main: 'metalMint', echo: 'metalMint', core: 'ceramicMint' },
  ceramic: { main: 'ceramicMint', echo: 'ceramicMint', core: 'ceramicMint' },
  amber: { main: 'ceramicMint', echo: 'glassAmber', core: 'ceramicMint' },
  core: { main: 'glassClear', echo: 'glassClear', core: 'ceramicMint' },
  polished: { main: 'glassMint', echo: 'metalPolished', core: 'ceramicMint' },
  milk: { main: 'glassMilk', echo: 'glassMilk', core: 'ceramicMint' },
  ghostmilk: { main: 'ceramicMint', echo: 'glassMilk', core: 'ceramicMint' },
  clay: { main: 'ceramicClay', echo: 'glassMilk', core: 'ceramicMint' },
  claysolid: { main: 'ceramicClay', echo: 'ceramicClay', core: 'ceramicMint' },
  glow: { main: 'glassGlow', echo: 'glassGlow', core: 'ceramicMint' },
  glowcore: { main: 'glassFrost', echo: 'glassFrost', core: 'ceramicMint', lit: 'all' },
  boneglow: { main: 'ceramicBone', echo: 'glassFrost', core: 'ceramicMint', lit: 'echo' },
  mintglow: { main: 'ceramicMint', echo: 'glassFrost', core: 'ceramicMint', lit: 'echo' },
  metalglow: { main: 'metalDark', echo: 'glassFrost', core: 'ceramicMint', lit: 'echo' },
  inkglow: { main: 'ceramicInk', echo: 'glassFrost', core: 'ceramicMint', lit: 'echo' },
};

// ---------- environment, lights, backdrop ----------

function studioEnv(renderer, variant) {
  const s = new THREE.Scene();
  s.background = new THREE.Color('#040604');
  const panel = (w, h, color, k, pos) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(0, 0, 0); s.add(m);
  };
  if (variant === 'b') {
    panel(6, 6, '#fff4e4', 4.5, [-7, 5, 4]);
    panel(1.6, 8, '#ffffff', 3.2, [8, 3, -1]);
    panel(9, 2, MINT, 1.2, [0, -6, 4]);
    panel(12, 5, '#0b100c', 1, [0, 8, -6]);
    panel(8, 5, '#ffffff', 1.4, [1, 3, 10]);
  } else {
    panel(10, 4, '#ffffff', 5, [0, 8, 3]);
    panel(2, 9, '#ffffff', 2.4, [-8, 2, 2]);
    panel(1.2, 9, MINT, 3, [7, 1, -3]);
    panel(14, 6, '#0e130f', 1, [0, -8, 0]);
    panel(9, 6, '#ffffff', 1.6, [-1, 4, 10]);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(s, 0.04).texture;
  pmrem.dispose();
  return tex;
}

function roomEnv(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return tex;
}

// Camera-facing gradient card; noise is baked in because an 8-bit ink gradient bands into visible contours.
function backdrop(light, size, dist, camera, flat = false) {
  const c = document.createElement('canvas'), N = 1024;
  c.width = c.height = N;
  const g = c.getContext('2d'), grad = g.createRadialGradient(N / 2, N * 0.42, 10, N / 2, N * 0.5, N * 0.62);
  if (light) { grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#e3e9e4'); }
  else { grad.addColorStop(0, '#2a3a2f'); grad.addColorStop(0.5, '#141c16'); grad.addColorStop(1, INK); }
  g.fillStyle = flat ? (light ? '#e3e9e4' : INK) : grad; g.fillRect(0, 0, N, N);
  const img = g.getImageData(0, 0, N, N), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 3; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex }));
  if (camera) { m.position.copy(camera.position).normalize().multiplyScalar(-Math.abs(dist)); m.lookAt(camera.position); }
  else m.position.z = -Math.abs(dist);
  return m;
}

// ---------- scene ----------

export async function createScene(renderer, size, q = {}) {
  const p = { ...DEFAULTS, ...q };
  RectAreaLightUniformsLib.init();
  const light = p.bg === 'light';
  renderer.toneMapping = p.tone === 'agx' ? THREE.AgXToneMapping : THREE.NeutralToneMapping;
  renderer.toneMappingExposure = +p.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.setClearColor(light ? '#e6ebe7' : INK, 1);

  const scene = new THREE.Scene();
  scene.environment = p.env === 'room' ? roomEnv(renderer) : studioEnv(renderer, p.env);
  scene.environmentIntensity = p.env === 'room' ? 0.55 : 1;

  const key = new THREE.RectAreaLight('#ffffff', (light ? 4 : 6) * +p.key, 3.5, 3.5);
  key.position.set(-2, 3.4, 3.6); key.lookAt(0, 0, 0); scene.add(key);
  const rim = new THREE.RectAreaLight(p.env === 'b' ? '#fff1dc' : MINT, 4 * +p.key, 0.9, 4.5);
  rim.position.set(3.4, 1.4, -1.4); rim.lookAt(0, 0, 0); scene.add(rim);
  const sun = new THREE.DirectionalLight('#ffffff', (light ? 1.4 : 1.1) * +p.key);
  sun.position.set(-2, 4.2, 3.2); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 7; sun.shadow.blurSamples = 20; sun.shadow.bias = -0.0005;
  Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 20 });
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 100);
  const yaw = THREE.MathUtils.degToRad(+p.yaw), pitch = THREE.MathUtils.degToRad(+p.pitch), d = +p.dist;
  camera.position.set(d * Math.sin(yaw) * Math.cos(pitch), d * Math.sin(pitch), d * Math.cos(yaw) * Math.cos(pitch));
  camera.lookAt(0, 0, 0);

  const recipe = p.tile === 'glow' ? RECIPES.glowcore : RECIPES[p.mat] || RECIPES.ghost;
  const group = new THREE.Group();
  for (const [slot, geo, lightCore] of await buildForm(p)) {
    const mesh = new THREE.Mesh(geo, MATS[recipe[slot]]());
    mesh.castShadow = mesh.receiveShadow = true;
    if (slot === 'echo') mesh.position.z += +p.zoff * S;
    if (lightCore && (recipe.lit === 'all' || recipe.lit === slot)) mesh.add(new THREE.Mesh(lightCore, MATS.emissive(+p.glow)));
    group.add(mesh);
  }

  const root = new THREE.Group();
  scene.add(root);
  if (p.tile) {
    // App-icon slab: ink ceramic squircle with the mark proud of its face, shadow on a wall behind.
    const tile = new THREE.Mesh(extrude(tileShape(3.2, 0.72), 0.3, 0.05, 8), MATS.ceramicInk());
    tile.castShadow = tile.receiveShadow = true;
    root.add(tile);
    group.scale.setScalar(0.8);
    group.position.z = 0.2 + (+p.thick * S * 0.8) / 2 - 0.06;
    root.add(group);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), new THREE.ShadowMaterial({ opacity: light ? 0.3 : 0.55 }));
    wall.position.z = -0.5; wall.receiveShadow = true; scene.add(wall);
    scene.add(backdrop(light, 16, 0.52, null, !!+p.flat));
  } else {
    root.add(group);
    root.updateMatrixWorld(true);
    const low = new THREE.Box3().setFromObject(root).min.y;
    if (+p.floor) {
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: light ? 0.32 : 0.5 }));
      floor.rotation.x = -Math.PI / 2; floor.position.y = low - 0.01; floor.receiveShadow = true; scene.add(floor);
    }
    const card = backdrop(light, +p.bs, +p.bz, camera, !!+p.flat);
    card.userData.noAO = true; // the floor sits nearer than the card and GTAO drew their horizon as a dark line
    scene.add(card);
    if (!+p.mark) root.remove(group);
  }
  if (!+p.shadow) sun.castShadow = false;

  const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  if (+p.ao) {
    const gtao = new GTAOPass(scene, camera, size, size);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 0.7;
    gtao.updateGtaoMaterial({ radius: 0.32, distanceExponent: 1, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
    const hide = gtao._overrideVisibility.bind(gtao);
    gtao._overrideVisibility = () => { hide(); scene.traverse((o) => { if (o.userData.noAO && o.visible) { o.visible = false; gtao._visibilityCache.push(o); } }); };
    composer.addPass(gtao);
  }
  if (+p.bloom && !light) composer.addPass(new UnrealBloomPass(new THREE.Vector2(size, size), 0.18, 0.55, 0.92));
  composer.addPass(new OutputPass());

  return { scene, camera, composer, group, root, render: () => composer.render() };
}

export function paramsFrom(search) {
  const q = {};
  for (const [k, v] of new URLSearchParams(search)) q[k] = v;
  return q;
}
