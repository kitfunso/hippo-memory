// Memory dust: a seahorse (hippocampus) built as a swept-capsule SDF and sampled into tens of thousands of
// additive particles whose density halves every `half` of the spine, so the tail thins into drifting dust.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { headSDF, HEAD } from '../surfacing/scene.js';

export const INK = '#0b0f0c', MINT = '#7ce38b', AMBER = '#f2b84b';

export const DEFAULTS = {
  form: 'seahorse', n: 120000, half: 0.5, shell: 0.8, eps: 0.012, drift: 0.4, far: 0.08, t0: 0.6, amber: 0.015, jitter: 0.004, seed: 7, rings: 0.45, nrings: 14,
  size: 1024, yaw: 22, pitch: 4, dist: 4.2, fov: 30, tx: 0.1, ty: 0.1, tz: 0,
  psize: 0.005, gain: 0.2, aperture: 0.018, focus: 'head', bloom: 0.7, exposure: 1, alpha: 0, haze: 0, core: 0.4, ash: 1, tm: 'neutral',
};

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };

// ---------- seahorse: spine control points [x, y, radius], head first, tail curling under ----------

const SPINE = [
  [-0.06, 0.78, 0.15], [0.04, 0.66, 0.14], [0.06, 0.52, 0.12], [0.03, 0.36, 0.17], [-0.02, 0.18, 0.21], [-0.03, 0.0, 0.2],
  [0.01, -0.18, 0.16], [0.08, -0.35, 0.115], [0.18, -0.5, 0.08], [0.32, -0.62, 0.058], [0.47, -0.62, 0.045], [0.57, -0.5, 0.036],
  [0.56, -0.36, 0.028], [0.45, -0.27, 0.022], [0.35, -0.31, 0.017], [0.34, -0.41, 0.013],
];
const CAPS = [ // extra capsules: [ax, ay, bx, by, ra, rb, t]
  [-0.13, 0.72, -0.48, 0.56, 0.085, 0.045, 0],  // snout
  [-0.2, 0.64, -0.12, 0.66, 0.07, 0.09, 0],     // jaw under the snout base
  [-0.02, 0.9, 0.04, 1.04, 0.05, 0.015, 0],     // coronet
];
const FIN = [0.24, -0.02, 0, 0.1, 0.15, 0.008, 0.3];  // dorsal fin: flat ellipsoid, [cx, cy, cz, rx, ry, rz, t]
const EYES = [[-0.1, 0.8, 0.12], [-0.1, 0.8, -0.12]];

function buildSpine(M = 100) {
  const curve = new THREE.CatmullRomCurve3(SPINE.map(([x, y]) => new THREE.Vector3(x, y, 0)), false, 'centripetal');
  const rCurve = new THREE.CatmullRomCurve3(SPINE.map(([, , r], i) => new THREE.Vector3(i / (SPINE.length - 1), r, 0)));
  const pts = [], rad = [];
  for (let i = 0; i <= M; i++) {
    const u = i / M, t = curve.getUtoTmapping(u);
    pts.push(curve.getPoint(t)); rad.push(rCurve.getPoint(t).y);
  }
  return { pts, rad };
}

function segDist(px, py, pz, a, b, ra, rb) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const h = Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / l2));
  const ex = px - a.x - dx * h, ey = py - a.y - dy * h;
  return [Math.sqrt(ex * ex + ey * ey + pz * pz) - (ra + (rb - ra) * h), h];
}

function seahorseSDF(spine) {
  const { pts, rad } = spine, M = pts.length - 1;
  return (x, y, z) => {
    let best = 1e9, bt = 0;
    for (let i = 0; i < M; i++) {
      const [d, h] = segDist(x, y, z, pts[i], pts[i + 1], rad[i], rad[i + 1]);
      if (d < best) { best = d; bt = (i + h) / M; }
    }
    let d = best;
    for (const [ax, ay, bx, by, ra, rb, t] of CAPS) {
      const [dc] = segDist(x, y, z, { x: ax, y: ay }, { x: bx, y: by }, ra, rb);
      if (dc < d) bt = t;
      d = smin(d, dc, 0.05);
    }
    // iq's ellipsoid bound: the naive (|p/r|-1)*min(r) form overstated the thin fin's shell 12x along its long axes.
    const [cx, cy, cz, rx, ry, rz, ft] = FIN;
    const px = x - cx, py = y - cy, pz = z - cz;
    const k0 = Math.hypot(px / rx, py / ry, pz / rz), k1 = Math.hypot(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
    const df = (k0 * (k0 - 1)) / k1;
    if (df < d) bt = ft;
    d = smin(d, df, 0.03);
    return [d, bt];
  };
}

// ---------- hippo head: the round-5 sculpt, dissolving below the waterline ----------

function hippoSDF() {
  const [ex, ey, ez, er] = HEAD.eyeball;
  return (x, y, z) => {
    let d = headSDF(x, y, z);
    for (const sx of [1, -1]) d = Math.min(d, Math.hypot(x - sx * ex, y - ey, z - ez) - er);
    return [d, Math.min(1, Math.max(0, (0.1 - y) / 1.0))];
  };
}

const FORMS = {
  seahorse: () => ({ sdf: seahorseSDF(buildSpine()), box: [-0.65, 0.75, -0.85, 1.1, -0.3, 0.3], exclude: EYES.map((e) => [...e, 0.045]),
    bias: [0.5, -0.15, 0.25], head: [-0.06, 0.78, 0] }),
  hippo: () => ({ sdf: hippoSDF(), box: [-0.9, 0.9, -1.1, 0.4, -1.3, 1.5], exclude: [1, -1].map((s) => [s * HEAD.eyeball[0], HEAD.eyeball[1], HEAD.eyeball[2], HEAD.eyeball[3] + 0.02]),
    bias: [0.15, -0.6, 0.1], head: [0, 0.05, 0.6] }),
};

// ---------- sampling ----------

export function sample(p, form) {
  const rand = rng(+p.seed), n = +p.n, ln2h = Math.LN2 / +p.half, eps = +p.eps, shell = +p.shell, t0 = +p.t0, drift = +p.drift;
  const { sdf, box, exclude, bias } = form;
  const pos = new Float32Array(n * 3), size = new Float32Array(n), tt = new Float32Array(n), kind = new Float32Array(n), seed = new Float32Array(n);
  let i = 0, tries = 0;
  while (i < n && tries < n * 400) {
    tries++;
    let x = box[0] + rand() * (box[1] - box[0]), y = box[2] + rand() * (box[3] - box[2]), z = box[4] + rand() * (box[5] - box[4]);
    const [d, t] = sdf(x, y, z);
    const onShell = rand() < shell;
    if (onShell ? Math.abs(d) > eps : d > 0) continue;
    // Density bands along the trunk read as the seahorse's bony plates; radius wobble was invisible in particles.
    const band = t > 0.1 ? 1 - +p.rings * (0.5 - 0.5 * Math.cos(t * Math.PI * 2 * +p.nrings)) : 1;
    if (rand() > Math.exp(-t * ln2h) * band) continue;
    if (exclude.some(([cx, cy, cz, r]) => Math.hypot(x - cx, y - cy, z - cz) < r)) continue;
    let drifted = 0;
    if (t > t0) {
      const r = rand(), m = Math.pow((t - t0) / (1 - t0), 1.5) * drift * r * r * (rand() < +p.far ? 2.5 : 1);
      const dx = rand() - 0.5 + bias[0], dy = rand() - 0.5 + bias[1], dz = rand() - 0.5 + bias[2], l = Math.hypot(dx, dy, dz);
      x += (dx / l) * m; y += (dy / l) * m; z += (dz / l) * m; drifted = m > 0.03 ? 1 : 0;
    }
    const j = +p.jitter;
    pos[i * 3] = x + (rand() - 0.5) * j; pos[i * 3 + 1] = y + (rand() - 0.5) * j; pos[i * 3 + 2] = z + (rand() - 0.5) * j;
    size[i] = +p.psize * (0.6 + 0.8 * rand()) * (drifted ? 0.7 : 1) * (onShell ? 1 : 0.8);
    tt[i] = t; kind[i] = t > t0 && rand() < +p.amber ? 1 : 0; seed[i] = rand();
    i++;
  }
  return { pos: pos.subarray(0, i * 3), size: size.subarray(0, i), tt: tt.subarray(0, i), kind: kind.subarray(0, i), seed: seed.subarray(0, i), count: i };
}

// ---------- particle material: soft additive discs with an in-shader circle of confusion ----------

const VERT = /* glsl */`
attribute float aSize, aT, aKind, aSeed;
uniform float uScale, uFocus, uAperture;
varying float vT, vKind, vSeed, vFade;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = -mv.z;
  float coc = abs(depth - uFocus) * uAperture;
  float r = sqrt(aSize * aSize + coc * coc);
  gl_PointSize = max(1.5, 2.0 * r * uScale / depth);
  vFade = (aSize * aSize) / (r * r);
  vT = aT; vKind = aKind; vSeed = aSeed;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
uniform vec3 uMint, uCore, uAsh, uAmber; uniform float uGain, uCoreMix, uAshMix;
varying float vT, vKind, vSeed, vFade;
void main() {
  vec2 q = gl_PointCoord - 0.5; float d2 = dot(q, q) * 4.0;
  if (d2 > 1.0) discard;
  float a = exp(-d2 * 3.0) * (1.0 - d2);
  float head = 1.0 - smoothstep(0.0, 0.35, vT);
  vec3 col = mix(uMint, uCore, head * step(0.6, vSeed) * uCoreMix);
  col = mix(col, uAsh, smoothstep(0.55, 1.0, vT) * uAshMix);
  col = mix(col, uAmber, vKind);
  float b = 1.0 - 0.55 * smoothstep(0.5, 1.0, vT);
  gl_FragColor = vec4(col * a * vFade * b * uGain, 1.0);
}`;

export function makePoints(p, s, size, focus) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(s.pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(s.size, 1));
  geo.setAttribute('aT', new THREE.BufferAttribute(s.tt, 1));
  geo.setAttribute('aKind', new THREE.BufferAttribute(s.kind, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(s.seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uScale: { value: size / (2 * Math.tan(THREE.MathUtils.degToRad(+p.fov) / 2)) }, uFocus: { value: focus }, uAperture: { value: +p.aperture },
      uMint: { value: new THREE.Color(MINT) }, uCore: { value: new THREE.Color('#d9ffe3') }, uAsh: { value: new THREE.Color('#8a968e') }, uAmber: { value: new THREE.Color(AMBER) },
      uGain: { value: +p.gain }, uCoreMix: { value: +p.core }, uAshMix: { value: +p.ash },
    },
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  });
  return new THREE.Points(geo, mat);
}

// Faint mint haze behind the head so the figure sits in a space rather than on flat black.
function haze(k, at) {
  const c = document.createElement('canvas'), N = 256;
  c.width = c.height = N;
  const g = c.getContext('2d'), grad = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grad.addColorStop(0, `rgba(124,227,139,${k})`); grad.addColorStop(0.5, `rgba(124,227,139,${k * 0.25})`); grad.addColorStop(1, 'rgba(124,227,139,0)');
  g.fillStyle = grad; g.fillRect(0, 0, N, N);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.position.set(at[0], at[1], at[2] - 1.2);
  return m;
}

export function createScene(renderer, size, q = {}) {
  const p = { ...DEFAULTS, ...q }, alpha = !!+p.alpha;
  renderer.toneMapping = p.tm === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NeutralToneMapping;
  renderer.toneMappingExposure = +p.exposure;
  renderer.setClearColor(p.bg || INK, alpha ? 0 : 1);

  const scene = new THREE.Scene();
  scene.background = alpha ? null : new THREE.Color(p.bg || INK);
  const camera = new THREE.PerspectiveCamera(+p.fov, 1, 0.1, 100);
  const yaw = THREE.MathUtils.degToRad(+p.yaw), pitch = THREE.MathUtils.degToRad(+p.pitch), d = +p.dist;
  const target = new THREE.Vector3(+p.tx, +p.ty, +p.tz);
  camera.position.set(d * Math.sin(yaw) * Math.cos(pitch), d * Math.sin(pitch), d * Math.cos(yaw) * Math.cos(pitch)).add(target);
  camera.lookAt(target);

  const form = FORMS[p.form]();
  const s = sample(p, form);
  const focus = p.focus === 'head' ? camera.position.distanceTo(new THREE.Vector3(...form.head)) : +p.focus;
  scene.add(makePoints(p, s, size, focus));
  if (+p.haze && !alpha) scene.add(haze(+p.haze, form.head));

  const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, samples: 0 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  if (+p.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(size, size), 0.45 * +p.bloom, 0.6, 0.55));
  composer.addPass(new OutputPass());
  return { scene, camera, composer, count: s.count, render: () => composer.render() };
}

export function paramsFrom(search) {
  const q = {};
  for (const [k, v] of new URLSearchParams(search)) q[k] = v;
  return q;
}
