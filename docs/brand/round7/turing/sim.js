// Gray-Scott on the GPU: ping-pong float targets, feed/kill vary per cell so the pattern thins out along a gradient.
import * as THREE from 'three';

export const rng = (seed) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const STEP = `
precision highp float;
uniform sampler2D uState, uParam; uniform vec2 uTx; uniform float uPhase; varying vec2 vUv;
void main(){
  vec2 c = texture2D(uState, vUv).rg;
  vec2 l = -c
    + 0.2 * (texture2D(uState, vUv + vec2(uTx.x, 0.)).rg + texture2D(uState, vUv - vec2(uTx.x, 0.)).rg
           + texture2D(uState, vUv + vec2(0., uTx.y)).rg + texture2D(uState, vUv - vec2(0., uTx.y)).rg)
    + 0.05 * (texture2D(uState, vUv + uTx).rg + texture2D(uState, vUv - uTx).rg
            + texture2D(uState, vUv + vec2(uTx.x, -uTx.y)).rg + texture2D(uState, vUv - vec2(uTx.x, -uTx.y)).rg);
  vec4 pp = texture2D(uParam, vUv); vec2 fk = mix(pp.rg, pp.ba, uPhase);
  float r = c.x * c.y * c.y;
  gl_FragColor = vec4(clamp(c + vec2(1.0 * l.x - r + fk.x * (1. - c.x), 0.5 * l.y + r - (fk.x + fk.y) * c.y), 0., 1.), 0., 1.);
}`;

// Gradient coordinate: 0 = dense trace, 1 = forgotten. Recall points keep a small living island inside the forgotten side.
export function layoutFn(q, num) {
  const mode = q.layout || 'side';
  const ang = num('ang', 0) * Math.PI / 180;
  const recall = (q.recall || '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));
  const rr = num('rr', 0.03);
  const g = (u, v) => {
    if (mode === 'radial') return Math.hypot(u - num('cx', 0.5), v - num('cy', 0.5)) / 0.5;
    return (u - 0.5) * Math.cos(ang) + (v - 0.5) * Math.sin(ang) + 0.5;
  };
  const mask = (u, v) => recall.reduce((m, [x, y, s = 1]) => Math.max(m, Math.exp(-((u - x) ** 2 + (v - y) ** 2) / (2 * (rr * s) ** 2))), 0);
  return { g, mask, recall };
}

export async function simulate(renderer, q, num) {
  const n = num('n', 512), steps = num('steps', 12000);
  const { g, mask, recall } = layoutFn(q, num);
  const [a, b] = [num('ga', 0.35), num('gb', 0.8)];
  const [f0, k0, f1, k1] = [num('f0', 0.055), num('k0', 0.062), num('f1', 0.03), num('k1', 0.066)];
  const [fr, kr] = [num('fr', 0.0367), num('kr', 0.0649)];
  const par = new Float32Array(n * n * 4), st = new Float32Array(n * n * 4);
  const rnd = rng(num('seed', 7));
  const nc = Math.ceil(n / num('cell', 9)) + 2, hv = Float32Array.from({ length: nc * nc }, rng(num('nseed', 3)));
  const noise = (u, v) => { // value noise at roughly one spot per cell
    const x = u * (nc - 2), y = v * (nc - 2), i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), h = (a, b) => hv[b * nc + a];
    return (h(i, j) * (1 - sx) + h(i + 1, j) * sx) * (1 - sy) + (h(i, j + 1) * (1 - sx) + h(i + 1, j + 1) * sx) * sy;
  };
  const [pa, pb, pmax] = [num('pa', 0.45), num('pb', 1.0), num('pmax', 0.97)];
  const pForget = (x) => pmax * smooth(pa, pb, x);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const u = i / (n - 1), v = j / (n - 1), o = 4 * (j * n + i);
    const t = smooth(a, b, g(u, v)), m = mask(u, v) > 0.5 ? 1 : 0;
    par[o] = m ? fr : f0 + (f1 - f0) * t;
    par[o + 1] = m ? kr : k0 + (k1 - k0) * t;
    const dead = !m && noise(u, v) < pForget(g(u, v));
    par[o + 2] = dead ? 0.03 : par[o];
    par[o + 3] = dead ? 0.072 : m ? kr : par[o + 1] + num('kslow', 0.0025) * t;
    st[o] = 1; st[o + 3] = 1;
  }
  const seeds = num('seeds', n * n / 900);
  for (let s = 0; s < seeds; s++) {
    const cx = Math.floor(rnd() * n), cy = Math.floor(rnd() * n), r = 2 + Math.floor(rnd() * 3);
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const X = cx + x, Y = cy + y;
      if (X >= 0 && Y >= 0 && X < n && Y < n) { const o = 4 * (Y * n + X); st[o] = 0.5; st[o + 1] = 0.25 + 0.05 * rnd(); }
    }
  }
  const tex = (d) => { const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat, THREE.FloatType); t.needsUpdate = true; return t; };
  const rt = () => new THREE.WebGLRenderTarget(n, n, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
  const ping = [rt(), rt()];
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: STEP,
    uniforms: { uState: { value: tex(st) }, uParam: { value: tex(par) }, uTx: { value: new THREE.Vector2(1 / n, 1 / n) }, uPhase: { value: 0 } },
  });
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  const per = num('per', 500);
  let cur = 0;
  const decayAt = steps - num('decay', 2500);
  for (let s = 0; s < steps; s++) {
    mat.uniforms.uPhase.value = s >= decayAt ? 1 : 0;
    renderer.setRenderTarget(ping[cur]);
    renderer.render(scene, cam);
    mat.uniforms.uState.value = ping[cur].texture;
    cur ^= 1;
    if (s % per === per - 1) await new Promise(requestAnimationFrame);
  }
  const out = new Float32Array(n * n * 4);
  renderer.readRenderTargetPixels(ping[cur ^ 1], 0, 0, n, n, out);
  renderer.setRenderTarget(null);
  const B = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) B[i] = out[4 * i + 1];
  return { n, B, g, mask, recall };
}
