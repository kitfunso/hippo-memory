// Ripples from recall points, amplitude halving every half-life, summed into a line sculpture or a corrugated relief.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const hex = (h) => new THREE.Color(h).convertSRGBToLinear();
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const INK = '#0b0f0c', BONE = '#e9efe9', MINT = '#7ce38b';

export function field(q, num) {
  const src = (q.src || '-0.45,-0.3,0;0.5,0.15,0;-0.1,0.6,0').split(';').map((s) => s.split(',').map(Number));
  const lam = num('lam', 0.16), hl = num('hl', 0.4);
  const waves = (x, z) => src.map(([sx, sz, ph = 0, a = 1]) => {
    const r = Math.hypot(x - sx, z - sz), A = a * Math.pow(0.5, r / hl);
    return [A, Math.cos(2 * Math.PI * r / lam + ph)];
  });
  const F = (x, z) => waves(x, z).reduce((s, [A, c]) => s + A * c, 0);
  // Recalled points: the strongest local maxima of F where two crests coincide, kept apart so they never pair up as eyes.
  const N = 240, R = num('gr', 0.85), g = (i) => -R + (2 * R * i) / N, pk = [];
  for (let j = 1; j < N; j++) for (let i = 1; i < N; i++) {
    const v = F(g(i), g(j));
    let top = true;
    for (let y = -1; y <= 1 && top; y++) for (let x = -1; x <= 1; x++) if ((x || y) && F(g(i + x), g(j + y)) > v) { top = false; break; }
    const w = waves(g(i), g(j)).map(([A]) => A).sort((a, b) => b - a);
    if (top) pk.push([g(i), g(j), v * Math.min(1, w[1] / (w[0] * num('bal', 0.5)))]);
  }
  pk.sort((a, b) => b[2] - a[2]);
  const pts = [];
  for (const p of pk) if (pts.length < num('glowk', 3) && pts.every((o) => Math.hypot(o[0] - p[0], o[1] - p[1]) > num('gsp', 0.5))) pts.push(p);
  console.log('recalled', JSON.stringify(pts.map((p) => p.map((x) => +x.toFixed(3)))));
  const s = num('gs', 0.04);
  F.reinforce = (x, z) => pts.reduce((m, [px, pz]) => Math.max(m, Math.exp(-((x - px) ** 2 + (z - pz) ** 2) / (2 * s * s))), 0);
  return F;
}

class Line extends THREE.Curve {
  constructor(fn) { super(); this.fn = fn; }
  getPoint(t, out = new THREE.Vector3()) { return out.copy(this.fn(t)); }
}

function glowShader(mat, strength) { // per-vertex mint glow without a texture
  mat.onBeforeCompile = (s) => {
    s.vertexShader = 'attribute float glow;\nvarying float vGlow;\n' + s.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = glow;');
    s.fragmentShader = 'varying float vGlow;\n' + s.fragmentShader.replace('#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(0.202, 0.768, 0.258) * vGlow * ${strength.toFixed(3)};`);
  };
}

function paint(geo, F, gth, gw, xz) {
  const p = geo.attributes.position, n = p.count, col = new Float32Array(n * 3), glow = new Float32Array(n);
  const bone = hex(q_bone), mint = hex(MINT), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const [x, z] = xz(p, i), g = smooth(gth, gth + gw, F.reinforce(x, z));
    c.copy(bone).lerp(mint, g * 0.85);
    col.set([c.r, c.g, c.b], 3 * i); glow[i] = g;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('glow', new THREE.BufferAttribute(glow, 1));
}
let q_bone = BONE;

function lines(q, num, F) {
  const L = num('lines', 90), E = num('ext', 1), tr = num('tr', 0.006), off = num('off', 0.035), rh = num('rh', 0.03);
  const disc = q.shape === 'disc', segs = num('segs', 900);
  const geos = [];
  for (let i = 0; i < L; i++) {
    const z0 = -E + (2 * E * (i + 0.5)) / L;
    const half = disc ? Math.sqrt(Math.max(0, E * E - z0 * z0)) : E;
    if (half < 3 * tr) continue;
    const fn = (t) => { const x = -half + 2 * half * t, f = F(x, z0); return new THREE.Vector3(x, tr + rh * (f + 1.5), z0 + off * f); };
    const g = new THREE.TubeGeometry(new Line(fn), Math.max(8, Math.round(segs * half / E)), tr, num('rad', 10), false);
    g.userData.z0 = z0; // colour follows the lane's field, not the bent position
    geos.push(g);
  }
  geos.forEach((g) => paint(g, F, num('gth', 0.3), num('gw', 0.15), (p, k) => [p.getX(k), g.userData.z0]));
  return mergeGeometries(geos);
}

function relief(q, num, F) {
  const W = 2 * num('ext', 1), M = num('m', 1600), p0 = num('per', 0.05), K = num('k', 2.2), rh = num('rh', 0.02);
  const g = new THREE.PlaneGeometry(W, W, M, M), p = g.attributes.position, crest = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) { // Riley corrugation whose phase the ripple field bends
    const x = p.getX(i), z = -p.getY(i), f = F(x, z), e = num('edge', 0.25);
    if (q.rings) { // the rings themselves: crests in bone, fading to ink as the amplitude halves away
      crest[i] = smooth(e, e + num('soft', 0.02), f); p.setZ(i, rh * (q.hmode === 'crest' ? crest[i] : f)); continue;
    }
    const c = Math.cos(2 * Math.PI * (z / p0) + K * f);
    p.setZ(i, rh * (0.5 + 0.5 * c));
    crest[i] = smooth(-e, e, c);
  }
  g.computeVertexNormals();
  g.rotateX(-Math.PI / 2);
  paint(g, F, num('gth', 0.3), num('gw', 0.15), (pp, k) => [pp.getX(k), pp.getZ(k)]);
  const col = g.attributes.color, glow = g.attributes.glow, ink = hex(INK), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) { // ink troughs, bone crests, mint only on reinforced crests
    c.setRGB(col.getX(i), col.getY(i), col.getZ(i)).lerp(ink, 1 - crest[i]);
    col.setXYZ(i, c.r, c.g, c.b); glow.setX(i, glow.getX(i) * crest[i]);
  }
  if (q.shape === 'disc') { // keep only triangles inside the coin
    const R = W / 2, idx = g.index.array, keep = [], inside = (v) => Math.hypot(p.getX(v), p.getZ(v)) < R;
    for (let t = 0; t < idx.length; t += 3) if (inside(idx[t]) && inside(idx[t + 1]) && inside(idx[t + 2])) keep.push(idx[t], idx[t + 1], idx[t + 2]);
    g.setIndex(keep);
  }
  return g;
}

export function build(renderer, SIZE, q, num) {
  const F = field(q, num), alpha = !!num('alpha', 0);
  q_bone = q.bone ? '#' + q.bone : BONE;
  const scene = new THREE.Scene();
  if (!alpha) scene.background = hex(INK);
  const geo = q.mode === 'relief' ? relief(q, num, F) : lines(q, num, F);
  const mat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: num('rough', 0.45), clearcoat: num('cc', 0.3), clearcoatRoughness: 0.35 });
  glowShader(mat, num('ei', 1.6));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  if (q.mode === 'relief' && q.shape === 'disc') {
    const T = num('thick', 0.08), E = num('ext', 1);
    const coin = new THREE.Mesh(new THREE.CylinderGeometry(E, E, T, 256), new THREE.MeshPhysicalMaterial({ color: hex(INK), roughness: 0.6 }));
    coin.position.y = -T / 2 - 0.0005; coin.castShadow = coin.receiveShadow = true;
    scene.add(coin);
  }
  if (!alpha && q.mode !== 'relief') {
    const E = num('ext', 1);
    const ground = new THREE.Mesh(q.shape === 'disc' ? new THREE.CircleGeometry(E * 1.02, 256) : new THREE.PlaneGeometry(2 * E + 0.06, 2 * E + 0.06),
      new THREE.MeshPhysicalMaterial({ color: hex('#' + (q.gc || '101512')), roughness: 0.8 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    scene.add(ground);
  }

  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = num('env', 0.3);
  const el = num('el', 35) * Math.PI / 180, az = num('az', 135) * Math.PI / 180;
  const sun = new THREE.DirectionalLight(0xffffff, num('sun', 3.5));
  sun.position.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).multiplyScalar(6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -1.6, right: 1.6, top: 1.6, bottom: -1.6, near: 0.5, far: 14 });
  sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.002; sun.shadow.radius = num('sr', 2);
  scene.add(sun);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = num('exp', 1);
  if (alpha) renderer.setClearColor(0x000000, 0);

  const pitch = num('pitch', 90) * Math.PI / 180, yaw = num('yaw', 0) * Math.PI / 180, dist = num('dist', 6.4);
  const cam = new THREE.PerspectiveCamera(num('fov', 20), 1, 0.1, 60);
  const tgt = new THREE.Vector3(num('tx', 0), 0, num('tz', 0));
  cam.position.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(dist).add(tgt);
  if (num('pitch', 90) > 89.9) cam.up.set(0, 0, -1);
  cam.lookAt(tgt);
  if (num('roll', 0)) cam.rotateZ(num('roll', 0) * Math.PI / 180);

  if (alpha || num('bloom', 0.4) <= 0) return () => renderer.render(scene, cam);
  const comp = new EffectComposer(renderer, new THREE.WebGLRenderTarget(SIZE, SIZE, { type: THREE.HalfFloatType, samples: 4 }));
  comp.setPixelRatio(1); comp.setSize(SIZE, SIZE);
  comp.addPass(new RenderPass(scene, cam));
  comp.addPass(new UnrealBloomPass(new THREE.Vector2(SIZE, SIZE), num('bloom', 0.4), 0.5, num('bth', 0.8)));
  comp.addPass(new OutputPass());
  return () => comp.render();
}
