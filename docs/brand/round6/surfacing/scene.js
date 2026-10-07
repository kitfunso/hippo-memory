// hippo logo round 6, "Surfacing": a clay hippo head submerged to the eyes in glassy ink water.
import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';

export const INK = '#0b0f0c', MINT = '#7ce38b', AMBER = '#f2b84b';

export const DEFAULTS = {
  yaw: 22, pitch: 8, dist: 5, fov: 28, tx: 0, ty: 0.02, tz: 0.15, res: 160, mat: 'bone', alpha: 0, top: 0, disc: 0,
  exposure: 1, bloom: 1, key: 1, rim: 1, fog: 1, wave: 0.003, lam: 0.22, decay: 0.5, swell: 0.15, men: 0.012, water: 'ink',
  bodyv: 1, shadow: 1, env: 'a', horizon: 1, eyes: 1, size: 1024, fade: 0.25, deep: '#050a07', distort: 0.6, ghost: 0.05, glint: 1, discr: 2.4, sky: 0, bd: 'mint', topglint: 0,
};

// ---------- signed distance sculpt ----------

const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);
const sph = (x, y, z, [cx, cy, cz, r]) => Math.hypot(x - cx, y - cy, z - cz) - r;
function ell(x, y, z, [cx, cy, cz, rx, ry, rz]) {
  const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
  const k0 = Math.hypot(px, py, pz), k1 = Math.hypot(px / rx, py / ry, pz / rz);
  return k0 * (k0 - 1) / k1;
}
function rbox(x, y, z, [cx, cy, cz, hx, hy, hz, r]) {
  const qx = Math.abs(x - cx) - hx + r, qy = Math.abs(y - cy) - hy + r, qz = Math.abs(z - cz) - hz + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

// Water is y=0; +z is the muzzle direction. Mirrored parts are given for x>0.
export const HEAD = {
  skull: [0, -0.48, -0.35, 0.8, 0.42, 0.88],
  muzzle: [0, -0.44, 0.82, 0.88, 0.36, 0.62, 0.3],
  eye: [0.44, 0.02, -0.1, 0.22],
  eyeball: [0.47, 0.1, 0.05, 0.105],
  ear: [0.54, 0.1, -0.64, 0.14, 0.18, 0.1],
  earHollow: [0.55, 0.17, -0.53, 0.08, 0.1, 0.05],
  nostril: [0.31, -0.04, 1.14, 0.18],
  slit: [0.31, 0.16, 1.2, 0.09, 0.045, 0.045],
};

export function headSDF(x, y, z) {
  const ax = Math.abs(x);
  let d = ell(x, y, z, HEAD.skull);
  d = smin(d, rbox(x, y, z, HEAD.muzzle), 0.28);
  d = smin(d, sph(ax, y, z, HEAD.eye), 0.12);
  d = smin(d, ell(ax, y, z, HEAD.ear), 0.06);
  d = smin(d, sph(ax, y, z, HEAD.nostril), 0.1);
  d = smax(d, -sph(ax, y, z, [HEAD.eyeball[0], HEAD.eyeball[1], HEAD.eyeball[2], HEAD.eyeball[3] + 0.008]), 0.02);
  d = smax(d, -ell(ax, y, z, HEAD.earHollow), 0.03);
  d = smax(d, -ell(ax, y, z, HEAD.slit), 0.02);
  return d;
}

// Marching cubes over the SDF, then re-welded so the normals shade like one clay body.
export function sculpt(res, R = 1.75) {
  const mc = new MarchingCubes(res, new THREE.MeshBasicMaterial(), false, false, 800000);
  mc.isolation = 0;
  const half = res / 2, f = mc.field;
  for (let k = 0; k < res; k++) for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    f[k * res * res + j * res + i] = -headSDF(((i - half) / half) * R, ((j - half) / half) * R, ((k - half) / half) * R);
  }
  mc.update();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mc.positionArray.slice(0, mc.count * 3), 3));
  g.scale(R, R, R);
  const m = BGU.mergeVertices(g, 1e-4);
  smooth(m, 4);
  m.computeVertexNormals();
  return m;
}

// Laplacian relax: marching-cubes vertices sit on grid edges and shade as facets without it.
function smooth(g, iters) {
  const idx = g.index.array, pos = g.attributes.position, n = pos.count;
  const nb = Array.from({ length: n }, () => []);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    nb[a].push(b, c); nb[b].push(a, c); nb[c].push(a, b);
  }
  const src = pos.array, out = new Float32Array(src.length);
  for (let it = 0; it < iters; it++) {
    for (let v = 0; v < n; v++) {
      let x = 0, y = 0, z = 0;
      for (const u of nb[v]) { x += src[3 * u]; y += src[3 * u + 1]; z += src[3 * u + 2]; }
      const k = nb[v].length || 1;
      out[3 * v] = 0.5 * src[3 * v] + 0.5 * x / k; out[3 * v + 1] = 0.5 * src[3 * v + 1] + 0.5 * y / k; out[3 * v + 2] = 0.5 * src[3 * v + 2] + 0.5 * z / k;
    }
    src.set(out);
  }
  pos.needsUpdate = true;
}

// Below the waterline the clay fades toward ink with depth: the memory that lies beneath.
export function depthTint(geo, base, depth = 1.1) {
  const pos = geo.attributes.position, col = new Float32Array(pos.count * 3), b = new THREE.Color(base), ink = new THREE.Color('#0d3a1c'), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(Math.max(-pos.getY(i) / depth, 0), 1);
    c.copy(b).lerp(ink, t * t * (3 - 2 * t));
    col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

// ---------- water ----------

// Waterline radius of a bump sphere: where it crosses y=0.
const waterline = ([cx, cy, cz, r]) => [cx, cz, Math.sqrt(Math.max(r * r - cy * cy, 0.0001))];

export function rippleSources() {
  const s = [];
  for (const sx of [1, -1]) {
    for (const [part, ph] of [[HEAD.eye, 0], [HEAD.nostril, 1.9], [HEAD.ear, 3.4]]) {
      const [cx, cz, r0] = waterline(part);
      s.push([sx * cx, cz, part === HEAD.ear ? r0 * 0.85 : r0, ph + (sx < 0 ? 0.6 : 0)]);
    }
  }
  return s;
}

const sstep = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

// Plane stays in XY (Reflector wants local +Z as its normal); the mesh is rotated flat, so local y is world -z.
export function waterGeometry(p, W, N) {
  const g = new THREE.PlaneGeometry(W, W, N, N);
  const pos = g.attributes.position, src = rippleSources();
  const A = +p.wave, lam = +p.lam, L = +p.decay, men = +p.men, sw = +p.swell;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = -pos.getY(i);
    let h = 0;
    for (const [sx, sz, r0, ph] of src) {
      const d = Math.hypot(x - sx, z - sz) - r0;
      if (d > 4.5) continue;
      const dd = Math.max(d, 0);
      h += A * Math.exp(-dd / L) * Math.cos((2 * Math.PI * dd) / lam + ph) * (0.6 + 0.4 * sstep(0, 0.12, dd)) + men * Math.exp(-dd / 0.05);
    }
    h += sw * (0.0035 * Math.sin(x * 1.7 + z * 1.1) + 0.0025 * Math.sin(x * 0.6 - z * 2.3 + 1.2) + 0.002 * Math.sin(x * 3.1 + z * 2.7 + 2));
    pos.setZ(i, h);
  }
  g.computeVertexNormals();
  return g;
}

const WATER_VERT = /* glsl */`
uniform mat4 textureMatrix;
varying vec4 vUv4; varying vec3 vN; varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); vUv4 = textureMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// Mirror of the scene above the waterline, bent by the ripple normals; Fresnel decides how much of the
// submerged clay ghosts through. Two glint suns: white key, mint backlight.
const WATER_FRAG = /* glsl */`
uniform sampler2D tDiffuse; uniform vec3 deep, sunA, sunB, sunC, colA, colB; uniform vec2 discC; uniform float distortion, ghost, discR, glint, topglint;
varying vec4 vUv4; varying vec3 vN; varying vec3 vW;
void main() {
  float dr = length(vW.xz - discC);
  if (dr > discR) discard;
  float edge = 1.0 - smoothstep(discR * 0.94, discR, dr);
  vec3 N = normalize(vN), V = normalize(cameraPosition - vW);
  vec4 uv = vUv4; uv.xy += N.xz * distortion * uv.w;
  vec3 refl = texture2DProj(tDiffuse, uv).rgb;
  float f = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 col = mix(deep, refl, f);
  col += colA * pow(max(dot(N, normalize(V + sunA)), 0.0), 600.0) * glint;
  col += colB * pow(max(dot(N, normalize(V + sunB)), 0.0), 300.0) * glint;
  col += vec3(0.9, 1.0, 0.93) * pow(max(dot(N, normalize(V + sunC)), 0.0), 2500.0) * topglint;
  gl_FragColor = vec4(col, mix(1.0 - ghost, 1.0, f) * edge);
}`;

export function makeWater(p, size, alpha) {
  const geo = waterGeometry(p, alpha ? 8 : 40, alpha ? 1400 : 2200);
  const refl = new Reflector(geo, { textureWidth: size, textureHeight: size, clipBias: 0.002, type: THREE.HalfFloatType });
  const tm = refl.material.uniforms.textureMatrix.value;
  refl.material = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: refl.getRenderTarget().texture }, textureMatrix: { value: tm },
      deep: { value: new THREE.Color(p.deep) },
      sunA: { value: new THREE.Vector3(-2.5, 5, 3).normalize() }, colA: { value: new THREE.Color('#ffffff').multiplyScalar(1.2) },
      sunB: { value: new THREE.Vector3(2.5, 1.4, -5).normalize() }, colB: { value: new THREE.Color(MINT).multiplyScalar(2.5) },
      // 8 degrees off vertical: flat water stays dark top-down, only ring crests facing the sun flare.
      sunC: { value: new THREE.Vector3(-0.12, 1, 0.08).normalize() }, topglint: { value: +p.topglint },
      distortion: { value: +p.distort }, ghost: { value: +p.ghost },
      discR: { value: +p.disc ? +p.discr : 1e9 }, discC: { value: new THREE.Vector2(+p.tx, +p.tz) }, glint: { value: +p.glint },
    },
    vertexShader: WATER_VERT, fragmentShader: WATER_FRAG, transparent: true,
  });
  refl.rotation.x = -Math.PI / 2;
  return refl;
}

// ---------- materials, environment ----------

const PM = (o) => new THREE.MeshPhysicalMaterial({ vertexColors: true, ...o });
export const CLAY = { bone: '#d6dbd3', mint: '#4fbb68', ink: '#1b231d', grey: '#8f9296', putty: '#cfc4b4' };
export const MATS = {
  bone: () => PM({ roughness: 0.55, sheen: 0.35, sheenColor: '#ffffff', sheenRoughness: 0.7, clearcoat: 0.2, clearcoatRoughness: 0.5, envMapIntensity: 0.7 }),
  mint: () => PM({ roughness: 0.38, clearcoat: 0.55, clearcoatRoughness: 0.22, envMapIntensity: 0.8 }),
  ink: () => PM({ roughness: 0.45, clearcoat: 0.45, clearcoatRoughness: 0.3, sheen: 0.4, sheenColor: MINT, sheenRoughness: 0.7, envMapIntensity: 1.1 }),
  grey: () => PM({ roughness: 0.5, sheen: 0.3, sheenColor: '#ffd9d0', sheenRoughness: 0.6, clearcoat: 0.3, clearcoatRoughness: 0.35, envMapIntensity: 0.8 }),
  putty: () => PM({ roughness: 0.6, sheen: 0.4, sheenColor: '#fff2e6', sheenRoughness: 0.8, clearcoat: 0.12, clearcoatRoughness: 0.6, envMapIntensity: 0.7 }),
  eye: () => new THREE.MeshPhysicalMaterial({ color: '#04070a', roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 2.2 }),
};

// Soft-edged light panel: a hard panel edge reflects as a hard line in glassy water.
function softPanel(w, h, color, k, pos, scene) {
  const c = document.createElement('canvas'), N = 256;
  c.width = c.height = N;
  const g = c.getContext('2d'), grad = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
  grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.55, '#ffffff'); grad.addColorStop(1, '#000000');
  g.fillStyle = grad; g.fillRect(0, 0, N, N);
  const img = g.getImageData(0, 0, N, N), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 4; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide, transparent: true, blending: THREE.AdditiveBlending, fog: false }));
  m.position.set(...pos); m.lookAt(0, 0, 0); scene.add(m);
}

// Dark studio: one big softbox above-front, a mint horizon glow behind so the far ripples catch mint.
function studioEnv(renderer, variant) {
  const s = new THREE.Scene();
  s.background = new THREE.Color('#010201');
  softPanel(12, 8, '#ffffff', 3.5, [-2, 9, 4], s);
  softPanel(40, 2.2, variant === 'b' ? '#c9f7d1' : MINT, variant === 'b' ? 1.8 : 1.2, [0, 0.5, -14], s);
  softPanel(3, 9, '#ffffff', 1.2, [10, 2, 1], s);
  softPanel(7, 4, '#e8fff0', 0.8, [2, 4, 11], s);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(s, 0.03).texture;
  pmrem.dispose();
  return tex;
}

// Backdrop card: ink with a soft mint band at the horizon; noise stops the gradient banding.
function backdrop(camera, dist, mint) {
  const c = document.createElement('canvas'), N = 1024;
  c.width = c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = '#070c09'; g.fillRect(0, 0, N, N);
  const band = g.createLinearGradient(0, N * 0.44, 0, N * 0.5);
  band.addColorStop(0, '#070c09'); band.addColorStop(0.6, mint ? '#1a4226' : '#1a2420'); band.addColorStop(1, mint ? '#4a9c5c' : '#7d8f84');
  g.fillStyle = band; g.fillRect(0, 0, N, N / 2);
  const glow = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N * 0.42);
  glow.addColorStop(0, mint ? 'rgba(120,220,140,0.35)' : 'rgba(200,220,205,0.3)'); glow.addColorStop(0.35, mint ? 'rgba(60,140,80,0.12)' : 'rgba(90,110,100,0.1)'); glow.addColorStop(1, 'rgba(7,12,9,0)');
  g.fillStyle = glow; g.fillRect(0, 0, N, N / 2);
  const img = g.getImageData(0, 0, N, N), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 3; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(dist * 1.2, dist * 1.2), new THREE.MeshBasicMaterial({ map: tex, fog: false }));
  m.position.copy(camera.position).setY(0).normalize().multiplyScalar(-dist);
  m.lookAt(camera.position.x, 0, camera.position.z);
  return m;
}

// ---------- scene ----------

export function createScene(renderer, size, q = {}) {
  const p = { ...DEFAULTS, ...q };
  RectAreaLightUniformsLib.init();
  const alpha = !!+p.alpha, top = !!+p.top;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = +p.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.setClearColor(INK, alpha ? 0 : 1);

  const scene = new THREE.Scene();
  scene.background = alpha ? null : new THREE.Color(INK);
  scene.environment = studioEnv(renderer, p.env);
  if (+p.fog && !alpha) scene.fog = new THREE.Fog('#070c09', 4, 30);

  const camera = new THREE.PerspectiveCamera(+p.fov, 1, 0.1, 200);
  const yaw = THREE.MathUtils.degToRad(top ? 0 : +p.yaw), pitch = THREE.MathUtils.degToRad(top ? 89.5 : +p.pitch), d = +p.dist;
  camera.position.set(d * Math.sin(yaw) * Math.cos(pitch), d * Math.sin(pitch), d * Math.cos(yaw) * Math.cos(pitch));
  camera.position.add(new THREE.Vector3(+p.tx, +p.ty, +p.tz));
  camera.lookAt(+p.tx, +p.ty, +p.tz);

  const key = new THREE.RectAreaLight('#ffffff', 5 * +p.key, 4, 4);
  key.position.set(-2.5, 4.2, 3.2); key.lookAt(0, 0, 0); scene.add(key);
  const rim = new THREE.RectAreaLight(MINT, 3 * +p.rim, 3, 1.5);
  rim.position.set(2.5, 1.4, -5); rim.lookAt(0, 0, 0); scene.add(rim);
  const sun = new THREE.DirectionalLight('#ffffff', 1.3 * +p.key);
  sun.position.set(-2.5, 5, 3); sun.castShadow = !!+p.shadow;
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 6; sun.shadow.blurSamples = 16; sun.shadow.bias = -0.0004;
  Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 20 });
  scene.add(sun);

  if (top) HEAD.eyeball = [0.45, 0.19, -0.05, 0.105]; // seen from above the eye should look up, not at its nose
  const headGeo = sculpt(+p.res);
  depthTint(headGeo, CLAY[p.mat], +p.fade);
  const head = new THREE.Mesh(headGeo, MATS[p.mat]());
  head.castShadow = head.receiveShadow = true;
  scene.add(head);
  if (+p.eyes) for (const sx of [1, -1]) {
    const [cx, cy, cz, r] = HEAD.eyeball;
    const eye = new THREE.Mesh(new THREE.SphereGeometry(r, 64, 48), MATS.eye());
    eye.position.set(sx * cx, cy, cz); eye.castShadow = true; scene.add(eye);
  }
  if (+p.bodyv) {
    // Submerged bulk behind the head: only a ghost through the water, but it is the point of the picture.
    const bodyGeo = new THREE.SphereGeometry(1, 96, 64);
    bodyGeo.scale(1.15, 0.85, 1.7); bodyGeo.translate(0, -0.85, -2.2);
    depthTint(bodyGeo, CLAY[p.mat], +p.fade);
    scene.add(new THREE.Mesh(bodyGeo, MATS[p.mat]()));
  }

  scene.add(makeWater(p, size, alpha));
  // Disc mark: a 16-gon of global clip planes keeps the submerged clay from poking out past the water disc.
  if (+p.disc) renderer.clippingPlanes = Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2, R = +p.discr * 0.96;
    return new THREE.Plane(new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a)), R + Math.cos(a) * +p.tx + Math.sin(a) * +p.tz);
  });
  // Card sits inside the water plane (+-20) so no strip of its dark lower half shows above the water's far edge.
  if (!alpha && +p.horizon) scene.add(backdrop(camera, 17, p.bd === 'mint'));
  // Top-down views have nothing overhead to mirror; a soft skylight behind the camera gives the rings something to bend.
  if (+p.sky) softPanel(5, 5, '#ffffff', +p.sky, [1.2, 12, 1.6], scene);

  const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, samples: 8 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  if (+p.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(size, size), 0.12 * +p.bloom, 0.5, 0.9));
  composer.addPass(new OutputPass());
  return { scene, camera, composer, render: () => composer.render() };
}

export function paramsFrom(search) {
  const q = {};
  for (const [k, v] of new URLSearchParams(search)) q[k] = v;
  return q;
}
