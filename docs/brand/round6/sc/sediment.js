// Sediment: memory as geological strata. Slab thickness halves every `half` layers down the stack; one layer is recalled.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { INK, MINT, MINT_LIGHT, noiseCanvas, tex, gradPanel, pmrem, backdrop, makeComposer, rnd } from './common.js';

const D = {
  form: 'mono', n: 32, t0: 0.3, half: 7, w: 1.1, d: 0.85, recall: 6, slide: 0.2, gap: 0.004, jitter: 0.03, relief: 1,
  yaw: 32, pitch: 0, fov: 24, dist: 10, look: 0.42, iso: 0, zoom: 1,
  sun: 3.5, sunx: -0.45, suny: 0.6, sunz: 0.65, sunCol: '#ffd6a6', slot: 1, slotW: 0.8, slotH: 6, slotRot: -25, slotOff: 0,
  amb: 0.1, ambCol: '#33424a', env: 0.6, glow: 5, coreW: 0.6, frost: 0.45, spill: 0, rim: 0, ao: 0.8, bloom: 0.15, alpha: 0, wall: 1, floor: 1, wallZ: -1.3,
  exposure: 0.85, tone: 'agx', beam: 0, seq: 'a',
};
// Proud or recessed per material so raking light throws real relief (steel shims sit back, stone sits proud).
const RELIEF = { concrete: 0, travertine: 0.02, steel: -0.05, smoked: -0.03, recalled: 0 };

const SEQ = {
  a: ['concrete', 'travertine', 'concrete', 'steel', 'smoked', 'concrete', 'travertine', 'concrete', 'steel', 'travertine', 'smoked', 'concrete'],
  b: ['concrete', 'concrete', 'travertine', 'steel', 'concrete', 'smoked', 'concrete', 'concrete', 'steel', 'travertine', 'concrete', 'concrete'],
  c: ['travertine', 'concrete', 'steel', 'travertine', 'travertine', 'smoked', 'concrete', 'travertine', 'steel', 'concrete'],
};

// Planar uv from the dominant normal axis so stone grain reads at one world scale on every face.
function worldUV(geo, yOff = 0, s = 1) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal, uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i));
    let u, v;
    if (ny >= nx && ny >= nz) { u = pos.getX(i); v = pos.getZ(i) + yOff; }
    else if (nx >= nz) { u = pos.getZ(i); v = pos.getY(i) + yOff; }
    else { u = pos.getX(i); v = pos.getY(i) + yOff; }
    uv[2 * i] = u * s; uv[2 * i + 1] = v * s;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

// Ando concrete: grain, faint formwork panel seams on a 1.6 unit grid, and tie holes at the panel corners.
function andoCanvas(noise) {
  const c = document.createElement('canvas'); c.width = c.height = 2048;
  const g = c.getContext('2d');
  g.fillStyle = '#9a9c98'; g.fillRect(0, 0, 2048, 2048);
  g.globalAlpha = 0.5; g.drawImage(noise, 0, 0, 2048, 2048); g.globalAlpha = 1;
  g.globalAlpha = 0.25; g.drawImage(noise, 0, 0, 512, 512, 0, 0, 2048, 2048); g.globalAlpha = 1;
  const P = 2048 / 2.5;
  g.strokeStyle = 'rgba(40,40,38,0.45)'; g.lineWidth = 3;
  for (let i = 0; i <= 3; i++) { g.beginPath(); g.moveTo(i * P, 0); g.lineTo(i * P, 2048); g.moveTo(0, i * P); g.lineTo(2048, i * P); g.stroke(); }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const x = i * P + P * 0.18, y = j * P + P * 0.18;
    for (const [dx, dy] of [[0, 0], [P * 0.64, 0], [0, P * 0.64], [P * 0.64, P * 0.64]]) {
      g.fillStyle = 'rgba(30,30,28,0.9)'; g.beginPath(); g.arc(x + dx, y + dy, 11, 0, 6.283); g.fill();
      g.fillStyle = 'rgba(200,200,196,0.5)'; g.beginPath(); g.arc(x + dx, y + dy + 4, 11, 0, 3.14); g.fill();
    }
  }
  return c;
}

function materials() {
  const noise = noiseCanvas(1024, 5, 8);
  const grain = tex(noise, false, 0.9);
  const concrete = new THREE.MeshPhysicalMaterial({ color: '#8a8c88', roughness: 0.92, roughnessMap: grain, bumpMap: grain, bumpScale: 0.01, envMapIntensity: 0.35 });
  const ando = tex(andoCanvas(noise), true, 0.4);
  const wallcrete = new THREE.MeshPhysicalMaterial({ color: '#9a9a96', map: ando, roughness: 0.95, bumpMap: ando, bumpScale: 0.02, envMapIntensity: 0.25 });
  const tc = document.createElement('canvas'); tc.width = tc.height = 1024;
  const g = tc.getContext('2d');
  g.fillStyle = '#d9cfbc'; g.fillRect(0, 0, 1024, 1024);
  for (let y = 0; y < 1024; y += 2) {
    const v = 0.5 + 0.5 * Math.sin(y * 0.06 + 2.5 * Math.sin(y * 0.013));
    g.fillStyle = `rgba(110,90,70,${0.14 * v})`; g.fillRect(0, y, 1024, 2);
  }
  g.globalAlpha = 0.22; g.drawImage(noise, 0, 0); g.globalAlpha = 1;
  for (let i = 0; i < 1400; i++) {
    const x = rnd() * 1024, y = rnd() * 1024, r = 0.8 + rnd() * 4;
    g.fillStyle = `rgba(60,48,36,${0.3 + 0.5 * rnd()})`; g.beginPath(); g.ellipse(x, y, r * 2.2, r * 0.5, 0, 0, 6.283); g.fill();
  }
  const trav = tex(tc, true, 0.8);
  const travertine = new THREE.MeshPhysicalMaterial({ map: trav, roughness: 0.5, bumpMap: trav, bumpScale: 0.008, clearcoat: 0.2, clearcoatRoughness: 0.35, envMapIntensity: 0.6 });
  const steel = new THREE.MeshPhysicalMaterial({ color: '#c8cbc7', metalness: 1, roughness: 0.3, anisotropy: 0.95, envMapIntensity: 1.3 });
  const smoked = new THREE.MeshPhysicalMaterial({ color: '#ffffff', transmission: 1, roughness: 0.08, thickness: 0.5, ior: 1.5, attenuationColor: '#3a423c', attenuationDistance: 0.6, envMapIntensity: 1.4 });
  const recalled = (frost) => new THREE.MeshPhysicalMaterial({ color: '#edfff1', transmission: 1, roughness: frost, thickness: 0.5, ior: 1.48, attenuationColor: MINT_LIGHT, attenuationDistance: 1.4, envMapIntensity: 1 });
  const core = (k) => new THREE.MeshStandardMaterial({ color: MINT, emissive: MINT, emissiveIntensity: k, roughness: 1 });
  return { concrete, wallcrete, travertine, steel, smoked, recalled, core };
}

// Top-down list of bands; thickness follows t0 * 2^(-i/half) so old memory is compressed thin.
function bands(p, total = null) {
  const out = [];
  let top = 0;
  for (let i = 0; i < 400; i++) {
    const t = +p.t0 * Math.pow(2, -i / +p.half);
    if (t < 0.01) break;
    if (total === null && i >= +p.n) break;
    if (total !== null && top >= total) break;
    const tt = total === null ? t : Math.min(t, total - top);
    out.push({ i, y1: -top, y0: -top - tt, t: tt });
    top += tt;
  }
  const H = top;
  for (const b of out) { b.y0 += H; b.y1 += H; }
  return { list: out, H };
}

// Letter h in section: x-spans of the glyph at height y. Stem, arch with outer radius R, inner semicircular gap.
function hSpans(y) {
  const S0 = -0.75, S1 = -0.3, L0 = 0.3, L1 = 0.75, B0 = 1.35, B1 = 1.95, R = 0.72, ri = 0.3;
  if (y > B1) return [[S0, S1]];
  const yc = B1 - R, xOuter = y > yc ? (L1 - R) + Math.sqrt(Math.max(0, R * R - (y - yc) ** 2)) : L1;
  if (y >= B0) return [[S0, xOuter]];
  const yi = B0 - ri;
  if (y >= yi) { const gHalf = Math.sqrt(Math.max(0, ri * ri - (y - yi) ** 2)); return [[S0, -gHalf], [gHalf, xOuter]]; }
  return [[S0, S1], [L0, L1]];
}

function slab(w, t, d, mat, yMid, recessUV = 0) {
  const r = Math.min(0.007, t * 0.22);
  const geo = worldUV(new RoundedBoxGeometry(w, t, d, 2, r), yMid);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function buildStack(p, M) {
  const group = new THREE.Group();
  const isH = p.form === 'h';
  const { list, H } = bands(p, isH ? 3 : null);
  const seq = SEQ[p.seq] || SEQ.a;
  const slide = new THREE.Vector3(0.55, 0, 0.83).multiplyScalar(+p.slide);
  for (const b of list) {
    const kind = b.i === +p.recall ? 'recalled' : seq[b.i % seq.length];
    const yMid = (b.y0 + b.y1) / 2, t = b.t - Math.min(+p.gap, b.t * 0.15);
    const spans = isH ? hSpans(yMid).map(([x0, x1]) => [x0, x1]) : [[-+p.w / 2, +p.w / 2]];
    const depth = isH ? 0.62 : +p.d;
    for (const [x0, x1] of spans) {
      const j = kind === 'steel' ? 0 : +p.jitter, rel = 1 + RELIEF[kind] * +p.relief;
      const w = (x1 - x0) * rel * (1 + (rnd() - 0.5) * j), d = depth * rel * (1 + (rnd() - 0.5) * j);
      const cx = (x0 + x1) / 2 + (rnd() - 0.5) * j * 0.3, cz = (rnd() - 0.5) * j * 0.3;
      let mesh;
      if (kind === 'recalled') {
        mesh = slab(w, t, d, M.recalled(+p.frost), yMid);
        const core = new THREE.Mesh(new RoundedBoxGeometry(w * +p.coreW, t * 0.5, d * +p.coreW, 1, 0.004), M.core(+p.glow));
        mesh.add(core);
        // Recall lights its neighbours: mint spill from the proud front and side edges onto the strata above and below.
        if (+p.spill) for (const [sx, sz] of [[w * 0.3, d * 0.5], [w * 0.5, d * 0.3], [-w * 0.3, d * 0.45]]) {
          const l = new THREE.PointLight(MINT, +p.spill, 2.2, 2); l.position.set(sx, 0, sz); mesh.add(l);
        }
        mesh.position.add(slide);
      } else mesh = slab(w, t, d, M[kind], yMid);
      mesh.position.x += cx; mesh.position.z += cz; mesh.position.y = yMid;
      group.add(mesh);
    }
  }
  return { group, H };
}

// A large plane with a rectangular hole, facing the sun: the Ando slit that turns one light into a shaft.
function slit(sunDir, p, H) {
  const shape = new THREE.Shape([[-40, -40], [40, -40], [40, 40], [-40, 40]].map(([x, y]) => new THREE.Vector2(x, y)));
  const hw = +p.slotW / 2, hh = +p.slotH / 2, a = THREE.MathUtils.degToRad(+p.slotRot), off = +p.slotOff;
  const rot = (x, y) => new THREE.Vector2(x * Math.cos(a) - y * Math.sin(a) + off, x * Math.sin(a) + y * Math.cos(a));
  shape.holes.push(new THREE.Path([rot(-hw, -hh), rot(hw, -hh), rot(hw, hh), rot(-hw, hh)]));
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: THREE.DoubleSide }));
  m.position.copy(sunDir).multiplyScalar(6).add(new THREE.Vector3(0, H * 0.45, 0));
  m.lookAt(m.position.clone().add(sunDir));
  m.castShadow = true;
  m.userData.noAO = true;
  return m;
}

function darkStudio(renderer, k) {
  const s = new THREE.Scene();
  s.background = new THREE.Color('#000000');
  gradPanel(s, 5, 9, [[0, '#fff5e6'], [1, '#6b6255']], 3 * k, [-8, 6, 5]);
  gradPanel(s, 3, 8, [[0, '#4c5c53'], [1, '#111513']], 1.2 * k, [8, 2, -3]);
  gradPanel(s, 12, 5, [[0, '#0d100e'], [1, '#000000']], 1 * k, [0, -8, 0]);
  return pmrem(renderer, s);
}

export async function createScene(renderer, size, q = {}) {
  const p = { ...D, ...q };
  const alpha = +p.alpha === 1;
  renderer.toneMapping = p.tone === 'neutral' ? THREE.NeutralToneMapping : THREE.AgXToneMapping;
  renderer.toneMappingExposure = +p.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(INK, alpha ? 0 : 1);

  const scene = new THREE.Scene();
  scene.environment = darkStudio(renderer, +p.env);

  const M = materials();
  const { group, H } = buildStack(p, M);
  scene.add(group);

  const sunDir = new THREE.Vector3(+p.sunx, +p.suny, +p.sunz).normalize();
  const sun = new THREE.DirectionalLight(p.sunCol, +p.sun);
  sun.position.copy(sunDir).multiplyScalar(14).add(new THREE.Vector3(0, H * 0.45, 0));
  sun.target.position.set(0, H * 0.45, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.015; sun.shadow.radius = 1.5;
  Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 2, far: 40 });
  scene.add(sun, sun.target);
  if (+p.slot) scene.add(slit(sunDir, p, H));
  scene.add(new THREE.HemisphereLight(p.ambCol, '#050605', +p.amb));
  if (+p.rim) {
    // Cool rim from behind-right so the shadow face of the stack separates from the dark.
    const rim = new THREE.DirectionalLight('#9fb8c8', +p.rim); rim.position.set(4, 3, -3); scene.add(rim);
  }

  let camera;
  const lookY = H * +p.look;
  if (+p.iso) {
    const f = (H * 0.62) / +p.zoom;
    camera = new THREE.OrthographicCamera(-f, f, f, -f, 0.1, 100);
    const y = THREE.MathUtils.degToRad(+p.yaw), pt = THREE.MathUtils.degToRad(+p.pitch || 35.264);
    camera.position.set(20 * Math.sin(y) * Math.cos(pt), lookY + 20 * Math.sin(pt), 20 * Math.cos(y) * Math.cos(pt));
    camera.lookAt(0, lookY, 0);
  } else {
    camera = new THREE.PerspectiveCamera(+p.fov, 1, 0.1, 200);
    const y = THREE.MathUtils.degToRad(+p.yaw), pt = THREE.MathUtils.degToRad(+p.pitch), d = +p.dist;
    camera.position.set(d * Math.sin(y) * Math.cos(pt), lookY + d * Math.sin(pt), d * Math.cos(y) * Math.cos(pt));
    camera.lookAt(0, lookY, 0);
  }

  if (!alpha) {
    if (+p.floor !== 0) {
      const floor = new THREE.Mesh(worldUV(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2)), M.concrete);
      floor.position.y = -0.001; floor.receiveShadow = true; scene.add(floor);
    }
    if (+p.wall) {
      const wall = new THREE.Mesh(worldUV(new THREE.PlaneGeometry(40, 30)), M.wallcrete);
      wall.position.set(0, 15, +p.wallZ); wall.receiveShadow = true; scene.add(wall);
    } else scene.add(backdrop(60, 30, camera, '#151b17', INK));
    if (+p.beam) {
      // Dust in the shaft: an additive slab along the sun direction, faded at both ends.
      const c = document.createElement('canvas'); c.width = 256; c.height = 4;
      const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 256, 0);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.3, 'rgba(255,255,255,1)'); gr.addColorStop(0.85, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 256, 4);
      const beam = new THREE.Mesh(new THREE.BoxGeometry(+p.slotW, +p.slotH, 20), new THREE.MeshBasicMaterial({ color: '#ffe9c8', transparent: true, opacity: +p.beam, alphaMap: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false }));
      beam.position.copy(sunDir).multiplyScalar(-2).add(new THREE.Vector3(0, H * 0.45, 0));
      beam.lookAt(beam.position.clone().add(sunDir));
      beam.userData.noAO = true;
      scene.add(beam);
    }
  }

  return makeComposer(renderer, scene, camera, size, { ao: +p.ao, aoRadius: 0.25, bloom: +p.bloom, bloomThreshold: 0.85, alpha });
}
