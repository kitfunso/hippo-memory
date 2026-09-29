// hippo round 6, direction "holographic card": foil trading cards, one recalled (mint) and one marked wrong (amber).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const INK = '#0b0f0c', MINT = '#7ce38b', AMBER = '#f2b84b';
const CW = 1472, CH = 2048; // card texture, 63x88 trading-card ratio

const DEFAULTS = {
  mode: 'hero', kind: 'good', bg: 'field', field: INK, cardw: 2.5, thick: 0.07, bev: 0.02, corner: 0.16,
  irid: 1, iior: 1.9, tmin: 150, tmax: 700, period: 22, angle: 62, band: 0.35, rough: 0.1, rbase: 0.12, cc: 1, ccr: 0.06,
  emboss: 0.8, blur: 6, envi: 1.4, sweep: 14, key: 1.5, fov: 32, exposure: 1, bloom: 0.1, mirror: 1, mtint: '#666666', shadow: 0.55,
  plates: 0, ring: 1, frame: 1, text: 1, ering: 0, escale: 2.1, ptilt: 0.1, tilt: 0.28, lean: 0.12, gap: 0.9, depthgap: 0.9, tintmix: 0.35, dull: 0.22, wave: 0.08,
  ax: 2, ay: 3.5, az: 9, arot: 0, sunx: -3, suny: 7, sunz: 6, env: 'room', back: 1, spot: 120, backz: -7, rainbow: 0,
};
const FLAT = { rbase: 0.45, sweep: 0, key: 0.4 }; // icon and mark: matte ink behind the foil, no light strip smeared across it

const CAMS = {
  hero: { pos: [1.4, 0.7, 10.4], look: [0, -0.45, 0] },
  one: { pos: [1.6, 0.5, 7.4], look: [0, -0.3, 0] },
  icon: { pos: [0, 0, 7.46], look: [0, 0, 0] },
  mark: { pos: [0, 0, 7.2], look: [0, 0, 0] },
};

const SPINE = [[455,235,58],[488,280,46],[505,340,58],[503,410,78],[484,490,92],[452,570,86],[415,645,66],[392,715,46],[392,780,34],[418,838,26],[468,866,20],[520,852,16],[548,808,13],[530,770,10],[498,770,8],[490,800,6]];

const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function path(ctx, pts, close) { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (close) ctx.closePath(); }
function poly(ctx, pts) { path(ctx, pts, true); ctx.fill(); }
function stroke(ctx, pts, w) { ctx.lineWidth = w; path(ctx, pts, false); ctx.stroke(); }
function dot(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }

// Seahorse in a 1000-unit space centred on (473, 512): white is foil, black cuts are eye, plates, crack.
function seahorse(ctx, cx, cy, s, o) {
  ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-473, -512);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const curve = new THREE.CatmullRomCurve3(SPINE.map(([x, y, r]) => new THREE.Vector3(x, y, r)), false, 'centripetal');
  for (const q of curve.getPoints(700)) dot(ctx, q.x, q.y, q.z);
  ctx.save(); ctx.translate(445, 225); ctx.rotate(-0.7); ctx.beginPath(); ctx.ellipse(0, 0, 84, 62, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  for (let t = 0; t <= 1; t += 0.02) dot(ctx, 392 - 107 * t, 262 + 56 * t, 27 - 10 * t);
  poly(ctx, [[470,190],[482,148],[498,178],[514,138],[530,176],[548,150],[556,196]]);
  poly(ctx, [[560,385],[642,412],[624,448],[658,486],[632,518],[652,548],[565,560]]);
  ctx.fillStyle = '#000'; dot(ctx, 448, 214, 12);
  if (+o.plates) for (const t of [0.22, 0.3, 0.38, 0.46, 0.54, 0.62, 0.7]) {
    const q = curve.getPointAt(t), d = curve.getTangentAt(t), m = Math.hypot(d.x, d.y), n = [-d.y / m, d.x / m], l = q.z * 0.62;
    stroke(ctx, [[q.x + n[0] * l, q.y + n[1] * l], [q.x - n[0] * l, q.y - n[1] * l]], 2.5);
  }
  if (o.crack) { stroke(ctx, [[555,365],[510,455],[545,505],[462,600],[440,675],[392,745]], 20); stroke(ctx, [[545,505],[598,535]], 14); }
  ctx.restore();
}

function cardMask(kind, p) {
  const c = canvas(CW, CH), ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, CW, CH);
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
  if (+p.frame) { ctx.lineWidth = 10; ctx.beginPath(); ctx.roundRect(56, 56, CW - 112, CH - 112, 60); ctx.stroke(); }
  const ex = CW / 2, ey = 1040;
  if (+p.ring) { ctx.lineWidth = 14; ctx.beginPath(); ctx.arc(ex, ey, 470, 0, Math.PI * 2); ctx.stroke(); }
  seahorse(ctx, ex, ey, 1.12, { plates: p.plates, crack: kind === 'wrong' });
  if (+p.text) {
    ctx.fillStyle = '#fff';
    ctx.font = '700 120px "Martian Mono"'; ctx.fillText('hippo', 108, 232);
    ctx.font = '700 58px "Martian Mono"';
    ctx.fillText(kind === 'wrong' ? 'MARKED WRONG' : 'RECALLED x3', 112, 1905);
    ctx.textAlign = 'right'; ctx.fillText(kind === 'wrong' ? 't½ 3d' : 't½ 30d', CW - 112, 232);
    ctx.fillText(kind === 'wrong' ? 'DEMOTED' : 'STRONG', CW - 112, 1905); ctx.textAlign = 'left';
  }
  return c;
}

function emblemMask(p) {
  const c = canvas(2048, 2048), ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 2048, 2048);
  ctx.strokeStyle = '#fff';
  if (+p.ering) { ctx.lineWidth = 22; ctx.beginPath(); ctx.arc(1024, 1024, 860, 0, Math.PI * 2); ctx.stroke(); }
  seahorse(ctx, 1024, 1024, +p.escale, { plates: p.plates, crack: p.kind === 'wrong' });
  return c;
}

// Colour, roughness and thin-film thickness maps from the mask; thickness carries fine diagonal stripes so the foil bands.
function buildMaps(mask, tint, p, dull = 0) {
  const W = mask.width, H = mask.height, src = mask.getContext('2d').getImageData(0, 0, W, H).data;
  const T = hex(tint).map((v) => Math.round(v + (232 - v) * +p.tintmix)), I = hex(INK);
  const out = ['color', 'rough', 'thick'].map(() => { const c = canvas(W, H); const ctx = c.getContext('2d'); return { c, ctx, img: ctx.createImageData(W, H) }; });
  const [cI, rI, tI] = out.map((o) => o.img.data);
  const ang = +p.angle * Math.PI / 180, ca = Math.cos(ang), sa = Math.sin(ang), per = +p.period, band = +p.band, rb = +p.rainbow;
  const hue = (h) => [Math.abs(6 * h - 3) - 1, 2 - Math.abs(6 * h - 2), 2 - Math.abs(6 * h - 4)].map((v) => 255 * Math.min(1, Math.max(0, v)));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, m = src[i] > 127, s = x * ca + y * sa;
    const stripe = 0.5 + 0.5 * Math.sin(s * Math.PI * 2 / per);
    const drift = 0.5 + 0.5 * Math.sin(x * 0.0021 + y * 0.0016);
    const rbw = m && rb ? hue(((s / 900 + drift * 0.3) % 1 + 1) % 1) : null;
    const col = m ? (rbw ? T.map((v, k) => v + ((rbw[k] + (255 - rbw[k]) * 0.35) - v) * rb) : T) : I;
    cI[i] = col[0]; cI[i + 1] = col[1]; cI[i + 2] = col[2]; cI[i + 3] = 255;
    rI[i] = rI[i + 1] = rI[i + 2] = (m ? +p.rough + stripe * 0.06 + dull : +p.rbase) * 255; rI[i + 3] = 255;
    tI[i] = tI[i + 1] = tI[i + 2] = (drift * (1 - band) + stripe * band) * 255; tI[i + 3] = 255;
  }
  out.forEach((o) => o.ctx.putImageData(o.img, 0, 0));
  return { mask, color: out[0].c, rough: out[1].c, thick: out[2].c, normal: normalFromMask(mask, +p.blur, +p.wave) };
}

// Emboss: tangent-space normals from the gradient of the blurred mask (v axis flips because canvases are y-down),
// plus a slow wobble so the flat foil shifts hue across its face like a real pressed sticker.
function normalFromMask(mask, blur, wave) {
  const W = mask.width, H = mask.height, c = canvas(W, H), ctx = c.getContext('2d');
  ctx.filter = `blur(${blur}px)`; ctx.drawImage(mask, 0, 0); ctx.filter = 'none';
  const s = ctx.getImageData(0, 0, W, H).data, img = ctx.createImageData(W, H), d = img.data;
  const at = (x, y) => s[(Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))) * 4] / 255;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const w = wave * at(x, y), wx = w * Math.sin(y * 0.011 + x * 0.004) * Math.cos(x * 0.006), wy = w * Math.cos(x * 0.009 - y * 0.003);
    const dx = (at(x + 1, y) - at(x - 1, y)) * 12 + wx, dy = (at(x, y + 1) - at(x, y - 1)) * 12 + wy, l = Math.hypot(dx, dy, 1), i = (y * W + x) * 4;
    d[i] = (0.5 - dx / l * 0.5) * 255; d[i + 1] = (0.5 + dy / l * 0.5) * 255; d[i + 2] = 255 / l; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function foilMaterial(m, p, span, extra = {}) {
  const t = (c, srgb) => {
    const x = new THREE.CanvasTexture(c); x.anisotropy = 16;
    if (srgb) x.colorSpace = THREE.SRGBColorSpace;
    if (span) { x.repeat.set(1 / span[0], 1 / span[1]); x.offset.set(0.5, 0.5); }
    return x;
  };
  const mask = t(m.mask);
  return new THREE.MeshPhysicalMaterial({
    map: t(m.color, true), metalness: 1, metalnessMap: mask, roughness: 1, roughnessMap: t(m.rough),
    iridescence: +p.irid, iridescenceMap: mask, iridescenceIOR: +p.iior, iridescenceThicknessRange: [+p.tmin, +p.tmax], iridescenceThicknessMap: t(m.thick),
    clearcoat: +p.cc, clearcoatRoughness: +p.ccr, normalMap: t(m.normal), normalScale: new THREE.Vector2(+p.emboss, +p.emboss),
    envMapIntensity: +p.envi, ...extra,
  });
}

function roundedRect(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

// Card pivots at its bottom edge so `lean` tips it back while it still stands on the floor.
function card(kind, tint, p) {
  const w = +p.cardw, h = w * CH / CW, bev = +p.bev, sw = w - 2 * bev, sh = h - 2 * bev, depth = +p.thick - 2 * bev;
  const geo = new THREE.ExtrudeGeometry(roundedRect(sw, sh, +p.corner), { depth, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 4, curveSegments: 24 });
  geo.translate(0, h / 2, -depth / 2);
  const dull = kind === 'wrong' ? +p.dull : 0;
  const face = foilMaterial(buildMaps(cardMask(kind, p), tint, p, dull), p, [sw, sh], dull ? { iridescence: +p.irid * 0.4 } : {});
  const side = new THREE.MeshPhysicalMaterial({ color: INK, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1 });
  const mesh = new THREE.Mesh(geo, [face, side]);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.rotation.x = -+p.lean;
  const g = new THREE.Group(); g.add(mesh); g.position.y = -h / 2;
  return g;
}

function emblemPlane(p, alpha) {
  const maps = buildMaps(emblemMask(p), p.kind === 'wrong' ? AMBER : MINT, p);
  // Cut the plane to the foil so the icon corners are the ink clear colour, not a lit dielectric grey.
  const extra = { alphaMap: new THREE.CanvasTexture(maps.mask), transparent: true, alphaTest: 0.5 };
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 4.4), foilMaterial(maps, p, null, extra));
  mesh.rotation.y = alpha ? 0 : +p.ptilt;
  return mesh;
}

function studioEnv(renderer, kind) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  if (kind === 'room') { const t = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose(); return t; }
  const s = new THREE.Scene();
  s.background = new THREE.Color('#050705');
  const panel = (w, h, color, k, pos, rot = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(0, 0, 0); m.rotateZ(rot); s.add(m);
  };
  panel(12, 1.2, '#ffffff', 8, [2, 7, 5], 0.5);
  panel(12, 0.5, '#ffffff', 5, [-2, 3, 9], -0.3);
  panel(2, 9, '#ffffff', 3, [-8, 2, 2]);
  panel(1.2, 9, MINT, 2.5, [7, 1, -3]);
  panel(9, 6, '#ffffff', 2, [-1, 3, 10]);
  panel(30, 30, '#ffffff', 0.12, [0, -10, 0]);
  const tex = pmrem.fromScene(s, 0.04).texture;
  pmrem.dispose();
  return tex;
}

export async function createScene(renderer, size, q = {}) {
  const p = { ...DEFAULTS, ...(q.mode === 'icon' || q.mode === 'mark' ? FLAT : {}), ...q };
  const alpha = p.bg === 'none';
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = +p.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(alpha ? 0x000000 : p.field, alpha ? 0 : 1);
  RectAreaLightUniformsLib.init();

  const scene = new THREE.Scene();
  scene.environment = studioEnv(renderer, p.env);
  const h = +p.cardw * CH / CW;

  if (p.mode === 'hero') {
    const wrong = card('wrong', AMBER, p), good = card('good', MINT, p);
    wrong.position.x = -+p.gap; wrong.position.z = -+p.depthgap / 2; wrong.rotation.y = +p.tilt;
    good.position.x = +p.gap; good.position.z = +p.depthgap / 2; good.rotation.y = -+p.tilt * 0.7;
    scene.add(wrong, good);
  } else if (p.mode === 'one') {
    const c = card(p.kind, p.kind === 'wrong' ? AMBER : MINT, p);
    c.rotation.y = -+p.tilt; scene.add(c);
  } else {
    scene.add(emblemPlane(p, alpha));
  }

  if (!alpha && (p.mode === 'hero' || p.mode === 'one')) {
    if (+p.mirror) {
      const mirror = new Reflector(new THREE.PlaneGeometry(40, 40), { clipBias: 0.003, textureWidth: size, textureHeight: size, color: p.mtint });
      mirror.rotation.x = -Math.PI / 2; mirror.position.y = -h / 2 - 0.002; scene.add(mirror);
    } else {
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshPhysicalMaterial({ color: p.field, roughness: 0.6, clearcoat: 0.6 }));
      floor.rotation.x = -Math.PI / 2; floor.position.y = -h / 2 - 0.002; floor.receiveShadow = true; scene.add(floor);
    }
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: +p.shadow, transparent: true }));
    sh.rotation.x = -Math.PI / 2; sh.position.y = -h / 2 + 0.001; sh.receiveShadow = true; scene.add(sh);
    if (+p.back) {
      const back = new THREE.Mesh(new THREE.PlaneGeometry(80, 40), new THREE.MeshStandardMaterial({ color: p.field, roughness: 1 }));
      back.position.set(0, 10, +p.backz); scene.add(back);
      const spot = new THREE.SpotLight('#ffffff', +p.spot, 0, 0.5, 1, 1);
      spot.position.set(0, 6, 4); spot.target.position.set(0, -1, +p.backz); scene.add(spot, spot.target);
    }
  }

  const sweep = new THREE.RectAreaLight('#ffffff', +p.sweep, 9, 0.7);
  sweep.position.set(+p.ax, +p.ay, +p.az); sweep.lookAt(0, 0, 0); sweep.rotateZ(+p.arot); scene.add(sweep);
  const sun = new THREE.DirectionalLight('#ffffff', 2.2 * +p.key);
  sun.position.set(+p.sunx, +p.suny, +p.sunz); sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096); sun.shadow.radius = 2; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.01;
  Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 30 });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#ffffff', INK, 0.3 * +p.key));

  const camera = new THREE.PerspectiveCamera(+p.fov, 1, 0.1, 100);
  const c = CAMS[p.mode] || CAMS.hero;
  camera.position.set(...c.pos); camera.lookAt(...c.look);
  if (q.cx !== undefined) { camera.position.set(+q.cx, +q.cy, +q.cz); camera.lookAt(+(q.lx || 0), +(q.ly || 0), +(q.lz || 0)); }

  // Icon skips the composer: the clear colour through the float target lands lighter than ink.
  if (alpha || p.mode === 'icon') return { scene, camera, render: () => renderer.render(scene, camera) };

  const target = new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  if (+p.bloom) composer.addPass(new UnrealBloomPass(new THREE.Vector2(size, size), +p.bloom, 0.4, 0.9));
  composer.addPass(new OutputPass());
  return { scene, camera, render: () => composer.render() };
}
