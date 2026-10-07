// Shared helpers for the round-6 sediment and chrome scenes: canvas textures, env panels, composer.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const INK = '#0b0f0c', MINT = '#7ce38b', MINT_LIGHT = '#a7f0b1', AMBER = '#f2b84b';

let seed = 7;
export const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

// Octave value noise: a tiny random canvas scaled up with bilinear smoothing, summed at halving alpha.
export function noiseCanvas(N = 1024, octaves = 5, base = 8) {
  const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, N, N);
  for (let o = 0; o < octaves; o++) {
    const n = base << o, s = document.createElement('canvas'); s.width = s.height = n;
    const sg = s.getContext('2d'), img = sg.createImageData(n, n);
    for (let i = 0; i < img.data.length; i += 4) { const v = rnd() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
    sg.putImageData(img, 0, 0);
    g.globalAlpha = 0.5 / (o + 1); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(s, 0, 0, N, N);
  }
  g.globalAlpha = 1;
  return c;
}

export function tex(canvas, srgb = false, repeat = 1) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Vertical gradient plane for PMREM studio envs; k > 1 makes it an HDR emitter.
export function gradPanel(scene, w, h, stops, k, pos, target = [0, 0, 0]) {
  const c = document.createElement('canvas'); c.width = 8; c.height = 256;
  const g = c.getContext('2d'), grad = g.createLinearGradient(0, 0, 0, 256);
  stops.forEach(([at, col]) => grad.addColorStop(at, col));
  g.fillStyle = grad; g.fillRect(0, 0, 8, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(k, k, k), side: THREE.DoubleSide }));
  m.position.set(...pos); m.lookAt(...target); scene.add(m);
  return m;
}

export function pmrem(renderer, envScene) {
  const gen = new THREE.PMREMGenerator(renderer);
  const t = gen.fromScene(envScene, 0.03).texture;
  gen.dispose();
  return t;
}

// Camera-facing gradient card with baked grain (8-bit ink gradients band otherwise).
export function backdrop(size, dist, camera, inner, outer, cy = 0.45) {
  const c = document.createElement('canvas'), N = 1024;
  c.width = c.height = N;
  const g = c.getContext('2d'), grad = g.createRadialGradient(N / 2, N * cy, 10, N / 2, N * 0.5, N * 0.7);
  grad.addColorStop(0, inner); grad.addColorStop(1, outer);
  g.fillStyle = grad; g.fillRect(0, 0, N, N);
  const img = g.getImageData(0, 0, N, N), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 4; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: t }));
  m.position.copy(camera.position).normalize().multiplyScalar(-dist); m.lookAt(camera.position);
  m.userData.noAO = true;
  return m;
}

export function orbitCamera(fov, yaw, pitch, dist, lookY = 0) {
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 200);
  const y = THREE.MathUtils.degToRad(yaw), p = THREE.MathUtils.degToRad(pitch);
  camera.position.set(dist * Math.sin(y) * Math.cos(p), lookY + dist * Math.sin(p), dist * Math.cos(y) * Math.cos(p));
  camera.lookAt(0, lookY, 0);
  return camera;
}

// Post chain; alpha renders skip it because bloom and GTAO both flatten the alpha channel.
export function makeComposer(renderer, scene, camera, size, { ao = 0, aoRadius = 0.3, bloom = 0, bloomThreshold = 0.9, smaa = 1, alpha = false }) {
  if (alpha) return { render: () => renderer.render(scene, camera) };
  const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  if (ao) {
    const gtao = new GTAOPass(scene, camera, size, size);
    gtao.output = GTAOPass.OUTPUT.Default;
    gtao.blendIntensity = ao;
    gtao.updateGtaoMaterial({ radius: aoRadius, distanceExponent: 1, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
    const hide = gtao._overrideVisibility.bind(gtao);
    gtao._overrideVisibility = () => { hide(); scene.traverse((o) => { if (o.userData.noAO && o.visible) { o.visible = false; gtao._visibilityCache.push(o); } }); };
    composer.addPass(gtao);
  }
  if (bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(size, size), bloom, 0.5, bloomThreshold));
  composer.addPass(new OutputPass());
  if (smaa) composer.addPass(new SMAAPass());
  return { render: () => composer.render() };
}
