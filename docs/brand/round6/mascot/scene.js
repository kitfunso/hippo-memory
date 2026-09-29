// hippo round 6, "Mascot bust": a hippo head sculpted as a smooth-min SDF, meshed by MarchingCubes, finished as a vinyl toy.
import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const INK = '#0b0f0c', MINT = '#7ce38b';
export const SKINS = {
  slate: { skin: '#77839a', sheen: '#cfd8e6', inner: '#d9a3ad' },
  lilac: { skin: '#9088b5', sheen: '#dcd6ee', inner: '#e3a7b6' },
  bone: { skin: '#d6dcd5', sheen: '#ffffff', inner: '#e6b0b8' },
  ink: { skin: '#252d31', sheen: '#9fd9aa', inner: '#c98f98' },
};
export const DEFAULTS = {
  view: 'hero', skin: 'slate', detail: 'glasses', res: 208, yaw: -30, pitch: 8, dist: 7.8, fov: 26, key: 1, rim: 1, fill: 1,
  ao: 1, bloom: 1, post: 1, alpha: 0, exposure: 1, bg: 'ink', bust: 1, cy: 0, eye: 0.105, glow: 1.2, smile: 1, k: 0.30, orb: 0.095, gap: 0.05, tube: 0.016,
};

// ---------- SDF sculpt (head faces +z, y up, everything inside [-1, 1]) ----------

const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);
const sph = (x, y, z, cx, cy, cz, r) => { const dx = x - cx, dy = y - cy, dz = z - cz; return Math.sqrt(dx * dx + dy * dy + dz * dz) - r; };
function ell(x, y, z, cx, cy, cz, rx, ry, rz) {
  const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
  const k0 = Math.sqrt(px * px + py * py + pz * pz), k1 = Math.sqrt((px * px) / (rx * rx) + (py * py) / (ry * ry) + (pz * pz) / (rz * rz));
  return (k0 * (k0 - 1)) / k1;
}
function rbx(x, y, z, cx, cy, cz, bx, by, bz, r) {
  const qx = Math.abs(x - cx) - bx, qy = Math.abs(y - cy) - by, qz = Math.abs(z - cz) - bz;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
}
function cap(x, y, z, ax, ay, az, bx, by, bz, r) {
  const pax = x - ax, pay = y - ay, paz = z - az, bax = bx - ax, bay = by - ay, baz = bz - az;
  const h = Math.min(Math.max((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0), 1);
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

export const EYE = [0.18, 0.29, 0.34], EAR = [0.30, 0.49, -0.06], NOSE = [0, 0.18, 0.56], RIM_Z = 0.16;

// Body without the carved details, so the smile can be projected onto the real surface.
function baseSDF(x, y, z, p) {
  let d = ell(x, y, z, 0, 0.20, -0.02, 0.40, 0.30, 0.34);
  d = smin(d, rbx(x, y, z, 0, -0.10, 0.20, 0.19, 0.05, 0.16, 0.24), +p.k);
  d = smin(d, ell(x, y, z, 0, -0.30, 0.30, 0.30, 0.10, 0.24), 0.15);
  for (const s of [-1, 1]) {
    d = smin(d, sph(x, y, z, s * EYE[0], EYE[1] + 0.01, EYE[2] - 0.10, 0.11), 0.14);
    d = smin(d, ell(x, y, z, s * EAR[0], EAR[1], EAR[2], 0.095, 0.105, 0.06), 0.05);
  }
  if (+p.bust) {
    d = smin(d, cap(x, y, z, 0, -0.15, -0.03, 0, -0.5, -0.03, 0.22), 0.16);
    d = smin(d, ell(x, y, z, 0, -0.70, -0.03, 0.50, 0.17, 0.38), 0.14);
  }
  return d;
}

const BUST_CUT = -0.80;
function headSDF(x, y, z, p) {
  let d = baseSDF(x, y, z, p);
  for (const s of [-1, 1]) {
    d = smax(d, -sph(x, y, z, s * (EAR[0] + 0.01), EAR[1] + 0.02, EAR[2] + 0.08, 0.05), 0.02);
    d = smax(d, -sph(x, y, z, s * 0.11, 0.215, 0.42, 0.05), 0.03);
  }
  if (+p.bust) d = Math.max(d, BUST_CUT - y);
  return d;
}

// Smile is a smooth dark tube half-sunk into the muzzle: a carved SDF groove aliased into stair-steps at any grid size.
function smileTube(p) {
  const pts = Array.from({ length: 41 }, (_, i) => { const u = i / 20 - 1; return [u * 0.25, -0.21 + 0.12 * u * u, 0.56 - 0.16 * u * u]; }).map(([x, y, z]) => {
    let gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < 6; i++) {
      const e = 1e-3, d = baseSDF(x, y, z, p);
      gx = (baseSDF(x + e, y, z, p) - d) / e; gy = (baseSDF(x, y + e, z, p) - d) / e; gz = (baseSDF(x, y, z + e, p) - d) / e;
      x -= gx * d; y -= gy * d; z -= gz * d;
    }
    return new THREE.Vector3(x + gx * 0.002, y + gy * 0.002, z + gz * 0.002);
  });
  for (let pass = 0; pass < 3; pass++) for (let i = 1; i < pts.length - 1; i++) pts[i].lerp(pts[i - 1].clone().add(pts[i + 1]).multiplyScalar(0.5), 0.5);
  const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 120, 0.011, 12, false);
  return new THREE.Mesh(geo, PM({ color: '#141917', roughness: 0.6 }));
}

function sculpt(p, material) {
  const res = +p.res, mc = new MarchingCubes(res, material, false, false, 1200000);
  mc.isolation = 80;
  const n = mc.size, hs = mc.halfsize, F = mc.field;
  for (let k = 0; k < n; k++) {
    const z = (k - hs) / hs;
    for (let j = 0; j < n; j++) {
      const y = (j - hs) / hs, row = k * n * n + j * n;
      for (let i = 0; i < n; i++) F[row + i] = 80 - 40 * headSDF((i - hs) / hs, y, z, p);
    }
  }
  mc.update();
  mc.castShadow = mc.receiveShadow = true;
  return mc;
}

// ---------- materials, lights ----------

const PM = (o) => new THREE.MeshPhysicalMaterial(o);
const vinyl = (skin) => PM({ color: skin.skin, roughness: 0.85, metalness: 0, sheen: 1, sheenRoughness: 0.5, sheenColor: skin.sheen, envMapIntensity: 0.6 });
const gloss = PM({ color: '#0a0d0c', roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 2.2 });
const mintGlow = (k) => PM({ color: MINT, emissive: MINT, emissiveIntensity: k, roughness: 0.25, clearcoat: 1, envMapIntensity: 1 });
function shadowed(m) { m.castShadow = m.receiveShadow = true; return m; }
const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };

function studioEnv(renderer) {
  const s = new THREE.Scene();
  s.background = new THREE.Color('#050705');
  const panel = (w, h, color, k, pos) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(0, 0, 0); s.add(m);
  };
  panel(7, 5, '#fff6ea', 5, [-6, 6, 5]);
  panel(1.4, 8, '#ffffff', 3, [7, 2, -2]);
  panel(1.2, 8, MINT, 2.5, [-6, 1, -5]);
  panel(8, 3, '#ffffff', 1.2, [5, 1, 7]);
  panel(14, 6, '#0d120e', 1, [0, -8, 0]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(s, 0.04).texture;
  pmrem.dispose();
  return tex;
}

function backdrop(size, dist, camera) {
  const c = document.createElement('canvas'), N = 1024;
  c.width = c.height = N;
  const g = c.getContext('2d'), grad = g.createRadialGradient(N / 2, N * 0.42, 10, N / 2, N * 0.5, N * 0.66);
  grad.addColorStop(0, '#242c28'); grad.addColorStop(0.5, '#121915'); grad.addColorStop(1, INK);
  g.fillStyle = grad; g.fillRect(0, 0, N, N);
  const img = g.getImageData(0, 0, N, N), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 3; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex }));
  m.position.copy(camera.position).normalize().multiplyScalar(-dist); m.lookAt(camera.position);
  m.userData.noAO = true;
  return m;
}

// ---------- scene ----------

export async function createScene(renderer, size, q = {}) {
  const p = { ...DEFAULTS, ...q }, skin = SKINS[p.skin] || SKINS.slate, alpha = !!+p.alpha, S = 2.4;
  RectAreaLightUniformsLib.init();
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = +p.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.setClearColor(INK, alpha ? 0 : 1);

  const scene = new THREE.Scene();
  scene.environment = studioEnv(renderer);

  const head = new THREE.Group();
  head.scale.setScalar(S);
  head.add(sculpt(p, vinyl(skin)));
  if (+p.smile) head.add(smileTube(p));
  const inner = PM({ color: skin.inner, roughness: 0.9, sheen: 0.6, sheenColor: '#ffffff' });
  for (const s of [-1, 1]) {
    head.add(at(shadowed(new THREE.Mesh(new THREE.SphereGeometry(+p.eye, 48, 32), gloss)), s * EYE[0], EYE[1], EYE[2]));
    const pad = at(new THREE.Mesh(new THREE.SphereGeometry(0.042, 24, 16), inner), s * (EAR[0] + 0.01), EAR[1] + 0.02, EAR[2] + 0.06);
    pad.scale.z = 0.45; head.add(pad);
  }
  if (p.detail === 'orb') {
    const orb = at(shadowed(new THREE.Mesh(new THREE.SphereGeometry(+p.orb, 48, 32), mintGlow(+p.glow))), NOSE[0], NOSE[1] + +p.orb - 0.115 + +p.gap, NOSE[2]);
    head.add(orb);
    const lamp = new THREE.PointLight(MINT, 2.5, 4, 1.6);
    orb.add(lamp);
  } else if (p.detail === 'glasses') {
    const frame = PM({ color: MINT, emissive: MINT, emissiveIntensity: +p.glow * 0.4, roughness: 0.3, metalness: 0.2, clearcoat: 1 }), tube = +p.tube;
    for (const s of [-1, 1]) {
      const ring = at(shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.115, tube, 16, 64), frame)), s * EYE[0], EYE[1], EYE[2] + RIM_Z);
      ring.rotation.x = -0.5; head.add(ring); // lower rim leans forward so it clears the snout and the circle stays closed
      // Arm: from the ring's outer edge back along the head to the ear.
      const a = new THREE.Vector3(s * (EYE[0] + 0.115), EYE[1], EYE[2] + RIM_Z), b = new THREE.Vector3(s * (EAR[0] + 0.02), EAR[1] - 0.08, EAR[2] + 0.02);
      const arm = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(tube * 0.8, tube * 0.8, a.distanceTo(b), 12), frame));
      arm.position.copy(a).lerp(b, 0.5); arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()); head.add(arm);
    }
    const bridge = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(tube * 0.85, tube * 0.85, 0.16, 12), frame));
    bridge.rotation.z = Math.PI / 2; at(bridge, 0, EYE[1] + 0.02, EYE[2] + RIM_Z); head.add(bridge);
  }
  scene.add(head);

  const root = new THREE.Group();
  scene.add(root);
  const low = BUST_CUT * S;
  if (+p.bust && !alpha) {
    const ped = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.45, 0.2, 96), PM({ color: '#22272a', roughness: 0.75, envMapIntensity: 0.2 })));
    ped.position.y = low - 0.11; scene.add(ped);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.5 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = low - 0.225; floor.receiveShadow = true; scene.add(floor);
  }

  const camera = new THREE.PerspectiveCamera(+p.fov, 1, 0.1, 100);
  const yaw = THREE.MathUtils.degToRad(+p.yaw), pitch = THREE.MathUtils.degToRad(+p.pitch), d = +p.dist;
  const target = new THREE.Vector3(0, (+p.bust ? -0.3 : 0.1) + +p.cy, 0.3);
  camera.position.set(d * Math.sin(yaw) * Math.cos(pitch), d * Math.sin(pitch), d * Math.cos(yaw) * Math.cos(pitch)).add(target);
  camera.lookAt(target);
  if (!alpha) scene.add(backdrop(40, 14, camera));

  // Studio three-point: soft warm key, cool fill, hard mint rim; the sun only exists to cast the shadow.
  const key = new THREE.RectAreaLight('#fff3e6', 7 * +p.key, 4, 4);
  key.position.set(-3.2, 4, 4.2); key.lookAt(0, 0, 0); scene.add(key);
  const fill = new THREE.RectAreaLight('#dfe9ff', 1.6 * +p.fill, 3, 3);
  fill.position.set(4.5, 1.2, 3.5); fill.lookAt(0, 0, 0); scene.add(fill);
  const rim = new THREE.RectAreaLight(MINT, 9 * +p.rim, 1, 5);
  rim.position.set(3.4, 2.6, -3.2); rim.lookAt(0, 0, 0); scene.add(rim);
  const rim2 = new THREE.RectAreaLight('#ffffff', 4 * +p.rim, 0.8, 5);
  rim2.position.set(-3.8, 2.2, -2.8); rim2.lookAt(0, 0, 0); scene.add(rim2);
  const sun = new THREE.DirectionalLight('#fff3e6', 1.2 * +p.key);
  sun.position.set(-3.2, 5, 4.2); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 6; sun.shadow.blurSamples = 20; sun.shadow.bias = -0.0005;
  Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 20 });
  scene.add(sun);

  if (!+p.post) return { scene, camera, render: () => renderer.render(scene, camera) };
  const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  if (+p.ao) {
    const gtao = new GTAOPass(scene, camera, size, size);
    gtao.blendIntensity = 0.6;
    gtao.updateGtaoMaterial({ radius: 0.3, distanceExponent: 1, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
    const hide = gtao._overrideVisibility.bind(gtao);
    gtao._overrideVisibility = () => { hide(); scene.traverse((o) => { if (o.userData.noAO && o.visible) { o.visible = false; gtao._visibilityCache.push(o); } }); };
    composer.addPass(gtao);
  }
  if (+p.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(size, size), 0.35, 0.6, 0.9));
  composer.addPass(new OutputPass());
  return { scene, camera, render: () => composer.render() };
}
