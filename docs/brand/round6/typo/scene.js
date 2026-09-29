// hippo round 6, direction "typographic sculpture": the wordmark decays letter by letter, left to right.
import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const INK = '#0b0f0c', MINT = '#7ce38b', AMBER = '#f2b84b';
const FONT_URL = 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/fonts/helvetiker_bold.typeface.json';

export const DEFAULTS = {
  word: 'hippo', stages: 's,g,f,w,d', depth: 0.45, bev: 0.02, field: '#121a14', ink: '#0b0f0c',
  cam: 'low', fov: 30, dis: 1, dstart: 0.3, dmat: '', edge: 0.1, freq: 9, frags: 220, wire: 6, glow: 0.9, key: 1, exposure: 1, pal: 'ink', edgeGlow: 2.5,
  bg: 'field', axis: 'x', bloom: 1, ao: 1, letterGap: 0, tone: 'neutral', wall: 1, floor: 0, sunx: -3, suny: 4, sunz: 5, shadow: 1,
};

// ---------- dissolve: noise-eaten surface with a lit rim, on both the lit material and its shadow-depth material ----------

const NOISE = `
float hash3(vec3 p){ p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1,0,0)), f.x), mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x), mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fbm(vec3 p){ return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.1 + 7.0) + 0.15 * vnoise(p * 4.3 + 3.0); }
uniform float uDis, uEdge, uFreq, uEdgeDark; uniform vec3 uA, uB, uEdgeCol; varying vec3 vDisPos;
`;

function dissolve(mat, u) {
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    s.vertexShader = s.vertexShader
      .replace('void main() {', 'varying vec3 vDisPos;\nvoid main() {')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvDisPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('void main() {', NOISE + 'void main() {')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nfloat dn = fbm(vDisPos * uFreq); float dth = uDis * smoothstep(0.0, 1.0, dot(vDisPos - uA, uB)); if (dn < dth) discard;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(uEdgeDark, 1.0, smoothstep(0.0, uEdge, dn - dth));')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uEdgeCol * (1.0 - smoothstep(0.0, uEdge, dn - dth));');
  };
  mat.customProgramCacheKey = () => 'dissolve';
  return mat;
}

// ---------- letters ----------

const PM = (o) => new THREE.MeshPhysicalMaterial(o);
// Two palettes: mint type on an ink field, or (the bend) ink type on a mint field where glass has something to refract.
const PALETTES = {
  ink: {
    s: () => PM({ color: MINT, emissive: MINT, emissiveIntensity: 0.25, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.15, envMapIntensity: 0.8 }),
    g: () => PM({ color: '#dcfae1', transmission: 1, roughness: 0.1, thickness: 0.6, ior: 1.5, dispersion: 0.15, attenuationColor: MINT, attenuationDistance: 0.9, envMapIntensity: 1.8, emissive: MINT, emissiveIntensity: 0.2 }),
    f: () => PM({ color: '#f2fff4', transmission: 1, roughness: 0.4, thickness: 0.6, ior: 1.46, attenuationColor: '#b8f0c1', attenuationDistance: 1.4, envMapIntensity: 1.6, emissive: MINT, emissiveIntensity: 0.12 }),
    w: () => PM({ color: '#e8fff0', transmission: 1, roughness: 0.2, thickness: 0.4, ior: 1.4, attenuationColor: '#cbf5d2', attenuationDistance: 2, envMapIntensity: 0.6, opacity: 0.35, transparent: true }),
    d: () => PM({ color: '#e8fff0', transmission: 1, roughness: 0.25, thickness: 0.5, ior: 1.45, attenuationColor: '#cbf5d2', attenuationDistance: 1.2, envMapIntensity: 1.2, side: THREE.DoubleSide }),
    frag: () => new THREE.MeshStandardMaterial({ color: MINT, emissive: MINT, emissiveIntensity: 0.9, roughness: 0.6 }),
    line: MINT, edge: MINT,
  },
  mint: {
    s: () => PM({ color: '#0d120e', roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.12, envMapIntensity: 1 }),
    g: () => PM({ color: '#ffffff', transmission: 1, roughness: 0.06, thickness: 0.7, ior: 1.52, dispersion: 0.2, attenuationColor: '#3a7a47', attenuationDistance: 1.6, envMapIntensity: 1.2 }),
    f: () => PM({ color: '#ffffff', transmission: 1, roughness: 0.4, thickness: 0.7, ior: 1.46, attenuationColor: '#9fd8ab', attenuationDistance: 1.6, envMapIntensity: 1 }),
    w: () => PM({ color: '#ffffff', transmission: 1, roughness: 0.15, thickness: 0.4, ior: 1.4, attenuationColor: '#cbf5d2', attenuationDistance: 2, envMapIntensity: 0.5, opacity: 0.3, transparent: true }),
    d: () => PM({ color: '#ffffff', transmission: 1, roughness: 0.2, thickness: 0.5, ior: 1.45, attenuationColor: '#cbf5d2', attenuationDistance: 1.4, envMapIntensity: 1, side: THREE.DoubleSide }),
    frag: () => new THREE.MeshStandardMaterial({ color: '#0d120e', roughness: 0.4 }),
    line: '#0b0f0c', edge: '#000000', edgeDark: 0.08,
  },
  // Opaque mint for the transparent mark: transmission has nothing to refract over alpha.
  flat: {
    s: () => PM({ color: MINT, emissive: MINT, emissiveIntensity: 0.3, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.15, envMapIntensity: 0.8 }),
    g: () => PM({ color: '#5fc76f', roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 1 }),
    f: () => PM({ color: '#3f9c4e', roughness: 0.5, envMapIntensity: 0.8 }),
    w: () => PM({ color: MINT, roughness: 0.6, opacity: 0.06, transparent: true, depthWrite: false }),
    d: () => PM({ color: '#4fb35f', roughness: 0.45, envMapIntensity: 0.8, side: THREE.DoubleSide }),
    frag: () => new THREE.MeshStandardMaterial({ color: MINT, emissive: MINT, emissiveIntensity: 0.6, roughness: 0.6 }),
    line: MINT, edge: MINT,
  },
};

function letterGeometry(font, ch, size, depth, bev, segs) {
  const g = new TextGeometry(ch, { font, size, depth, curveSegments: 18, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelOffset: 0, bevelSegments: segs });
  g.computeBoundingBox();
  return g;
}

// Ray-cast point-in-polygon over the glyph outline minus its holes, in glyph space.
function insideShapes(shapes, x, y) {
  const inPoly = (pts) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c; } return c; };
  for (const sh of shapes) { if (inPoly(sh.getPoints(12)) && !sh.holes.some((h) => inPoly(h.getPoints(12)))) return true; }
  return false;
}

// Cubes where the letter has been eaten, drifting off along the decay axis: memory leaving as bits.
function fragments(shapes, bbox, count, axis, seed, size, mat, start) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  let rnd = seed;
  const R = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  const w = bbox.max.x - bbox.min.x, h = bbox.max.y - bbox.min.y, dz = bbox.max.z - bbox.min.z;
  let n = 0, guard = 0;
  while (n < count && guard++ < 20000) {
    const x = bbox.min.x + R() * w, y = bbox.min.y + R() * h, z = bbox.min.z + R() * dz;
    if (!insideShapes(shapes, x, y)) continue;
    const t = Math.max(0, (axis === 'x' ? (x - bbox.min.x) / w : 1 - (z - bbox.min.z) / dz) - start) / (1 - start);
    if (R() > t * t) continue;
    const drift = t * t * (0.25 + R() * 0.9);
    const dir = axis === 'x' ? new THREE.Vector3(1, 0.35 * (R() - 0.3), 0.4 * (R() - 0.5)) : new THREE.Vector3(0.3 * (R() - 0.5), 0.3 * (R() - 0.2), -1);
    pos.set(x, y, z).addScaledVector(dir.normalize(), drift);
    e.set(R() * 6.3, R() * 6.3, R() * 6.3); q.setFromEuler(e);
    const s = size * (0.35 + R() * R() * 1.4) * (1 - 0.5 * t);
    scl.setScalar(s);
    mesh.setMatrixAt(n++, m.compose(pos, q, scl));
  }
  mesh.count = n;
  mesh.castShadow = true;
  return mesh;
}

async function buildWord(p, size, env) {
  const font = await new FontLoader().loadAsync(FONT_URL);
  const stages = p.stages.split(',');
  const mats = PALETTES[p.pal] || PALETTES.ink;
  const scale = 1 / font.data.resolution;
  const word = new THREE.Group();
  const depth = +p.depth, bev = +p.bev;
  let x = 0;
  const letters = [], dissolves = [];
  for (let i = 0; i < p.word.length; i++) {
    const ch = p.word[i], stage = stages[i] || 's';
    const geo = letterGeometry(font, ch, 1, depth, bev, stage === 'w' ? 1 : 5);
    const holder = new THREE.Group();
    holder.position.x = x;
    const mat = mats[stage === 'd' && p.dmat ? p.dmat : stage]();
    if (stage === 'd') mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    holder.add(mesh);
    if (stage === 'w') {
      const box = new TextGeometry(ch, { font, size: 1, depth, curveSegments: 18, bevelEnabled: false });
      const lg = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(box, 40));
      const lm = new LineMaterial({ color: mats.line, linewidth: +p.wire, resolution: new THREE.Vector2(size, size), worldUnits: false });
      const lines = new LineSegments2(lg, lm);
      lines.userData.noAO = true; // GTAO's normal pass draws this instanced geometry as one big quad
      holder.add(lines);
    }
    if (stage === 'd') {
      const bb = geo.boundingBox;
      const A = new THREE.Vector3(), B = new THREE.Vector3();
      const w = bb.max.x - bb.min.x, dz = bb.max.z - bb.min.z, s = +p.dstart;
      if (p.axis === 'x') { A.set(x + bb.min.x + s * w, 0, 0); B.set(1 / (w * (1 - s)), 0, 0); }
      else { A.set(0, 0, bb.max.z - s * dz); B.set(0, 0, -1 / (dz * (1 - s))); }
      dissolves.push(A); // local now, shifted to world once the word is centred
      const u = { uDis: { value: +p.dis }, uEdge: { value: +p.edge }, uFreq: { value: +p.freq }, uA: { value: A }, uB: { value: B }, uEdgeCol: { value: new THREE.Color(mats.edge).multiplyScalar(+p.edgeGlow) }, uEdgeDark: { value: mats.edgeDark ?? 1 } };
      dissolve(mat, u);
      mesh.customDepthMaterial = dissolve(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide }), u);
      const shapes = font.generateShapes(ch, 1);
      holder.add(fragments(shapes, bb, +p.frags, p.axis, 7 + i, 0.05, mats.frag(), s));
    }
    word.add(holder);
    letters.push(holder);
    x += font.data.glyphs[ch].ha * scale + +p.letterGap;
  }
  word.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const h of letters) box.expandByObject(h.children[0]); // letters only: drifting fragments would skew the centre
  word.position.set(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, -(box.min.z + box.max.z) / 2);
  box.translate(word.position);
  for (const A of dissolves) A.add(word.position);
  word.userData.box = box;
  return word;
}

// ---------- environment and stage ----------

function studioEnv(renderer) {
  const s = new THREE.Scene();
  s.background = new THREE.Color('#050705');
  const panel = (w, h, color, k, pos) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(0, 0, 0); s.add(m);
  };
  panel(10, 4, '#ffffff', 5, [0, 8, 3]);
  panel(2, 9, '#ffffff', 2.4, [-8, 2, 2]);
  panel(1.2, 9, MINT, 3, [7, 1, -3]);
  panel(9, 6, '#ffffff', 1.6, [-1, 4, 10]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(s, 0.04).texture;
  pmrem.dispose();
  return tex;
}

const CAMS = {
  low: { pos: [-4.2, -2.6, 5.2], look: [0.15, 0.05, 0] },
  low2: { pos: [-5.5, -1.4, 4.2], look: [0.3, 0.1, 0] },
  low3: { pos: [-1.8, -3.2, 5.6], look: [0.1, 0.1, 0] },
  front: { pos: [0, 0, 9.2], look: [0, 0, 0] },
  icon: { pos: [2.0, 1.1, 3.4], look: [0, 0, 0] },
  iconfront: { pos: [1.2, 0.7, 3.9], look: [0, 0, 0] },
};

export async function createScene(renderer, size, q = {}) {
  const p = { ...DEFAULTS, ...q };
  const alpha = p.bg === 'none';
  renderer.toneMapping = p.tone === 'agx' ? THREE.AgXToneMapping : THREE.NeutralToneMapping;
  renderer.toneMappingExposure = +p.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(alpha ? 0x000000 : p.field, alpha ? 0 : 1);

  const scene = new THREE.Scene();
  scene.environment = studioEnv(renderer);
  scene.environmentIntensity = 1;

  const word = await buildWord(p, size, scene.environment);
  scene.add(word);
  const box = word.userData.box;
  const halfH = (box.max.y - box.min.y) / 2;

  const sun = new THREE.DirectionalLight('#ffffff', 3.2 * +p.key);
  sun.position.set(+p.sunx, +p.suny, +p.sunz); sun.castShadow = !!+p.shadow;
  sun.shadow.mapSize.set(4096, 4096); sun.shadow.radius = 1.2; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.01;
  Object.assign(sun.shadow.camera, { left: -3.2, right: 3.2, top: 3, bottom: -3, near: 0.5, far: 24 });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#ffffff', p.field, 0.35 * +p.key));
  const fill = new THREE.DirectionalLight(MINT, 0.6 * +p.key);
  fill.position.set(4, -1, 2); scene.add(fill);

  if (!alpha && +p.wall) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: p.field, roughness: 1 }));
    wall.position.z = box.min.z - 0.001; wall.receiveShadow = true; scene.add(wall);
  }
  if (!alpha && +p.floor) {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: p.field, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -halfH - 0.001; floor.receiveShadow = true; scene.add(floor);
  }

  const camera = new THREE.PerspectiveCamera(+p.fov, 1, 0.1, 100);
  const c = CAMS[p.cam] || CAMS.low;
  camera.position.set(...c.pos); camera.lookAt(...c.look);
  if (q.cx !== undefined) { camera.position.set(+q.cx, +q.cy, +q.cz); camera.lookAt(+(q.lx || 0), +(q.ly || 0), +(q.lz || 0)); }

  if (alpha) return { scene, camera, render: () => renderer.render(scene, camera) };

  const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  if (+p.ao) {
    const gtao = new GTAOPass(scene, camera, size, size);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = 0.6;
    gtao.updateGtaoMaterial({ radius: 0.25, distanceExponent: 1, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
    const hide = gtao._overrideVisibility.bind(gtao);
    gtao._overrideVisibility = () => { hide(); scene.traverse((o) => { if (o.userData.noAO && o.visible) { o.visible = false; gtao._visibilityCache.push(o); } }); };
    composer.addPass(gtao);
  }
  if (+p.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(size, size), 0.22 * +p.glow, 0.5, 0.9));
  composer.addPass(new OutputPass());
  return { scene, camera, render: () => composer.render() };
}
