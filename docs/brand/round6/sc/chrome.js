// Liquid chrome: memory as a metaball liquid. A droplet morphing into a hippo head, or a frozen crown splash.
import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { INK, MINT, MINT_LIGHT, gradPanel, pmrem, backdrop, orbitCamera, makeComposer } from './common.js';

const D = {
  form: 'hippo', res: 120, morph: 1, scale: 1.7, yaw: 35, pitch: 8, fov: 30, dist: 7.5, look: 0,
  irid: 1, rough: 0.05, ior: 1.3, film0: 100, film1: 400, tint: '#ffffff',
  env: 'acid', envk: 1, bg: 'env', blur: 0.35, bgk: 0.5, bloom: 0.1, alpha: 0, floor: 0, exposure: 1, tone: 'agx', rect: 0, sub: 30, mouth: 1, amber: 0.3,
  puddle: 0, eyeLift: 0, jawGap: 0.06, tail: 0, top: 4, ring: 0.19, ringR: 0.82, ringY: -0.16, card: '#0f3a20',
};

const ISO = 80;
let SUB = 12; // higher = tighter blending between balls; set per render from p.sub

// r is the visible radius in mesh units (-1..1); strength solves strength/d^2 - subtract = isolation. Negative r carves.
function addBall(mc, x, y, z, r) {
  if (r === 0) return;
  const d = Math.abs(r) / 2;
  mc.addBall(0.5 + x / 2, 0.5 + y / 2, 0.5 + z / 2, Math.sign(r) * d * d * (SUB + ISO), SUB);
}

// Head axis +x. The muzzle is the biggest mass (a hippo's is wider than its skull); eyes and ears ride on top at the back.
const HIPPO = [
  [0.42, -0.04, 0, 0.36], [0.42, -0.06, 0.24, 0.3], [0.42, -0.06, -0.24, 0.3],       // muzzle barrel
  [0.66, 0.0, 0.17, 0.24], [0.66, 0.0, -0.17, 0.24], [0.66, -0.16, 0, 0.26],          // boxy front, lower lip
  [0.78, 0.14, 0.12, 0.085], [0.78, 0.14, -0.12, 0.085],                               // nostril mounds
  [0.38, -0.32, 0.16, 0.22], [0.38, -0.32, -0.16, 0.22], [0.6, -0.3, 0, 0.2],         // jaw
  [-0.06, 0.12, 0, 0.36], [-0.06, 0.08, 0.2, 0.28], [-0.06, 0.08, -0.2, 0.28],         // cranium
  [0.14, 0.36, 0.3, 0.1], [0.14, 0.36, -0.3, 0.1],                                     // eyes
  [-0.26, 0.42, 0.22, 0.085], [-0.26, 0.42, -0.22, 0.085],                             // ears
  [-0.46, -0.1, 0, 0.32], [-0.62, -0.26, 0, 0.26],                                     // neck trailing off
];
const MOUTH = [];
for (let i = 0; i <= 9; i++) { const x = 0.76 - i * 0.075; MOUTH.push([x, -0.17, 0.5 - 0.02 * i, -0.07], [x, -0.17, -0.5 + 0.02 * i, -0.07]); }
for (let i = -2; i <= 2; i++) MOUTH.push([0.9, -0.17, i * 0.14, -0.07]);
const DROP = [[0, -0.05, 0, 0.62]];
const TAIL = [[-0.1, 0.5, 0, 0.14], [-0.08, 0.66, 0, 0.08], [-0.06, 0.78, 0, 0.04]];
const SATELLITES = [[0.6, 0.6, 0.35, 0.06], [-0.6, 0.5, -0.3, 0.045], [0.45, -0.62, 0.15, 0.06], [0.5, -0.78, 0.18, 0.03], [-0.35, -0.68, 0.3, 0.045]];

function hippoField(mc, t, mouth, k = 0.82) {
  for (const [x, y, z, r] of HIPPO) addBall(mc, x * k, y * k, z * k, r * k * t);
  if (mouth) for (const [x, y, z, r] of MOUTH) addBall(mc, x * k, y * k, z * k, r * k * t);
  for (const [x, y, z, r] of DROP) addBall(mc, x * k, y * k, z * k, (r * (1 - t) + 0.1 * t) * k);
  for (const [x, y, z, r] of [...TAIL, ...SATELLITES]) addBall(mc, x * k, y * k, z * k, r * k);
}

// Full head as two masses: the mouth is the pinch where the upper muzzle and the jaw fail to merge.
const HEAD_UP = [
  [0.42, 0.02, 0, 0.36], [0.42, 0.0, 0.24, 0.3], [0.42, 0.0, -0.24, 0.3], [0.66, 0.04, 0.17, 0.25], [0.66, 0.04, -0.17, 0.25],
  [0.78, 0.2, 0.12, 0.085], [0.78, 0.2, -0.12, 0.085],
  [-0.06, 0.16, 0, 0.36], [-0.06, 0.12, 0.2, 0.28], [-0.06, 0.12, -0.2, 0.28],
  [0.14, 0.42, 0.3, 0.1], [0.14, 0.42, -0.3, 0.1], [-0.26, 0.48, 0.22, 0.085], [-0.26, 0.48, -0.22, 0.085],
  [-0.46, 0.0, 0, 0.32], [-0.58, -0.2, 0, 0.24],
];
const HEAD_JAW = [[0.42, -0.5, 0, 0.25], [0.42, -0.5, 0.18, 0.21], [0.42, -0.5, -0.18, 0.21], [0.64, -0.46, 0, 0.21], [0.05, -0.48, 0, 0.25]];
const HEAD_DRIPS = [[0.3, -0.8, 0.1, 0.05], [0.32, -0.9, 0.1, 0.028], [-0.35, 0.7, 0.2, 0.05], [0.7, 0.55, -0.3, 0.04]];

const HEAD_TAIL = [[-0.2, 0.62, 0, 0.13], [-0.18, 0.78, 0, 0.075], [-0.16, 0.9, 0, 0.04]];

function headField(mc, jawGap, tail, k = 0.82) {
  for (const [x, y, z, r] of HEAD_UP) addBall(mc, x * k, y * k, z * k, r * k);
  for (const [x, y, z, r] of HEAD_JAW) addBall(mc, x * k, (y - jawGap) * k, z * k, r * k);
  for (const [x, y, z, r] of HEAD_DRIPS) addBall(mc, x * k, y * k, z * k, r * k);
  if (tail) for (const [x, y, z, r] of HEAD_TAIL) addBall(mc, x * k, y * k, z * k, r * k);
}

// Hippo surfacing: only what a real hippo shows above water. Water plane sits at y = -0.56.
const SURF = [
  [0.3, -0.86, 0, 0.42], [0.3, -0.86, 0.26, 0.36], [0.3, -0.86, -0.26, 0.36], [0.58, -0.84, 0.16, 0.32], [0.58, -0.84, -0.16, 0.32],
  [0.7, -0.5, 0.13, 0.09], [0.7, -0.5, -0.13, 0.09],
  [-0.05, -0.74, 0, 0.36], [-0.05, -0.74, 0.18, 0.3], [-0.05, -0.74, -0.18, 0.3],
  [0.05, -0.44, 0.33, 0.13], [0.05, -0.44, -0.33, 0.13],
  [-0.3, -0.38, 0.25, 0.09], [-0.3, -0.38, -0.25, 0.09],
  [-0.5, -0.8, 0, 0.34],
];
const WATER = -0.56;

function surfaceField(mc, puddle, eyeLift) {
  if (puddle) {
    // Round puddle for the transparent mark: a dense hex disc of submerged balls instead of the infinite plane.
    for (let ring = 0; ring <= 5; ring++) {
      const n = ring === 0 ? 1 : ring * 6, rad = ring * 0.15;
      for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; addBall(mc, 0.05 + rad * Math.cos(a), -0.93, rad * Math.sin(a), 0.36); }
    }
  } else mc.addPlaneY(4.4, SUB);
  for (const [x, y, z, r] of SURF) addBall(mc, x, y + (r < 0.14 ? eyeLift : 0), z, r);
  if (!puddle) for (let k = 0; k < 44; k++) { const a = (k / 44) * Math.PI * 2; addBall(mc, 0.1 + 0.82 * Math.cos(a), -0.72, 0.82 * Math.sin(a), 0.17); }
  addBall(mc, 0.62, 0.0, 0.42, 0.085);
  addBall(mc, 0.6, -0.3, 0.44, 0.04);
}

// Milk-crown splash: pool plane, a continuous rim, thin leaning spikes of uneven height with detached tips, a drop still falling.
// The crown is a thin flared sheet (dense rings of small balls per level), scalloped at the rim, tips thrown off as drops.
function splashField(mc, ring, ringR, ringY) {
  mc.addPlaneY(4.4, SUB);
  const y0 = -0.56, tips = 14, levels = 9, H = 0.5;
  for (let l = 0; l <= levels; l++) {
    const u = l / levels, rad = 0.36 + 0.2 * u * u, y = y0 + 0.02 + H * u, n = 56, rb = 0.085 - 0.035 * u;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, scallop = u > 0.7 ? 0.5 + 0.5 * Math.cos(a * tips) : 1;
      if (u > 0.7 && scallop < (u - 0.7) / 0.3) continue;
      addBall(mc, rad * Math.cos(a), y, rad * Math.sin(a), rb);
    }
  }
  for (let k = 0; k < tips; k++) {
    const a = (k / tips) * Math.PI * 2, h = 0.08 + 0.1 * (0.5 + 0.5 * Math.sin(k * 2.9 + 1)), rad = 0.57 + 0.03 * Math.sin(k * 1.3);
    for (let s = 0; s <= 3; s++) { const v = s / 3; addBall(mc, (rad + 0.04 * v) * Math.cos(a), y0 + 0.02 + H + h * v, (rad + 0.04 * v) * Math.sin(a), 0.05 - 0.02 * v); }
    if (k % 3 !== 1) addBall(mc, (rad + 0.08) * Math.cos(a), y0 + 0.02 + H + h + 0.09 + 0.05 * Math.sin(k), (rad + 0.08) * Math.sin(a), 0.04 + 0.012 * Math.sin(k * 2));
  }
  addBall(mc, 0.02, y0 + 1.0, 0, 0.1);
  addBall(mc, -0.04, y0 + 1.3, 0.03, 0.045);
  for (let k = 0; k < 64; k++) { const a = (k / 64) * Math.PI * 2; addBall(mc, ringR * Math.cos(a), y0 + ringY, ringR * Math.sin(a), ring); }
}

function acidEnv(renderer, k, amber, top) {
  const s = new THREE.Scene();
  if (amber) gradPanel(s, 8, 0.12, [[0, '#f2b84b'], [1, '#f2b84b']], 8 * amber, [4, 1.2, -7]);
  s.background = new THREE.Color('#000000');
  gradPanel(s, 12, 1.6, [[0, '#ffffff'], [1, '#d8ffe0']], top * k, [0, 7, 1.5]);
  gradPanel(s, 4, 10, [[0, '#ffffff'], [0.45, MINT], [1, '#02140a']], 3 * k, [-8, 1, 3]);
  gradPanel(s, 4, 10, [[0, '#0b3d1f'], [1, MINT]], 2 * k, [8, 0, -2]);
  gradPanel(s, 16, 9, [[0, '#062012'], [0.5, '#000000'], [1, '#0f5a2a']], 1.2 * k, [0, 0, -9]);
  gradPanel(s, 16, 16, [[0, MINT], [1, '#03130a']], 2 * k, [0, -7, 0]);
  gradPanel(s, 10, 6, [[0, '#000000'], [1, '#123a22']], 1 * k, [0, 0, 9]);
  gradPanel(s, 12, 0.22, [[0, '#ffffff'], [1, '#ffffff']], 9 * k, [0, 2.6, -6]);
  gradPanel(s, 0.2, 9, [[0, '#ffffff'], [1, '#ffffff']], 7 * k, [-5, 0, 6]);
  gradPanel(s, 10, 0.16, [[0, '#ffffff'], [1, '#ffffff']], 6 * k, [3, -2.2, 6]);
  return pmrem(renderer, s);
}

export async function createScene(renderer, size, q = {}) {
  const p = { ...D, ...q };
  const alpha = +p.alpha === 1;
  RectAreaLightUniformsLib.init();
  renderer.toneMapping = p.tone === 'neutral' ? THREE.NeutralToneMapping : THREE.AgXToneMapping;
  renderer.toneMappingExposure = +p.exposure;
  renderer.setClearColor(INK, alpha ? 0 : 1);

  const scene = new THREE.Scene();
  const env = acidEnv(renderer, +p.envk, +p.amber, +p.top);
  scene.environment = env;

  const mat = new THREE.MeshPhysicalMaterial({
    color: p.tint, metalness: 1, roughness: +p.rough, iridescence: +p.irid, iridescenceIOR: +p.ior,
    iridescenceThicknessRange: [+p.film0, +p.film1], envMapIntensity: 1,
  });
  SUB = +p.sub;
  const mc = new MarchingCubes(+p.res, mat, false, false, 600000);
  mc.isolation = ISO;
  const pooled = (p.form === 'splash' || p.form === 'surface') && !+p.puddle;
  if (p.form === 'splash') splashField(mc, +p.ring, +p.ringR, +p.ringY);
  else if (p.form === 'surface') surfaceField(mc, +p.puddle, +p.eyeLift);
  else if (p.form === 'head') headField(mc, +p.jawGap, +p.tail);
  else hippoField(mc, +p.morph, +p.mouth);
  mc.update();
  mc.scale.setScalar(+p.scale);
  scene.add(mc);
  if (pooled) {
    // Same chrome under the field cube so the pool runs to the frame edge instead of ending at the cube wall.
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2), mat);
    pool.position.y = -0.575 * +p.scale; scene.add(pool);
  }

  const camera = orbitCamera(+p.fov, +p.yaw, +p.pitch, +p.dist, +p.look * +p.scale);
  if (!alpha) {
    if (p.bg === 'env') { scene.background = env; scene.backgroundBlurriness = +p.blur; scene.backgroundIntensity = +p.bgk; }
    else if (p.bg === 'card') scene.add(backdrop(80, 40, camera, p.card, INK, 0.4));
    if (+p.floor) {
      // Mirror floor: the classic chrome-on-black album cover; sits just under the lowest drip.
      const y = p.form === 'splash' ? -0.56 * +p.scale : -0.85 * +p.scale;
      const mirror = new Reflector(new THREE.PlaneGeometry(60, 60), { color: p.form === 'splash' ? '#9a9a9a' : '#3a3a3a', textureWidth: size, textureHeight: size, clipBias: 0.003 });
      mirror.rotation.x = -Math.PI / 2; mirror.position.y = y; mirror.userData.noAO = true;
      scene.add(mirror);
    }
  }
  if (+p.rect) {
    const key = new THREE.RectAreaLight('#ffffff', +p.rect, 4, 1.2);
    key.position.set(-2, 4, 3); key.lookAt(0, 0, 0); scene.add(key);
  }
  return makeComposer(renderer, scene, camera, size, { bloom: +p.bloom, bloomThreshold: 0.95, alpha });
}
