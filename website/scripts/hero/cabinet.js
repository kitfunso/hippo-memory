// The home hero scene, rendered at build time by render-hero.mjs into the poster and the video. Procedural, no assets.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { CYCLE, STILL_T, dayAt } from '../../src/scripts/hero-timeline.js';

const RULE = ['we use pnpm, never npm', 'the lockfile is pnpm-lock.yaml', 'mem_7f6b06db'];

// Async so setup yields to the page between steps and shaders compile off the main path.
export async function mount(canvas, opts = {}) {
  const still = !!opts.still;
  const breathe = () => new Promise((r) => setTimeout(r, 0));
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: !!opts.capture, failIfMajorPerformanceCaveat: !opts.capture });
  renderer.setPixelRatio(Math.min(devicePixelRatio, opts.dpr ?? 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  await breathe();

  const camera = new THREE.PerspectiveCamera(27, 4 / 3, 0.1, 100);
  const camBase = new THREE.Vector3(6.6, 5.4, 10.6);
  const target = new THREE.Vector3(-0.35, 2.05, 0.4);
  camera.position.copy(camBase);
  camera.lookAt(target);

  const key = new THREE.DirectionalLight(0xfff1dc, 2.4);
  key.position.set(-4, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5 });
  key.shadow.radius = 6; key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0xfffaf0, 0xd9cdb8, 0.55));

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.14 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  const oakTex = woodTexture();
  await breathe();
  const oak = new THREE.MeshPhysicalMaterial({ map: oakTex, roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.4 });
  const oakDark = new THREE.MeshPhysicalMaterial({ map: oakTex, color: 0xc9b39a, roughness: 0.6, clearcoat: 0.2 });
  const brass = new THREE.MeshPhysicalMaterial({ color: 0xc9a25e, metalness: 1, roughness: 0.28 });
  const paper = new THREE.MeshStandardMaterial({ color: 0xfbf7ee, roughness: 0.92 });
  const paperShade = new THREE.MeshStandardMaterial({ color: 0xefe7d6, roughness: 0.95 });
  const shadowy = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };
  const box = (w, h, d, mat, r = 0.03) => shadowy(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), mat));

  const cab = new THREE.Group(); scene.add(cab);
  const W = 3.3, H = 2.5, D = 2.3, plinthH = 0.32;
  const plinth = box(W - 0.12, plinthH, D - 0.12, oakDark, 0.02); plinth.position.y = plinthH / 2; cab.add(plinth);
  const body = box(W, H, D, oak, 0.04); body.position.y = plinthH + H / 2; cab.add(body);
  const top = box(W + 0.16, 0.12, D + 0.14, oak, 0.04); top.position.y = plinthH + H + 0.06; cab.add(top);

  const cols = 2, rows = 3, gap = 0.07, inset = 0.13;
  const fw = (W - 2 * inset - (cols - 1) * gap) / cols, fh = (H - 2 * inset - (rows - 1) * gap) / rows;
  const labels = [['A to F', 'G to L'], ['M to R', 'S to Z'], ['rules', 'errors']];
  const drawers = [];
  const recessMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, roughness: 1 });
  const HOST = 4; // the one drawer that opens; the closed ones get no tray, since nothing inside them shows
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const g = new THREE.Group();
    const x = -W / 2 + inset + fw / 2 + c * (fw + gap);
    const y = plinthH + H - inset - fh / 2 - r * (fh + gap);
    g.position.set(x, y, D / 2 + 0.005); cab.add(g);
    const recess = new THREE.Mesh(new THREE.PlaneGeometry(fw + 0.035, fh + 0.035), recessMat);
    recess.position.set(x, y, D / 2 + 0.002); cab.add(recess);
    const front = box(fw, fh, 0.09, oak, 0.025); front.position.z = 0.03; g.add(front);
    const frame = box(0.66, 0.26, 0.025, brass, 0.01); frame.position.set(0, fh * 0.17, 0.085); g.add(frame);
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.19), new THREE.MeshStandardMaterial({ map: labelTexture(labels[r][c], opts.serif), roughness: 0.9, emissive: 0xffffff, emissiveIntensity: 0.18 }));
    lab.material.emissiveMap = lab.material.map;
    lab.position.set(0, fh * 0.17, 0.0985); g.add(lab);
    const pull = shadowy(new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.028, 12, 32, Math.PI), brass));
    pull.rotation.z = Math.PI; pull.position.set(0, -fh * 0.12, 0.1); g.add(pull);
    for (const s of [-1, 1]) { const rv = shadowy(new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), brass)); rv.position.set(s * 0.16, -fh * 0.12, 0.09); g.add(rv); }
    drawers.push({ g, fh });
    if (r * cols + c !== HOST) continue;
    const tray = new THREE.Group(); tray.position.z = -0.03; g.add(tray);
    const trayD = 1.9, wall = 0.04;
    const floor = box(fw - 0.12, wall, trayD, oakDark, 0.01); floor.position.set(0, -fh / 2 + 0.08, -trayD / 2); tray.add(floor);
    for (const s of [-1, 1]) { const side = box(wall, fh * 0.55, trayD, oakDark, 0.01); side.position.set(s * (fw / 2 - 0.08), -fh / 2 + 0.08 + fh * 0.27, -trayD / 2); tray.add(side); }
    const n = 34, cw = fw - 0.26, ch = fh * 0.74;
    for (let i = 0; i < n; i++) {
      const card = shadowy(new THREE.Mesh(new THREE.BoxGeometry(cw, ch, 0.008), i % 9 === 0 ? paperShade : paper));
      card.position.set(0, -fh / 2 + 0.1 + ch / 2, -0.12 - i * 0.05);
      card.rotation.x = -0.12 - Math.sin(i * 1.7) * 0.03;
      tray.add(card);
      if (i % 6 === 2) { const tab = shadowy(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.008), paperShade)); tab.position.set(((i / 6) % 3 - 1) * cw * 0.32, ch / 2 + 0.04, 0); card.add(tab); }
    }
  }

  const heroCard = new THREE.Group(); scene.add(heroCard);
  const cardMat = new THREE.MeshBasicMaterial({ color: 0xf7f2e8, transparent: true, toneMapped: false }); // unlit so the ink stays legible
  const back = new THREE.MeshStandardMaterial({ color: 0xf6f0e2, roughness: 0.9, transparent: true });
  cardMat.map = cardTexture(...RULE, opts.mono);
  const cardMesh = shadowy(new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.22, 0.014), [back, back, back, back, cardMat, back]));
  heroCard.add(cardMesh);

  const host = drawers[HOST];
  bake(cab, host.g); // one draw call per material: the static cabinet, then the drawer that moves
  bake(host.g);
  await breathe();
  const restPos = new THREE.Vector3(), upPos = new THREE.Vector3(-0.75, 3.9, 3.1);
  const restQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.1, 0, 0)), upQ = new THREE.Quaternion();
  { const m = new THREE.Matrix4().lookAt(camBase, upPos, new THREE.Vector3(0, 1, 0)); upQ.setFromRotationMatrix(m); upQ.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.03, -0.14, 0.025))); }
  const clamp = (t) => Math.min(1, Math.max(0, t));
  const ease = (t) => 1 - Math.pow(1 - clamp(t), 3);
  const easeIO = (t) => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };

  let pointerX = 0, pointerY = 0, px = 0, py = 0;
  canvas.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); pointerX = (e.clientX - r.left) / r.width - 0.5; pointerY = (e.clientY - r.top) / r.height - 0.5; });
  canvas.addEventListener('pointerleave', () => { pointerX = 0; pointerY = 0; });

  function pose(t) {
    const k = t % CYCLE;
    // open: shut 3.2 to 5.4, open again by 6.5; lift: down 1.4 to 3.0, up 6.3 to 7.9; fade in 0 to 0.7, out 11.3 to 12
    const open = 1 - ease((k - 3.0) / 1.0) + ease((k - 5.4) / 1.1);
    host.g.position.z = D / 2 + 0.005 + clamp(open) * 1.25;
    const lift = 1 - easeIO((k - 1.4) / 1.6) + easeIO((k - 6.3) / 1.6);
    const alpha = clamp(k / 0.7) - clamp((k - 11.3) / 0.7);
    host.g.updateMatrixWorld(true);
    restPos.set(0, -host.fh / 2 + 0.12 + 0.46, -0.08).applyMatrix4(host.g.matrixWorld);
    heroCard.position.lerpVectors(restPos, upPos, clamp(lift));
    heroCard.quaternion.slerpQuaternions(restQ, upQ, clamp(lift));
    heroCard.scale.setScalar(0.62 + 0.56 * clamp(lift)); // fits the drawer at rest, reads at full size when up
    heroCard.position.y += Math.sin(t * 1.3) * 0.02 * clamp(lift);
    cardMat.opacity = back.opacity = alpha;
    cardMesh.castShadow = alpha > 0.95;
    heroCard.visible = alpha > 0.01 && (open > 0.02 || lift > 0.02);
    return { day: dayAt(t), k };
  }

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  resize(); addEventListener('resize', resize);

  const clock = new THREE.Clock();
  let raf = 0, visible = true, t0 = opts.t ?? 0, lastDay = '';
  const draw = (t) => {
    const s = pose(t);
    px += (pointerX - px) * 0.05; py += (pointerY - py) * 0.05;
    cab.rotation.y = px * 0.1; camera.position.set(camBase.x, camBase.y - py * 0.5, camBase.z); camera.lookAt(target);
    renderer.render(scene, camera);
    if (s.day !== lastDay) { lastDay = s.day; opts.onDay?.(s.day); }
  };
  const frame = () => { draw(still ? STILL_T : t0 + clock.getElapsedTime()); if (!still && visible) raf = requestAnimationFrame(frame); };
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; cancelAnimationFrame(raf); if (visible && !still) raf = requestAnimationFrame(frame); });
  await renderer.compileAsync(scene, camera);
  io.observe(canvas);
  frame();
  return {
    renderAt: (t) => { t0 = t; clock.start(); draw(t); },
    dispose: () => { cancelAnimationFrame(raf); io.disconnect(); renderer.dispose(); },
  };
}

// Merges every mesh under root that shares a material into one mesh in root's space; meshes under skip stay as they are.
function bake(root, skip) {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const byMat = new Map(), merged = [];
  root.traverse((o) => {
    if (!o.isMesh || Array.isArray(o.material)) return;
    for (let p = o; p; p = p.parent) if (p === skip) return;
    const geo = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(inv.clone().multiply(o.matrixWorld));
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (!byMat.has(o.material)) byMat.set(o.material, { geos: [], cast: false, receive: false });
    const e = byMat.get(o.material);
    e.geos.push(geo); e.cast ||= o.castShadow; e.receive ||= o.receiveShadow;
    merged.push(o);
  });
  for (const o of merged) { o.geometry.dispose(); o.removeFromParent(); }
  for (const [mat, e] of byMat) {
    const m = new THREE.Mesh(mergeGeometries(e.geos), mat);
    m.castShadow = e.cast; m.receiveShadow = e.receive; root.add(m);
  }
}

function woodTexture() {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#8f5d36'; g.fillRect(0, 0, 1024, 1024);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    const y = rnd() * 1024, a = 0.05 + rnd() * 0.14, w = 0.6 + rnd() * 2.4;
    g.strokeStyle = `rgba(${90 + rnd() * 30},${55 + rnd() * 20},${25 + rnd() * 15},${a})`;
    g.lineWidth = w; g.beginPath();
    for (let x = 0; x <= 1024; x += 16) g.lineTo(x, y + Math.sin(x / 140 + i) * 6 + Math.sin(x / 37 + i * 3) * 1.5);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  return t;
}

function labelTexture(text, serif = 'Georgia, serif') {
  const c = document.createElement('canvas'); c.width = 512; c.height = 168;
  const g = c.getContext('2d'); g.fillStyle = '#f8f2e4'; g.fillRect(0, 0, 512, 168);
  g.fillStyle = '#2a2219'; g.font = `500 76px ${serif}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 256, 90);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

function cardTexture(rule, why, id, mono = 'Consolas, monospace') {
  const c = document.createElement('canvas'); c.width = 1500; c.height = 920;
  const g = c.getContext('2d');
  g.fillStyle = '#fdfaf2'; g.fillRect(0, 0, 1500, 920);
  g.strokeStyle = 'rgba(196,72,60,0.55)'; g.lineWidth = 4; g.beginPath(); g.moveTo(0, 190); g.lineTo(1500, 190); g.stroke();
  g.strokeStyle = 'rgba(70,120,180,0.28)'; g.lineWidth = 2;
  for (let y = 270; y < 900; y += 80) { g.beginPath(); g.moveTo(0, y); g.lineTo(1500, y); g.stroke(); }
  g.fillStyle = '#6b6256'; g.font = `400 50px ${mono}`; g.fillText(id, 90, 125);
  g.textAlign = 'right'; g.fillText('rule · pinned', 1410, 125); g.textAlign = 'left';
  g.fillStyle = '#1f1b16'; g.font = `600 100px ${mono}`; g.fillText(rule, 90, 345);
  g.fillStyle = '#3d362e'; g.font = `400 68px ${mono}`; g.fillText(why, 90, 505);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
