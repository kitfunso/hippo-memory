// Turns the simulated field into a cast relief tablet (or disc) lit like a studio photograph.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const hex = (h) => new THREE.Color(h).convertSRGBToLinear();
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function blur(src, n, r) {
  const tmp = new Float32Array(n * n), dst = new Float32Array(n * n);
  for (let pass = 0; pass < 2; pass++) {
    const [a, b] = pass ? [tmp, dst] : [src, tmp];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let d = -r; d <= r; d++) {
        const x = pass ? i : Math.min(n - 1, Math.max(0, i + d)), y = pass ? Math.min(n - 1, Math.max(0, j + d)) : j;
        s += a[y * n + x]; c++;
      }
      b[j * n + i] = s / c;
    }
  }
  return dst;
}

function sampler(H, n) {
  return (u, v) => {
    const x = Math.min(n - 1.001, Math.max(0, u * (n - 1))), y = Math.min(n - 1.001, Math.max(0, v * (n - 1)));
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, o = j * n + i;
    return (H[o] * (1 - fx) + H[o + 1] * fx) * (1 - fy) + (H[o + n] * (1 - fx) + H[o + n + 1] * fx) * fy;
  };
}

export function buildSlab(renderer, field, SIZE, q, num) {
  const bs = sampler(field.B, field.n), n = num('tres', 1024);
  const peaks = recalled(field, num('glowk', 4), num('gsp', 0.14), num('glim', 1.2));
  const sg = num('gs', 0.012);
  const mask = (u, v) => peaks.reduce((m, [x, y]) => Math.max(m, Math.exp(-((u - x) ** 2 + (v - y) ** 2) / (2 * sg * sg))), 0);
  const disc = q.shape === 'disc', margin = num('margin', 0.035);
  const H = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { // threshold after interpolation keeps contours smooth
    const u = i / (n - 1), v = j / (n - 1);
    const edge = disc ? smooth(0.5, 0.5 - margin, Math.hypot(u - 0.5, v - 0.5))
      : smooth(0, margin, Math.min(u, v, 1 - u, 1 - v));
    H[j * n + i] = smooth(num('lo', 0.12), num('hi', 0.28), bs(u, v)) * edge;
  }
  const Hb = blur(H, n, Math.max(2, Math.round(n / 110)));
  const scene = new THREE.Scene();

  if (q.view === 'flat') {
    const img = new Uint8Array(n * n * 4);
    for (let i = 0; i < n * n; i++) { const c = 255 * H[i]; img.set([c, c, c, 255], 4 * i); }
    const t = new THREE.DataTexture(img, n, n); t.needsUpdate = true;
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: t })));
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2); cam.position.z = 1;
    return () => renderer.render(scene, cam);
  }

  const pal = q.pal || 'plaster';
  const ground = hex(pal === 'plaster' ? '#d9dfd9' : '#' + (q.gc || '0e130f')), top = hex(pal === 'plaster' ? '#eef2ee' : '#e9efe9');
  const mint = hex('#7ce38b');
  const col = new Uint8Array(n * n * 4), emi = new Uint8Array(n * n * 4);
  const lin2s = (x) => 255 * Math.pow(Math.min(1, x), 1 / 2.2);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const o = j * n + i, h = H[o], cav = smooth(-0.25, 0.05, h - Hb[o]);
    const ao = num('ao', 0.55) + (1 - num('ao', 0.55)) * cav;
    const m = mask(i / (n - 1), j / (n - 1)) * num('glow', 1);
    const c = ground.clone().lerp(top, h).lerp(mint, Math.min(1, m * h * 0.8)).multiplyScalar(ao);
    col.set([lin2s(c.r), lin2s(c.g), lin2s(c.b), 255], 4 * o);
    const e = Math.min(1, m * Math.pow(h, 1.5));
    emi.set([lin2s(mint.r * e), lin2s(mint.g * e), lin2s(mint.b * e), 255], 4 * o);
  }
  const tex = (d) => {
    const t = new THREE.DataTexture(d, n, n); t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.anisotropy = 8; t.needsUpdate = true; return t;
  };

  const W = 2, M = num('m', 1200), rh = num('rh', 0.035);
  const g2 = disc ? discGeometry(W, M) : new THREE.PlaneGeometry(W, W, M, M);
  const hs = sampler(H, n), pos = g2.attributes.position, uv = g2.attributes.uv;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, rh * hs(uv.getX(i), uv.getY(i)));
  g2.computeVertexNormals();
  g2.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshPhysicalMaterial({
    map: tex(col), emissiveMap: tex(emi), emissive: 0xffffff, emissiveIntensity: num('ei', 2.2),
    roughness: num('rough', 0.62), clearcoat: num('cc', 0.15), clearcoatRoughness: 0.5,
    sheen: pal === 'plaster' ? 0.2 : 0, sheenColor: 0xffffff, // white sheen greys out the ink ground
  });
  const relief = new THREE.Mesh(g2, mat);
  relief.castShadow = relief.receiveShadow = true;
  const T = num('thick', 0.14);
  const baseMat = new THREE.MeshPhysicalMaterial({ color: ground.clone().multiplyScalar(0.9), roughness: 0.7 });
  const base = new THREE.Mesh(disc ? new THREE.CylinderGeometry(W / 2, W / 2, T, 256) : new THREE.BoxGeometry(W, T, W), baseMat);
  base.position.y = -T / 2 - 0.0005; base.receiveShadow = base.castShadow = true;
  const obj = new THREE.Group(); obj.add(relief, base);
  obj.rotation.y = num('spin', 0) * Math.PI / 180;
  scene.add(obj);

  const alpha = !!num('alpha', 0);
  if (!alpha) scene.background = hex(q.bg ? '#' + q.bg : '#0b0f0c');
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.5 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -T; floor.receiveShadow = true;
  if (!alpha) scene.add(floor);

  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = num('env', 0.35);
  const el = num('el', 24) * Math.PI / 180, az = num('az', 135) * Math.PI / 180;
  const sun = q.light === 'spot' ? new THREE.SpotLight(0xfff6ea, num('sun', 3.2), 0, num('cone', 0.32), 1, 0)
    : new THREE.DirectionalLight(0xfff6ea, num('sun', 3.2));
  sun.position.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).multiplyScalar(6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -1.8, right: 1.8, top: 1.8, bottom: -1.8, near: 0.5, far: 14 });
  sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.004; sun.shadow.radius = num('sr', 3);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xdde8ff, num('fill', 0.35));
  fill.position.set(-sun.position.x, 3, -sun.position.z);
  scene.add(fill);

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = num('exp', 1.0);
  if (alpha) renderer.setClearColor(0x000000, 0);

  const pitch = num('pitch', 58) * Math.PI / 180, yaw = num('yaw', 0) * Math.PI / 180, dist = num('dist', 5.2);
  const cam = new THREE.PerspectiveCamera(num('fov', 26), 1, 0.1, 60);
  const tgt = new THREE.Vector3(num('tx', 0), 0, num('tz', 0));
  cam.position.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(dist).add(tgt);
  if (num('pitch', 58) > 89.9) cam.up.set(0, 0, -1);
  cam.lookAt(tgt);

  if (alpha || num('bloom', 0.35) <= 0) return () => renderer.render(scene, cam);
  const comp = new EffectComposer(renderer, new THREE.WebGLRenderTarget(SIZE, SIZE, { type: THREE.HalfFloatType, samples: 4 }));
  comp.setPixelRatio(1); comp.setSize(SIZE, SIZE);
  comp.addPass(new RenderPass(scene, cam));
  comp.addPass(new UnrealBloomPass(new THREE.Vector2(SIZE, SIZE), num('bloom', 0.35), 0.5, num('bth', 0.85)));
  comp.addPass(new OutputPass());
  return () => comp.render();
}

// The recalled cells are the survivors deepest in the forgotten zone, kept apart so they never pair up.
function recalled({ n, B, g }, k, spacing, gmax) {
  const pk = [];
  for (let j = 3; j < n - 3; j++) for (let i = 3; i < n - 3; i++) {
    const b = B[j * n + i];
    if (b < 0.2) continue;
    let top = true;
    for (let y = -3; y <= 3 && top; y++) for (let x = -3; x <= 3; x++) if (B[(j + y) * n + i + x] > b) { top = false; break; }
    const u = i / (n - 1), v = j / (n - 1);
    if (top && g(u, v) < gmax && Math.min(u, v, 1 - u, 1 - v) > 0.07) pk.push([u, v, g(u, v)]);
  }
  pk.sort((a, b) => b[2] - a[2]);
  const out = [];
  for (const p of pk) if (out.length < k && out.every((o) => Math.hypot(o[0] - p[0], o[1] - p[1]) > spacing)) out.push(p);
  console.log('recalled', JSON.stringify(out.map((p) => p.map((x) => +x.toFixed(3)))));
  return out;
}

function discGeometry(W, M) {
  const g = new THREE.PlaneGeometry(W, W, M, M), p = g.attributes.position, R = W / 2;
  for (let i = 0; i < p.count; i++) { // squash the square grid onto the disc (elliptical grid map)
    const x = p.getX(i) / R, y = p.getY(i) / R;
    p.setXY(i, R * x * Math.sqrt(1 - y * y / 2), R * y * Math.sqrt(1 - x * x / 2));
  }
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / W + 0.5, p.getY(i) / W + 0.5);
  return g;
}
