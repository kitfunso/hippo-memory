// The home page's two WebGL scenes. The page imports this after first paint, so three.js never blocks the first screen.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const root = document.documentElement;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const bump = (s, a, b, r) => smooth(a - r, a, s) * (1 - smooth(b, b + r, s));
function track(s, keys, out, dwell = 0) {
  if (s <= keys[0][0]) return out.set(keys[0][1], keys[0][2], keys[0][3]);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (s <= b[0]) { const w = (b[0] - a[0]) * dwell, t = smooth(a[0] + w, b[0] - w, s); return out.set(lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)); }
  }
  const l = keys[keys.length - 1];
  return out.set(l[1], l[2], l[3]);
}

// Set as scene.background: through the composer a clear colour gets sRGB-encoded twice and black turns grey.
const BG = 0x0c0f11;
const VERT = `varying vec2 vUv; varying float vDepth; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`;
const FRAG = `
uniform float uTime; uniform float uLift; uniform float uSeed; uniform float uDim; uniform float uGrey; uniform float uNear; uniform float uFar;
uniform vec3 uHot; uniform vec3 uCool;
varying vec2 vUv; varying float vDepth;
float sdRR(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
void main(){
  vec2 S = vec2(4.2, 2.6);
  vec2 p = (vUv - 0.5) * S;
  float d = sdRR(p, S * 0.5, 0.18);
  if (d > 0.0) discard;
  float soft = smoothstep(0.0, -0.10, d);
  float rim = exp(d * 22.0) * soft;
  float core = clamp(1.0 - length((vUv - vec2(0.22 + 0.12 * uSeed, 0.62)) * vec2(0.85, 1.25)), 0.0, 1.0);
  float rows = vUv.y * 11.0;
  float rule = 1.0 - smoothstep(0.0, 0.09, abs(fract(rows) - 0.5));
  rule *= step(0.08, vUv.y) * step(vUv.y, 0.72) * step(0.07, vUv.x) * step(vUv.x, 0.93);
  float head = 1.0 - smoothstep(0.0, 0.016, abs(vUv.y - 0.79));
  head *= step(0.07, vUv.x) * step(vUv.x, 0.93);
  vec3 fringe = mix(uHot, uCool, smoothstep(0.78, 1.0, vUv.x) * 0.7);
  vec3 body = uHot * (0.06 + 0.55 * pow(core, 1.6)) * soft;
  vec3 col = body + fringe * rim * 0.38 + uCool * rule * 0.07 * soft + vec3(0.4, 0.95, 0.9) * head * 0.2;
  col *= 0.55 + 1.1 * uLift;
  float l = dot(col, vec3(0.3, 0.5, 0.2));
  col = mix(col, vec3(l) * 0.55, uGrey);
  col *= uDim * (1.0 - 0.85 * smoothstep(uNear, uFar, vDepth));
  col += (hash(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.05 * soft * uDim;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

const AMBER = new THREE.Color('#7af5e0'), RED = new THREE.Color('#2cb4d9'), PLUM = new THREE.Color('#4a6dea'), COOL = new THREE.Color('#b8fff2');
// Amber is far brighter than red, so additive layers wash out unless each card is scaled by its brightness.
const deckHot = (t) => (t < 0.5 ? AMBER.clone().lerp(RED, t * 2) : RED.clone().lerp(PLUM, (t - 0.5) * 2)).multiplyScalar(0.64 + 0.36 * t);
const CARD = new THREE.PlaneGeometry(4.2, 2.6);
const TIME = { value: 0 };
function glass(hot, o = {}) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: TIME, uLift: { value: o.lift || 0 }, uSeed: { value: o.seed == null ? Math.random() : o.seed }, uHot: { value: hot.clone() }, uCool: { value: COOL }, uDim: { value: o.dim == null ? 1 : o.dim }, uGrey: { value: 0 }, uNear: { value: o.near || 40 }, uFar: { value: o.far || 110 } },
  });
  return new THREE.Mesh(CARD, mat);
}
// A high threshold keeps the glow on lifted cards, so dozens of dim ones don't add up to a grey wash.
function makeComposer(renderer, scene, camera, b = [0.5, 0.1, 0.22]) {
  const c = new EffectComposer(renderer);
  c.addPass(new RenderPass(scene, camera));
  c.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), b[0], b[1], b[2]);
  c.addPass(c.bloom);
  c.addPass(new OutputPass());
  return c;
}
const ORDER = [4, 2, 6, 1, 7, 3, 5, 0, 8];

// First screen: the deck from 6, recoloured along the colour bar.
export function hero() {
  const canvas = document.getElementById('gl'), host = canvas.parentElement;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }); }
  catch (err) { root.classList.add('no-gl'); console.warn('hippo: WebGL failed on the first screen, showing the CSS cards', err); return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(BG, 1);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  scene.background = new THREE.Color(BG);
  camera.position.set(0, 0, 13);
  const N = 9, cards = [], deck = new THREE.Group(), tilt = new THREE.Group();
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1), m = glass(deckHot(t), { seed: (i * 0.37) % 1 });
    m.userData.base = new THREE.Vector3(0, Math.sin(t * Math.PI) * 0.12, (i - (N - 1) / 2) * 0.62);
    m.userData.rx = (t - 0.5) * 0.16;
    m.position.copy(m.userData.base); m.rotation.x = m.userData.rx;
    deck.add(m); cards.push(m);
  }
  deck.rotation.set(0.18, -1.02, 0);
  tilt.add(deck); tilt.rotation.z = 0.66; scene.add(tilt);
  const composer = makeComposer(renderer, scene, camera);
  function size() {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h, false); composer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); composer.setSize(w, h);
    camera.aspect = w / h;
    const tall = w / h < 0.8;
    camera.position.z = tall ? 15.5 : 13; tilt.position.y = tall ? 0.9 : 0;
    camera.updateProjectionMatrix();
  }
  size(); addEventListener('resize', size);
  let mx = 0, my = 0;
  addEventListener('pointermove', (e) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; }, { passive: true });
  function frame(t) {
    const s = t / 1000, period = 3.4, k = ORDER[Math.floor(s / period) % ORDER.length], ph = (s % period) / period;
    const env = ph < 0.72 ? Math.pow(Math.sin(Math.PI * ph / 0.72), 2) : 0;
    TIME.value = s;
    cards.forEach((m, i) => {
      const u = m.material.uniforms, lift = reduce ? (i === 4 ? 1 : 0) : (i === k ? env : 0);
      u.uLift.value += (lift - u.uLift.value) * (reduce ? 1 : 0.2);
      m.position.y = m.userData.base.y + u.uLift.value * 1.25;
      m.rotation.x = m.userData.rx + Math.sin(s * 0.5 + i * 0.6) * (reduce ? 0 : 0.015);
    });
    tilt.rotation.y = reduce ? 0 : Math.sin(s * 0.18) * 0.06 + mx * 0.12;
    tilt.rotation.x = reduce ? 0 : my * 0.08;
    composer.render();
  }
  if (reduce) { frame(0); root.classList.add('hero-live'); return; }
  let running = false, raf = 0;
  const loop = (t) => { frame(t); raf = requestAnimationFrame(loop); };
  const set = (on) => { if (on === running) return; running = on; if (on) raf = requestAnimationFrame(loop); else cancelAnimationFrame(raf); };
  new IntersectionObserver((es) => set(es[0].isIntersecting && !document.hidden), { threshold: 0 }).observe(canvas);
  document.addEventListener('visibilitychange', () => { if (document.hidden) set(false); else set(canvas.getBoundingClientRect().bottom > 0); });
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); set(false); root.classList.remove('hero-live'); root.classList.add('no-gl'); });
  frame(0);
  root.classList.add('hero-live');
}

// The film: the same deck comes back, one card leaves it, and the camera follows that memory.
export function film() {
  const story = document.getElementById('story'), pin = story.querySelector('.pin'), win = pin.querySelector('.win');
  const hud = win.querySelector('.hud'), box = hud.querySelector('.box'), tag = box.querySelector('.tag'), num = hud.querySelector('.stagenum');
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  win.prepend(canvas);
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }); }
  catch (err) { canvas.remove(); root.classList.replace('gl', 'static'); console.warn('hippo: WebGL failed in the film, keeping the static stages', err); return; }
  renderer.setClearColor(BG, 1);

  const narrow = innerWidth < 760;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  // Card text goes through the bloom too (platform's glowing type), so the threshold sits above the dim glass.
  const GLOW = [0.62, 0.28, 0.5];
  const composer = makeComposer(renderer, scene, camera, GLOW);
  const SEC = story.dataset.sec || '1';
  let seed = 7;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rr = (a, b) => a + (b - a) * rnd();
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const qY = (a) => new THREE.Quaternion().setFromEuler(new THREE.Euler(0, a, 0));

  // Where things sit.
  const A1 = V(1.2, 0.1, 1.5), R = V(0, 0.2, -2), SP = V(6.5, 0.5, -1.6), TP = V(9.6, 0.7, -5.5), QP = V(-3.4, 4.7, -8);
  const WP = V(4.6, -2.6, -4.6), OP = V(-6.4, -2.4, -5.2), NOFF = V(2.4, -1.0, 1.1);
  const SROT = -0.3, TROT = -0.34;
  // A phone is too narrow for props side by side, so they stack above the followed card.
  if (narrow) { SP.set(1.2, 4.0, 0.2); QP.set(0.4, 5.6, -6); }

  // Deck poses, the same transforms the first screen uses.
  const tiltO = new THREE.Object3D(), deckO = new THREE.Object3D();
  tiltO.rotation.z = 0.66; deckO.rotation.set(0.18, -1.02, 0); tiltO.add(deckO);
  if (narrow) tiltO.position.y = 0.9;
  const deckPose = [];
  for (let i = 0; i < 9; i++) {
    const t = i / 8, o = new THREE.Object3D();
    o.position.set(0, Math.sin(t * Math.PI) * 0.12 + (i === 4 ? 1.25 : 0), (i - 4) * 0.62); o.rotation.x = (t - 0.5) * 0.16;
    deckO.add(o);
  }
  tiltO.updateMatrixWorld(true);
  deckO.children.forEach((o) => { const p = V(0, 0, 0), q = new THREE.Quaternion(), s = V(1, 1, 1); o.matrixWorld.decompose(p, q, s); deckPose.push({ p, q }); });

  // Field of memories: the 8 other deck cards plus more, spread through the room.
  const zones = [[-3.5, 3.5, -2.2, 2.4, -4.5, 4], [2.2, 9.8, -2.5, 3.4, -3.5, 1], [6.2, 13.4, -2.6, 3.8, -8, -3], [-7.5, 1.2, 3.2, 6.4, -10.5, -6], [2.2, 9.8, -5.2, 0, -7, -2.5], [-10, -2.8, -5, 0.2, -8, -3], [-12, 12, -8, 8, 3, 30]];
  const blocked = (p) => zones.some((z) => p.x > z[0] && p.x < z[1] && p.y > z[2] && p.y < z[3] && p.z > z[4] && p.z < z[5]);
  const pal = [AMBER, RED, PLUM];
  const field = [];
  const total = narrow ? 26 : 40;
  for (let guard = 0; field.length < total && guard < 8000; guard++) {
    const p = V(rr(-26, 26), rr(-12, 12), rr(-48, 2));
    if (blocked(p)) continue;
    field.push({ p, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(rr(-0.45, 0.45), rr(-0.7, 0.7), rr(-0.25, 0.25))), sp: rr(0.25, 0.7), ph: rr(0, 6.28), fade: rnd() < 0.55, lift: rr(0, 0.22), deck: -1 });
  }
  const items = [];
  let fi = 0;
  for (let i = 0; i < 9; i++) { if (i === 4) continue; const f = field[fi++]; f.deck = i; f.hot = deckHot(i / 8); items.push(f); }
  for (; fi < field.length; fi++) { const f = field[fi]; f.hot = pal[Math.floor(rnd() * 3)]; items.push(f); }
  items.forEach((it) => { it.mesh = glass(it.hot, { seed: rnd(), dim: 0 }); scene.add(it.mesh); it.now = V(0, 0, 0); it.recall = false; });
  items.slice().sort((a, b) => a.p.distanceTo(QP) - b.p.distanceTo(QP)).slice(0, 4).forEach((it) => { it.recall = true; });

  // Text faces, drawn on canvases and shown in a second pass so the bloom leaves the type sharp.
  const MONO = '"Spline Sans Mono", ui-monospace, Consolas, monospace', SANS = '"Instrument Sans", system-ui, sans-serif', DISP = '"Schibsted Grotesk", system-ui, sans-serif';
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const redraws = [];
  function rrect(x, X, Y, w, h, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath(); }
  function wrap(x, s, X, Y, w, lh, max) {
    let line = '', n = 0;
    for (const word of s.split(' ')) { const t = line ? line + ' ' + word : word; if (x.measureText(t).width > w && line) { x.fillText(line, X, Y + n * lh); n++; line = word; if (n >= max) return; } else line = t; }
    if (line) x.fillText(line, X, Y + n * lh);
  }
  function faceTex(w, h, draw) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d'), tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAniso;
    const api = { tex, state: null, draw: (st) => { api.state = st; ctx.clearRect(0, 0, w, h); ctx.textBaseline = 'top'; draw(ctx, st); tex.needsUpdate = true; } };
    redraws.push(() => api.draw(api.state));
    return api;
  }
  const FACE = new THREE.PlaneGeometry(4.04, 2.5);
  function faceMesh(api) { const m = new THREE.Mesh(FACE, new THREE.MeshBasicMaterial({ map: api.tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false })); m.renderOrder = 2; scene.add(m); return m; }
  function panelBase(x, w, h, title) {
    rrect(x, 6, 6, w - 12, h - 12, 34); x.fillStyle = 'rgba(10,12,13,.9)'; x.fill(); x.lineWidth = 3; x.strokeStyle = 'rgba(214,255,250,.2)'; x.stroke();
    ['#5eead4', '#22a6c9', '#2f4bb3'].forEach((c, i) => { x.fillStyle = c; x.beginPath(); x.arc(52 + i * 30, 50, 9, 0, 6.29); x.fill(); });
    x.fillStyle = '#96aec2'; x.font = `500 27px ${MONO}`; x.fillText(title, 160, 37);
  }
  function drawCard(x, d) {
    const W = 1024, H = 634;
    rrect(x, 6, 6, W - 12, H - 12, 44); x.fillStyle = 'rgba(10,12,13,.88)'; x.fill(); x.lineWidth = 3; x.strokeStyle = 'rgba(214,255,250,.22)'; x.stroke();
    ['#5eead4', '#22a6c9', '#2f4bb3'].forEach((c, i) => { x.fillStyle = c; x.fillRect(56, 56 + i * 9, 92, 6); });
    x.fillStyle = 'rgba(235,238,241,.72)'; x.font = `500 29px ${MONO}`; x.fillText(d.id, 172, 52);
    x.font = `600 26px ${MONO}`;
    const cw = x.measureText(d.chip).width + 40;
    rrect(x, W - 56 - cw, 42, cw, 52, 26); x.fillStyle = d.chipBg || 'rgba(94,234,212,.16)'; x.fill(); x.lineWidth = 2.5; x.strokeStyle = d.chipC || '#5eead4'; x.stroke();
    x.fillStyle = d.chipC || '#5eead4'; x.fillText(d.chip, W - 56 - cw + 20, 55);
    x.fillStyle = d.dim ? '#7295b1' : '#ebeef1'; x.font = `500 54px ${SANS}`; wrap(x, d.text, 56, 150, 912, 66, 4);
    x.fillStyle = '#96aec2'; x.font = `400 27px ${MONO}`; x.fillText(d.foot, 56, 548);
  }

  // The followed memory: deck card 4, the one the first screen lifts.
  const A = { mesh: glass(deckHot(0.5), { seed: (4 * 0.37) % 1 }), api: faceTex(1024, 634, drawCard) };
  scene.add(A.mesh); A.face = faceMesh(A.api);
  const A_TEXT = 'always run the migration before the deploy, the release script does not run it for you';
  const aFace = (s) => (s < 1.15 ? { chip: 'captured', foot: 'your turn, at session end' }
    : s < 2.5 ? { chip: 'rule · pinned', foot: 'rule word: always' }
    : s < 3.5 ? { chip: 'rule · pinned', foot: 'in .hippo/ for every agent' }
    : s < 4.5 ? { chip: 'rule · pinned', foot: 'matched: deploy' }
    : { chip: 'rule · pinned', foot: 'pinned, never fades' });
  let aKey = '';
  const setA = (s) => { const f = aFace(s), k = f.chip + f.foot; if (k === aKey) return; aKey = k; A.api.draw({ id: 'mem_22f16003d809', chip: f.chip, text: A_TEXT, foot: f.foot }); };

  // Pin, dropped onto the card once the rule word matches.
  const pinG = new THREE.Group();
  const pinHead = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 14), new THREE.MeshBasicMaterial({ color: '#71f6e4' }));
  pinHead.position.z = 0.42;
  const needle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.36, 8), new THREE.MeshBasicMaterial({ color: '#a5b9ca' }));
  needle.rotation.x = Math.PI / 2; needle.position.z = 0.22;
  pinG.add(pinHead, needle); pinG.position.set(-1.62, 0.92, 0); A.mesh.add(pinG);

  // A memory that misleads, and an old fact with its replacement.
  const W = { mesh: glass(RED, { seed: 0.3, dim: 0 }), api: faceTex(1024, 634, drawCard) }; scene.add(W.mesh); W.face = faceMesh(W.api);
  const O = { mesh: glass(PLUM, { seed: 0.6, dim: 0 }), api: faceTex(1024, 634, drawCard) }; scene.add(O.mesh); O.face = faceMesh(O.api);
  const Nn = { mesh: glass(AMBER, { seed: 0.1, dim: 0 }), api: faceTex(1024, 634, drawCard) }; scene.add(Nn.mesh); Nn.face = faceMesh(Nn.api);
  let wKey = '', oKey = '';
  const setW = (bad) => { if (wKey === String(bad)) return; wKey = String(bad); W.api.draw({ id: 'mem_3b9d0e6c1f27', chip: bad ? 'outcome --bad' : 'lesson', chipC: bad ? '#7cf0ff' : '#5eead4', chipBg: bad ? 'rgba(34,166,201,.18)' : null, text: 'staging can read the production env file', foot: bad ? 'weaker after the last recall' : 'recalled: env, staging', dim: bad }); };
  const setO = (old) => { if (oKey === String(old)) return; oKey = String(old); O.api.draw({ id: 'mem_5f2b1c8e93a0', chip: old ? 'superseded' : 'decision', chipC: old ? '#96aec2' : '#5eead4', chipBg: old ? 'rgba(150,174,194,.12)' : null, text: 'new endpoints go under /v1', foot: old ? 'out of recall, still on record' : 'decision from review', dim: old }); };
  Nn.api.draw({ id: 'mem_9c4e1a7d20b3', chip: 'current', text: 'API v1 is deprecated, new endpoints go under /v2', foot: 'supersedes mem_5f2b1c8e93a0' });
  setW(false); setO(false);

  // Panels: the session where you said it, the next session, three agents, and the next prompt.
  function panel(w, h, draw) {
    const api = faceTex(1024, Math.round(1024 * h / w), draw);
    const g = glass(AMBER, { lift: 0.05, dim: 0 }); g.scale.set(w / 4.2, h / 2.6, 1); scene.add(g);
    const f = faceMesh(api); api.draw({});
    return { g, f, w, h, api };
  }
  const SESS = panel(5.8, 3.7, (x) => {
    const w = 1024, h = 653; panelBase(x, w, h, 'session · payments-api');
    const L = [['you', 'add the orders table and ship it'], ['agent', 'deploying first, then I will migrate'], ['you', 'always run the migration before the deploy'], ['agent', 'got it, migrating first']];
    L.forEach(([who, t], i) => {
      const y = 128 + i * 98;
      if (i === 2) { rrect(x, 40, y - 18, w - 80, 78, 14); x.fillStyle = 'rgba(94,234,212,.16)'; x.fill(); }
      x.fillStyle = who === 'you' ? '#5eead4' : '#96aec2'; x.font = `600 27px ${MONO}`; x.fillText(who, 64, y + 4);
      x.font = `500 33px ${SANS}`; x.fillStyle = '#ebeef1';
      if (i === 2) { const pre = ''; x.fillStyle = '#b8fff2'; x.fillText('always', 190, y); const ww = x.measureText('always ').width; x.fillStyle = '#ebeef1'; x.fillText(pre + 'run the migration before the deploy', 190 + ww, y); }
      else x.fillText(t, 190, y);
    });
    x.fillStyle = '#96aec2'; x.font = `500 26px ${MONO}`; x.fillText('session end · rule word found: always', 64, h - 82);
  });
  const TERM = panel(5.8, 3.7, (x) => {
    const w = 1024, h = 653; panelBase(x, w, h, 'new session · before your first prompt');
    x.fillStyle = '#5eead4'; x.font = `600 38px ${MONO}`; x.fillText('## Rules from the user', 56, 120);
    x.fillStyle = '#c8d2db'; x.font = `500 27px ${MONO}`;
    x.fillText('- never log access tokens', 56, 186);
    x.fillText('- staging and production use different env files', 56, 228);
    x.fillText('-', 56, 300);
    x.fillStyle = '#ebeef1'; x.fillText('>', 56, h - 96); x.fillRect(88, h - 96, 16, 30);
  });
  const AG = ['Claude Code', 'Codex', 'Cursor'].map((name) => panel(3.9, 1.35, (x) => {
    const w = 1024, h = 354;
    rrect(x, 6, 6, w - 12, h - 12, 30); x.fillStyle = 'rgba(10,12,13,.9)'; x.fill(); x.lineWidth = 3; x.strokeStyle = 'rgba(214,255,250,.2)'; x.stroke();
    x.fillStyle = '#ebeef1'; x.font = `800 84px ${DISP}`; x.fillText(name, 56, 70);
    x.fillStyle = '#5eead4'; x.font = `500 32px ${MONO}`; x.fillText('reads .hippo/ in this repo', 58, 214);
  }));
  const AGP = narrow ? [V(-0.7, 6.4, -4.5), V(0.8, 4.6, -4.5), V(-0.5, 2.8, -4.5)] : [V(-5.2, 3.9, -7.5), V(7.4, 3.6, -7.5), V(7.0, -3.2, -7)];
  const PROMPT = panel(7.2, 1.0, (x) => {
    const w = 1024, h = 142;
    rrect(x, 4, 4, w - 8, h - 8, 26); x.fillStyle = 'rgba(10,12,13,.92)'; x.fill(); x.lineWidth = 3; x.strokeStyle = 'rgba(94,234,212,.5)'; x.stroke();
    let X = 40;
    for (const wd of ['>', 'add', 'a', 'deploy', 'step', 'for', 'the', 'staging', 'orders', 'table']) {
      x.font = wd === '>' ? `600 40px ${MONO}` : `500 42px ${SANS}`;
      x.fillStyle = wd === 'deploy' || wd === 'staging' ? '#b8fff2' : '#ebeef1';
      x.fillText(wd, X, 48); X += x.measureText(wd + ' ').width;
    }
  });

  // Glowing threads between things.
  const lineMat = () => new THREE.LineBasicMaterial({ color: '#71f6e4', transparent: true, opacity: 0, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
  const seg = (n) => { const l = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3)), lineMat()); l.frustumCulled = false; scene.add(l); return l; };
  const capLine = seg(1), agLines = seg(3), recLines = seg(6);
  const supLine = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), new THREE.LineDashedMaterial({ color: '#b8fff2', dashSize: 0.16, gapSize: 0.12, transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
  supLine.frustumCulled = false; scene.add(supLine);

  const A_POS = [[0.4, deckPose[4].p.x, deckPose[4].p.y, deckPose[4].p.z], [1.0, A1.x, A1.y, A1.z], [1.4, A1.x, A1.y, A1.z], [1.95, 0, 0, 0], [2.4, 0, 0, 0], [2.95, R.x, R.y, R.z]];
  const dockLocal = V(0.65, -0.62, 0.12);
  const DOCK = dockLocal.clone().applyQuaternion(qY(TROT)).add(TP);
  A_POS[3] = [1.95, DOCK.x, DOCK.y, DOCK.z]; A_POS[4] = [2.4, DOCK.x, DOCK.y, DOCK.z];
  const A_SCL = [[1.35, 1, 0, 0], [1.95, 0.5, 0, 0], [2.4, 0.5, 0, 0], [2.95, 0.85, 0, 0]];
  const qFace = new THREE.Quaternion(), qDock = qY(TROT), qSess = qY(SROT);
  const CAM = [
    [0, 0, 0, 13, 0, 0, 0], [0.4, 0, 0, 13, 0, 0, 0],
    [1, 3.7, 0.7, 18.6, 3.7, 0.2, -0.4], [2, 9.2, 0.9, 6.2, 9.2, 0.6, -5.5],
    [3, 1.6, 0.8, 17, 1.6, 0.4, -5], [4, 1.2, 2.6, 16, 1.2, 1.2, -5.5],
    [5, 4.4, -1.8, 8.8, 4.6, -3.1, -4.6], [6, -4.6, -1.6, 10.4, -4.8, -2.9, -4.6],
    [7, 0, 3.5, 28, 0, -0.5, -10], [7.8, 0.6, 0.6, 12.5, 0.4, 0.2, -2],
  ];
  if (narrow) {
    CAM[0][3] = CAM[1][3] = 15.5;
    CAM[2] = [1, 1.2, 2.4, 18.6, 1.2, 1.9, 0.4]; CAM[3] = [2, 9.4, 0.9, 9.0, 9.4, 0.4, -5.5];
    CAM[4] = [3, 0.2, 3.0, 17, 0.2, 3.0, -3.5]; CAM[5] = [4, 0.6, 2.6, 16, 0.6, 2.4, -5.5];
  }
  const CAM_P = CAM.map((k) => [k[0], k[1], k[2], k[3]]), CAM_T = CAM.map((k) => [k[0], k[4], k[5], k[6]]);

  const v = V(0, 0, 0), tv = V(0, 0, 0), cp = V(0, 0, 0), ct = V(0, 0, 0), q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), eu = new THREE.Euler();
  let Wd = 0, Hd = 0, px = 0, py = 0, tx = 0, ty = 0;
  const local = (pnl, x, y) => V(x, y, 0).applyQuaternion(pnl.g.quaternion).add(pnl.g.position);
  const show = (o, k) => { o.mesh.material.uniforms.uDim.value = k; o.face.material.opacity = k; o.face.visible = k > 0.01; o.mesh.visible = k > 0.01; };
  const setPanel = (pnl, pos, quat, k) => {
    pnl.g.visible = pnl.f.visible = k > 0.01;
    if (!pnl.g.visible) return;
    pnl.g.position.copy(pos); pnl.g.position.y -= (1 - k) * 0.5; pnl.g.quaternion.copy(quat);
    pnl.g.scale.set(pnl.w / 4.2 * (0.85 + 0.15 * k), pnl.h / 2.6 * (0.85 + 0.15 * k), 1);
    pnl.g.material.uniforms.uDim.value = k;
    pnl.f.position.copy(pnl.g.position); pnl.f.quaternion.copy(quat); pnl.f.scale.copy(pnl.g.scale); pnl.f.material.opacity = k;
  };
  const sync = (o) => { o.face.position.copy(o.mesh.position); o.face.quaternion.copy(o.mesh.quaternion); o.face.scale.copy(o.mesh.scale); };

  function update(t, s) {
    TIME.value = t;
    const spread = smooth(0.42, 0.98, s), fadeK = smooth(6.25, 6.95, s), recK = bump(s, 3.55, 4.55, 0.3);
    items.forEach((it) => {
      const u = it.mesh.material.uniforms;
      v.copy(it.p); v.y += Math.sin(t * it.sp + it.ph) * 0.18 * spread;
      if (it.fade) v.y -= fadeK * 2.6;
      eu.set(Math.sin(t * 0.3 + it.ph) * 0.06, t * 0.03 * it.sp, 0); q2.setFromEuler(eu); q.copy(it.q).multiply(q2);
      if (it.deck >= 0) { it.mesh.position.lerpVectors(deckPose[it.deck].p, v, spread); it.mesh.quaternion.slerpQuaternions(deckPose[it.deck].q, q, spread); u.uDim.value = lerp(1, 0.5, spread); }
      else { it.mesh.position.copy(v); it.mesh.quaternion.copy(q); u.uDim.value = smooth(0.5, 1.0, s) * 0.5; }
      u.uDim.value *= 1 - fadeK * (it.fade ? 0.85 : 0.45);
      u.uLift.value = it.lift * spread + (it.recall ? recK * 0.9 : 0);
      it.now.copy(it.mesh.position);
    });

    // A
    const aPos = s < 0.4 ? v.copy(deckPose[4].p) : track(s, A_POS, v);
    A.mesh.position.copy(aPos); A.mesh.position.y += Math.sin(t * 0.8) * 0.04 * spread;
    const dk = smooth(1.4, 1.95, s) * (1 - smooth(2.4, 2.95, s));
    if (s < 1) q.slerpQuaternions(deckPose[4].q, qFace, smooth(0.42, 0.98, s)); else q.slerpQuaternions(qFace, qDock, dk);
    A.mesh.quaternion.copy(q);
    const aS = s < 1.35 ? 1 : track(s, A_SCL, tv).x;
    A.mesh.scale.setScalar(aS);
    A.mesh.material.uniforms.uLift.value = 1 - 0.35 * smooth(0.6, 1.0, s) + 0.25 * smooth(6.3, 7, s);
    const away = 1 - 0.85 * bump(s, 4.75, 6.35, 0.25);
    A.mesh.material.uniforms.uDim.value = away;
    setA(s); sync(A);
    const faceK = smooth(0.62, 0.95, s) * away; A.face.material.opacity = faceK; A.face.visible = faceK > 0.01;
    const pe = smooth(0.95, 1.25, s); pinG.visible = pe > 0.001; pinG.position.z = 3 * (1 - pe) * (1 - pe);
    pinHead.scale.setScalar(1 + 0.35 * smooth(6.4, 7, s) * (0.6 + 0.4 * Math.sin(t * 3)));

    // Panels
    setPanel(SESS, SP, qSess, bump(s, 0.62, 1.45, 0.3));
    setPanel(TERM, TP, qDock, bump(s, 1.35, 2.5, 0.3));
    const ak = bump(s, 2.6, 3.55, 0.3);
    AG.forEach((p, i) => setPanel(p, AGP[i], qY(i === 0 ? 0.32 : -0.32), ak));
    setPanel(PROMPT, QP, qY(0.2), bump(s, 3.45, 4.5, 0.3));

    // W: recalled at 1.4, marked bad and sinking at 1.5
    const wIn = smooth(3.35, 3.8, s), sink = smooth(4.6, 5.3, s);
    W.mesh.position.set(WP.x, WP.y - sink * 4.8 + Math.sin(t * 0.7 + 2) * 0.05, WP.z - sink * 1.5);
    W.mesh.quaternion.setFromEuler(eu.set(-0.6 * sink, -0.25 + 0.2 * sink, 0.25 * sink));
    W.mesh.material.uniforms.uGrey.value = smooth(4.55, 4.9, s);
    W.mesh.material.uniforms.uLift.value = recK * 0.9;
    show(W, wIn * (1 - 0.65 * sink) * (1 - 0.6 * fadeK)); setW(s > 4.6); sync(W);

    // O and N: the old fact steps back, the new one takes its place
    const oIn = smooth(4.4, 4.9, s), back = smooth(5.6, 6.2, s), nIn = smooth(5.5, 6.05, s);
    O.mesh.position.set(OP.x - back * 1.2, OP.y + back * 0.5, OP.z - back * 3.6);
    O.mesh.quaternion.setFromEuler(eu.set(0, 0.28 + back * 0.15, 0));
    O.mesh.material.uniforms.uGrey.value = back;
    show(O, oIn * (1 - 0.55 * back) * (1 - 0.9 * fadeK)); setO(s > 5.8); sync(O);
    Nn.mesh.position.set(OP.x + NOFF.x, OP.y + NOFF.y - (1 - nIn) * 3 + Math.sin(t * 0.8 + 1) * 0.04, OP.z + NOFF.z);
    Nn.mesh.quaternion.setFromEuler(eu.set(0, 0.26, 0));
    show(Nn, nIn * (1 - 0.8 * fadeK)); sync(Nn);

    // Threads
    const cpos = capLine.geometry.attributes.position, sa = local(SESS, -2.5, -0.12);
    cpos.setXYZ(0, sa.x, sa.y, sa.z); cpos.setXYZ(1, A.mesh.position.x + 2.0, A.mesh.position.y, A.mesh.position.z); cpos.needsUpdate = true;
    capLine.material.opacity = bump(s, 0.8, 1.3, 0.2) * 0.9;
    const apos = agLines.geometry.attributes.position;
    AGP.forEach((p, i) => { apos.setXYZ(i * 2, A.mesh.position.x, A.mesh.position.y, A.mesh.position.z); apos.setXYZ(i * 2 + 1, p.x, p.y, p.z); });
    apos.needsUpdate = true; agLines.material.opacity = bump(s, 2.75, 3.5, 0.25) * 0.85;
    const rpos = recLines.geometry.attributes.position, qb = local(PROMPT, 0, -0.5);
    const tg = [A.mesh.position, W.mesh.position, ...items.filter((it) => it.recall).map((it) => it.now)];
    for (let i = 0; i < 6; i++) { const p = tg[i] || A.mesh.position; rpos.setXYZ(i * 2, qb.x, qb.y, qb.z); rpos.setXYZ(i * 2 + 1, p.x, p.y, p.z); }
    rpos.needsUpdate = true; recLines.material.opacity = recK * 0.8;
    const spos = supLine.geometry.attributes.position;
    spos.setXYZ(0, Nn.mesh.position.x, Nn.mesh.position.y, Nn.mesh.position.z); spos.setXYZ(1, O.mesh.position.x, O.mesh.position.y, O.mesh.position.z); spos.needsUpdate = true;
    supLine.computeLineDistances(); supLine.material.opacity = bump(s, 5.9, 6.6, 0.3) * 0.9;

    // Camera
    track(s, CAM_P, cp, 0.12); track(s, CAM_T, ct, 0.12);
    const aspect = Wd / Hd, kz = aspect >= 1.2 ? 1 : aspect >= 0.8 ? 1.25 : 1.75;
    cp.sub(ct).multiplyScalar(lerp(aspect >= 1.2 ? 1 : 1.0, kz, smooth(0.4, 1, s))).add(ct);
    px += (tx - px) * 0.05; py += (ty - py) * 0.05;
    cp.x += px * 0.4; cp.y -= py * 0.25;
    camera.position.copy(cp); camera.lookAt(ct);
    const off = smooth(0.45, 0.95, s);
    if (Wd >= 760) camera.setViewOffset(Wd, Hd, -Wd * 0.16 * off, 0, Wd, Hd);
    else camera.setViewOffset(Wd, Hd, 0, Hd * 0.16 * off, Wd, Hd);
  }

  const corner = V(0, 0, 0);
  let lastTag = '', lastNum = '';
  function hudUpdate(s) {
    const subj = s >= 4.6 && s < 5.55 ? W : s >= 5.55 && s < 6.55 ? Nn : A;
    let on = s > 0.55 && subj.face.visible && subj.face.material.opacity > 0.4, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    if (on) {
      subj.mesh.updateMatrixWorld();
      for (let i = 0; i < 4; i++) {
        corner.set(i & 1 ? 2.1 : -2.1, i & 2 ? 1.3 : -1.3, 0).applyMatrix4(subj.mesh.matrixWorld).project(camera);
        if (corner.z > 1) { on = false; break; }
        const X = (corner.x * 0.5 + 0.5) * Wd, Y = (-corner.y * 0.5 + 0.5) * Hd;
        x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
      }
    }
    box.style.opacity = on ? '1' : '0';
    if (on) { const right = x0 > Wd * 0.55; tag.style.left = right ? 'auto' : '-1.5px'; tag.style.right = right ? '-1.5px' : 'auto'; box.style.transform = `translate(${(x0 - 6).toFixed(1)}px,${(y0 - 6).toFixed(1)}px)`; box.style.width = `${(x1 - x0 + 12).toFixed(1)}px`; box.style.height = `${(y1 - y0 + 12).toFixed(1)}px`; }
    const label = s < 1.15 ? 'mem_22f16003d809' : s < 2.5 ? 'pinned · rule word "always"' : s < 3.5 ? 'one store, three agents' : s < 4.6 ? 'recall: matched "deploy"' : s < 5.55 ? 'hippo outcome --bad' : s < 6.55 ? 'hippo supersede mem_5f2b1c8e93a0' : 'pinned · never fades';
    if (label !== lastTag) { tag.textContent = label; lastTag = label; }
    const n = SEC + '.' + Math.round(clamp(s, 1, 7));
    if (n !== lastNum) { num.textContent = n; lastNum = n; }
    num.style.opacity = String(smooth(0.7, 1.0, s) * 0.9);
  }

  function measure(force) {
    const w = innerWidth, h = Math.min(innerHeight, 1600);
    if (!force && w === Wd && Math.abs(h - Hd) < 140) return false;
    Wd = w; Hd = h;
    root.style.setProperty('--vh', `${Hd}px`);
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.setSize(Wd, Hd, false); composer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); composer.setSize(Wd, Hd);
    camera.aspect = Wd / Hd; camera.updateProjectionMatrix();
    return true;
  }

  const stages = [...story.querySelectorAll('.stage')];
  let anchors = [[0, 0]], top0 = 0;
  function computeAnchors() {
    const top = story.getBoundingClientRect().top + scrollY + 40;
    top0 = top;
    anchors = [[top, 0]];
    stages.forEach((el, i) => {
      const cap = el.querySelector('.cap'); if (!cap) return;
      const capTop = el.getBoundingClientRect().top + scrollY + cap.offsetTop;
      const y = Wd < 760 ? capTop - Hd * 0.5 : capTop + cap.offsetHeight / 2 - Hd / 2;
      anchors.push([Math.max(y, anchors[anchors.length - 1][0] + 1), i === 0 ? 0.4 : i]);
    });
    anchors.push([Math.max(top + story.offsetHeight - 40 - Hd, anchors[anchors.length - 1][0] + 1), 7.8]);
  }
  function sAt(y) {
    if (y <= anchors[0][0]) return 0;
    for (let i = 0; i < anchors.length - 1; i++) { const a = anchors[i], b = anchors[i + 1]; if (y <= b[0]) return lerp(a[1], b[1], (y - a[0]) / (b[0] - a[0])); }
    return anchors[anchors.length - 1][1];
  }
  const side = narrow ? 10 : 16;
  function clip() {
    const p = clamp((scrollY - (top0 - Hd)) / Hd, 0, 1), k = Math.pow(1 - p, 2);
    win.style.clipPath = `inset(0px ${(side * k).toFixed(2)}px ${(64 * k).toFixed(2)}px ${(side * k).toFixed(2)}px round ${(24 * k).toFixed(2)}px)`;
  }

  let sTarget = 0, sCur = 0;
  measure(true); computeAnchors();
  const ST = ScrollTrigger;
  const onScroll = () => { sTarget = sAt(scrollY); clip(); };
  if (ST) {
    gsap.registerPlugin(ST);
    ST.config({ ignoreMobileResize: true });
    ST.create({ trigger: story, start: 'top bottom', end: 'bottom top', onUpdate: onScroll });
    ST.addEventListener('refresh', () => { computeAnchors(); onScroll(); });
    ST.refresh();
  } else addEventListener('scroll', onScroll, { passive: true });
  onScroll(); sCur = sTarget;
  addEventListener('resize', () => { if (measure(false)) { computeAnchors(); if (ST) ST.refresh(); onScroll(); } });
  addEventListener('pointermove', (e) => { if (Wd >= 760) { tx = e.clientX / Wd - 0.5; ty = e.clientY / innerHeight - 0.5; } }, { passive: true });
  new ResizeObserver(() => { computeAnchors(); onScroll(); }).observe(document.body);
  Promise.all([document.fonts.load(`500 54px ${SANS}`), document.fonts.load(`500 29px ${MONO}`), document.fonts.load(`800 84px ${DISP}`)])
    .then(() => { redraws.forEach((f) => f()); computeAnchors(); onScroll(); })
    .catch((err) => console.warn('hippo: fonts did not load, the cards use a fallback face', err));

  window.__film = { setS: (s) => { sTarget = sCur = s; }, anchors: () => anchors };
  let visible = false, raf = 0, last = performance.now();
  function frame(now) {
    if (!visible || document.hidden) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    sCur += (sTarget - sCur) * (1 - Math.exp(-dt * 5));
    update(now / 1000, sCur);
    composer.bloom.strength = GLOW[0] + (reduce ? 0 : 0.1 * Math.sin(now / 1000 * 1.3));
    composer.render();
    hudUpdate(sCur);
  }
  const wake = () => { if (!raf && visible && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; wake(); }, { rootMargin: '80px' }).observe(pin);
  document.addEventListener('visibilitychange', wake);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); visible = false; root.classList.remove('gl'); root.classList.add('static'); });
}
