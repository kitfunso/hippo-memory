// hippo round 6, "Tiny world": isometric clay diorama, a chunky hippo on a floating tile among decaying memory cubes.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const INK = '#0b0f0c', MINT = '#7ce38b';
export const PALS = {
  slate: { body: '#6f8092', belly: '#95a6b6', pink: '#dea6ad', sand: '#ecdfc3', rock: '#2a3238', dust: '#7d8883', sky: '#d8e7ea' },
  lilac: { body: '#9d95bf', belly: '#bfb7da', pink: '#e9a8b4', sand: '#f2e5c8', rock: '#3a3648', dust: '#8a8798', sky: '#e2e9ef' },
  ink: { body: '#3b4a52', belly: '#5e707a', pink: '#d99aa2', sand: '#e6d8b8', rock: '#1b2226', dust: '#6c7873', sky: '#d8e7ea' },
};
export const DEFAULTS = {
  view: 'hero', bg: 'ink', pal: 'slate', seed: 7, cubes: 16, zoom: 1, ao: 1, bloom: 1, post: 1, alpha: 0, exposure: 1,
  face: -30, tower: 0, sun: 2.0, hemi: 0.9, env: 0.35, glow: 1.3, cy: 0.9, hs: 1.3, cube: '-0.8,0.3,1.15', yaw: 45, pitch: 35.264, cubes: 13, turn: 0.22, tile: 5.4,
};

// Deterministic so a tweak of one knob does not reshuffle the cubes.
function rng(seed) { let s = (seed >>> 0) || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

const clay = (color, extra = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.8, metalness: 0, sheen: 0.6, sheenRoughness: 0.75, sheenColor: '#ffffff', envMapIntensity: 0.5, ...extra });
function shadowed(m) { m.castShadow = m.receiveShadow = true; return m; }
const rbox = (w, h, d, r, mat) => shadowed(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 7, r), mat));
const ball = (r, mat) => shadowed(new THREE.Mesh(new THREE.SphereGeometry(r, 40, 28), mat));
const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };

// Head faces +z; origin sits at the neck so hippo() and the icon can share it.
export function head(pal) {
  const body = clay(pal.body), belly = clay(pal.belly), pink = clay(pal.pink), dark = clay(new THREE.Color(pal.body).multiplyScalar(0.55));
  const eye = new THREE.MeshPhysicalMaterial({ color: '#0d1110', roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.8 });
  const white = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const g = new THREE.Group();
  g.add(at(rbox(1.35, 1.05, 1.1, 0.4, body), 0, 0, 0));
  g.add(at(rbox(1.6, 0.85, 1.0, 0.38, belly), 0, -0.3, 0.66));
  for (const s of [-1, 1]) {
    g.add(at(ball(0.22, body), s * 0.44, 0.4, 0.38));
    g.add(at(ball(0.13, eye), s * 0.47, 0.46, 0.55));
    g.add(at(ball(0.04, white), s * 0.47 - 0.04, 0.52, 0.65));
    g.add(at(ball(0.16, body), s * 0.46, 0.52, -0.2));
    g.add(at(ball(0.085, pink), s * 0.48, 0.54, -0.09));
    g.add(at(ball(0.075, dark), s * 0.3, 0.12, 1.03));
  }
  return g;
}

export function hippo(pal) {
  const body = clay(pal.body), belly = clay(pal.belly);
  const g = new THREE.Group();
  g.add(at(rbox(1.55, 1.2, 2.15, 0.5, body), 0, 1.05, -0.15));
  g.add(at(rbox(1.4, 0.6, 1.8, 0.28, belly), 0, 0.72, -0.1));
  for (const [x, z] of [[-0.55, 0.5], [0.55, 0.5], [-0.55, -0.85], [0.55, -0.85]]) g.add(at(rbox(0.5, 0.75, 0.5, 0.18, body), x, 0.37, z));
  const tail = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.28, 6, 16), body));
  tail.position.set(0, 1.15, -1.28); tail.rotation.x = 0.4; g.add(tail);
  const hd = at(head(pal), 0, 1.25, 1.0);
  hd.scale.setScalar(1.1); g.add(hd);
  return g;
}

function island(pal, w) {
  const g = new THREE.Group(), rock = clay(pal.rock);
  g.add(at(rbox(w, 0.55, w, 0.14, clay(pal.sand)), 0, -0.275, 0));
  g.add(at(rbox(w - 0.5, 1.2, w - 0.5, 0.3, rock), 0, -1.1, 0));
  g.add(at(rbox(w - 1.8, 1.0, w - 1.8, 0.35, rock), 0, -2.1, 0));
  g.add(at(rbox(w - 3.5, 0.8, w - 3.5, 0.35, rock), 0, -2.85, 0));
  for (const [x, z, s] of [[1.9, -1.6, 0.34], [2.15, -1.2, 0.22], [-2.0, 1.7, 0.26]]) g.add(at(rbox(s, s * 0.7, s, s * 0.3, rock), x, s * 0.3, z));
  return g;
}

// A small archive tower in the back corner: sand blocks with one lit mint doorway.
function tower(pal) {
  const g = new THREE.Group(), sand = clay(pal.sand);
  g.add(at(rbox(1.2, 1.1, 1.2, 0.1, sand), 0, 0.55, 0));
  g.add(at(rbox(0.7, 0.7, 0.7, 0.08, sand), 0, 1.4, 0));
  const door = at(rbox(0.32, 0.46, 0.2, 0.05, clay(MINT, { emissive: MINT, emissiveIntensity: 1.4 })), 0, 0.33, 0.58);
  g.add(door);
  return g;
}

// Memories rise from the hippo's head like thought bubbles and drift screen-left (-x,+z keeps screen height in iso).
function cubes(pal, n, seed, origin, glow, face, p_turn) {
  const r = rng(seed), g = new THREE.Group(), mint = new THREE.Color(MINT), dust = new THREE.Color(pal.dust);
  const fr = THREE.MathUtils.degToRad(face), sx = origin.x + Math.sin(fr) * 0.9, sz = origin.z + Math.cos(fr) * 0.9;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1); // 0 = freshest memory, 1 = forgotten
    const drift = i * +p_turn + i * i * 0.012, h = origin.y + 3.5 + i * 0.36 + (r() - 0.5) * 0.2;
    const x = sx - drift + (r() - 0.5) * 0.3, z = sz + drift + (r() - 0.5) * 0.3, s = 0.46 - t * 0.18;
    const fade = Math.max(0, t - 0.3) / 0.7;
    const mat = clay(mint.clone().lerp(dust, fade), { emissive: MINT, emissiveIntensity: Math.max(0, 1 - t * 1.5) * glow, roughness: 0.55 });
    if (t < 0.55) { const c = at(rbox(s, s, s, s * 0.22, mat), x, h, z); c.rotation.set((r() - 0.5) * t, r() * 1.5, (r() - 0.5) * t); g.add(c); continue; }
    // Crumbling: the cube loses a corner, then breaks into chunks with a trail of voxel dust falling away.
    const k = 1 + Math.floor((t - 0.55) * 8);
    for (let j = 0; j < k; j++) { const cs = s * (0.72 - j * 0.12); g.add(at(rbox(cs, cs, cs, cs * 0.2, mat), x + (r() - 0.5) * s * 1.3 * j, h - j * s * 0.5, z + (r() - 0.5) * s * 1.3 * j)); }
    for (let j = 0; j < 2 + k; j++) { const ds = 0.05 + r() * 0.06; g.add(at(rbox(ds, ds, ds, ds * 0.2, mat), x + (r() - 0.5) * s * 1.6, h - 0.2 - r() * 1.2, z + (r() - 0.5) * s * 1.6)); }
  }
  g.traverse((m) => { m.castShadow = m.receiveShadow = false; }); // VSM maps receivers too; cube shadows on the back read as dirt
  return g;
}

// Camera-facing gradient card; noise baked in because an 8-bit gradient bands into contours.
function backdrop(bg, pal, size, dist, camera) {
  const c = document.createElement('canvas'), N = 1024;
  c.width = c.height = N;
  const g = c.getContext('2d'), grad = g.createRadialGradient(N / 2, N * 0.45, 10, N / 2, N * 0.5, N * 0.7);
  if (bg === 'sky') { grad.addColorStop(0, '#f3f7f6'); grad.addColorStop(1, pal.sky); }
  else { grad.addColorStop(0, '#1c2420'); grad.addColorStop(0.55, '#101612'); grad.addColorStop(1, INK); }
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

export async function createScene(renderer, size, q = {}) {
  const p = { ...DEFAULTS, ...q }, pal = PALS[p.pal] || PALS.slate, alpha = !!+p.alpha, icon = p.view === 'icon';
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = +p.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.setClearColor(p.bg === 'sky' ? pal.sky : INK, alpha ? 0 : 1);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = +p.env;
  pmrem.dispose();

  const world = new THREE.Group();
  scene.add(world);
  let f, target;
  if (icon) {
    const h = head(pal);
    h.rotation.y = THREE.MathUtils.degToRad(+p.face);
    world.add(h);
    const cube = at(rbox(0.5, 0.5, 0.5, 0.1, clay(MINT, { emissive: MINT, emissiveIntensity: +p.glow, roughness: 0.55 })), ...p.cube.split(',').map(Number));
    cube.rotation.set(0.3, 0.6, 0.2);
    cube.add(new THREE.PointLight(MINT, 2.5, 3, 1.5)); // the memory lights the face that recalls it
    world.add(cube);
    f = 1.4 / +p.zoom; target = new THREE.Vector3(-0.25, +p.cy, 0.5);
  } else {
    world.add(island(pal, +p.tile));
    const hp = new THREE.Vector3(0.15, 0, 0.3), h = hippo(pal);
    h.position.copy(hp); h.rotation.y = THREE.MathUtils.degToRad(+p.face); h.scale.setScalar(+p.hs);
    world.add(h);
    if (+p.tower) world.add(at(tower(pal), -1.9, 0, -1.9));
    world.add(cubes(pal, +p.cubes, +p.seed, hp, +p.glow, +p.face, +p.turn));
    f = 5.0 / +p.zoom; target = new THREE.Vector3(0, +p.cy, 0);
  }

  // Defaults are true isometric (yaw 45, elevation 35.264 = the (1,1,1) diagonal); the icon drops lower to show the face.
  const camera = new THREE.OrthographicCamera(-f, f, f, -f, 0.1, 100);
  const cy = THREE.MathUtils.degToRad(+p.yaw), cp = THREE.MathUtils.degToRad(+p.pitch);
  camera.position.set(Math.sin(cy) * Math.cos(cp), Math.sin(cp), Math.cos(cy) * Math.cos(cp)).multiplyScalar(35).add(target);
  camera.lookAt(target);

  const sun = new THREE.DirectionalLight('#fff6ea', +p.sun);
  sun.position.set(-6, 11, 7).add(target); sun.target.position.copy(target); scene.add(sun.target);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096); sun.shadow.radius = 5; sun.shadow.blurSamples = 24; sun.shadow.bias = -0.0004;
  const sb = icon ? 3 : 8;
  Object.assign(sun.shadow.camera, { left: -sb, right: sb, top: sb, bottom: -sb, near: 1, far: 40 });
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(p.bg === 'sky' ? '#eaf2f6' : '#cfe0ea', '#6b5a48', +p.hemi));
  if (!alpha) scene.add(backdrop(p.bg, pal, 60, 30, camera));

  if (!+p.post) return { scene, camera, render: () => renderer.render(scene, camera) };
  const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  if (+p.ao) {
    const gtao = new GTAOPass(scene, camera, size, size);
    gtao.blendIntensity = 0.55;
    gtao.updateGtaoMaterial({ radius: icon ? 0.25 : 0.45, distanceExponent: 1, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
    const hide = gtao._overrideVisibility.bind(gtao);
    gtao._overrideVisibility = () => { hide(); scene.traverse((o) => { if (o.userData.noAO && o.visible) { o.visible = false; gtao._visibilityCache.push(o); } }); };
    composer.addPass(gtao);
  }
  if (+p.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(size, size), p.bg === 'sky' ? 0.12 : 0.28, 0.5, 0.97));
  composer.addPass(new OutputPass());
  return { scene, camera, render: () => composer.render() };
}
