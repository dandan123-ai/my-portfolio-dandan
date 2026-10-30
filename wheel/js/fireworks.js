/**
 * Dream Wheel — night-mode fireworks system.
 *
 * Public API (task-4 / Lead integration):
 *   createFireworks({ scene, camera, quality = 'high' }) -> {
 *     group,                 // THREE.Group, added to scene by the module (idempotent)
 *     setActive(bool),       // enable/disable the launch show
 *     setOpacity(v),         // 0..1 master opacity for the day -> night crossfade
 *     update(dt, time),      // call every frame
 *     burst(worldPos?, paletteName?), // manual celebration burst
 *     stats,                 // { drawCalls, particles, bursts, ... }
 *   }
 *
 * Rendering: everything lives in 4 shared pooled draw calls:
 *   - LineSegments  : additive HDR motion-streak trails (1 call)
 *   - Points        : additive soft-sprite spark heads, per-particle size (1 call)
 *   - Points        : additive soft halo layer sharing the head geometry (1 call)
 *   - Points        : additive soft glow pool — muzzle flashes, burst blooms and
 *                     rising rocket heads (1 call)
 * `toneMapped:false` materials keep colours > 1 in the composer's HDR target so the
 * scene's UnrealBloom (threshold 0.90) picks them up and makes them bloom.
 *
 * Design notes
 *   - Burst centres are chosen by projecting candidates through the live camera, so
 *     every launch lands in the visible upper sky around/behind the wheel.
 *   - The scheduler self-regulates to 5–8 concurrent bursts with a volley every
 *     1.2–2.8 s, plus a bigger finale every ~20 s.
 *   - Deterministic PRNG (design.js makePRNG) for the look; screenshots reproducible.
 */
import * as THREE from 'three';
import { TAU, R, HUB_Y, makePRNG, rr, canvasTexture } from './design.js';

/* ------------------------------------------------------------------ *
 *  Palette — warm gold / rose / blush / cream / lavender / ice / white
 * ------------------------------------------------------------------ */
const PALETTE_DEFS = [
  { name: 'gold', weight: 20, core: '#fff1c4', mid: '#ffab12', edge: '#ff6f00' },
  { name: 'rose', weight: 18, core: '#ffd2e2', mid: '#ff4f7d', edge: '#d81c52' },
  { name: 'blush', weight: 12, core: '#ffe4da', mid: '#ff8b80', edge: '#e84a52' },
  { name: 'cream', weight: 8, core: '#fff3d2', mid: '#ffd488', edge: '#eea646' },
  { name: 'lavender', weight: 9, core: '#e9dbff', mid: '#ad78ff', edge: '#7a3fd6' },
  { name: 'ice', weight: 11, core: '#dff5ff', mid: '#6fd0ff', edge: '#1f96e8' },
  { name: 'white', weight: 5, core: '#ffffff', mid: '#dfe8ff', edge: '#a8bde6' },
  { name: 'roseGold', weight: 9, core: '#ffe8c8', mid: '#ff8f7c', edge: '#e84e70' },
  { name: 'amber', weight: 8, core: '#ffecac', mid: '#ffbb2e', edge: '#ff7d14' },
];

function hexLinear(hex) {
  const c = new THREE.Color(hex); // sRGB -> linear working space
  return new Float32Array([c.r, c.g, c.b]);
}

/* ------------------------------------------------------------------ *
 *  Burst styles
 * ------------------------------------------------------------------ */
const STYLE_PEONY = 0;
const STYLE_CHRYS = 1;
const STYLE_WILLOW = 2;
const STYLE_RING = 3;
const STYLE_PALM = 4;
const STYLE_CRACKLE = 5;

const STYLE_WEIGHTS = [36, 24, 10, 0, 16, 14]; // peony, chrys, willow, ring (off), palm, crackle

// count base, speed, drag, gravity, life, tail (s), head size (world), fade exponent, sparkle ratio
const STYLE_DEFS = [
  { count: 360, speed: [20, 28], drag: [0.72, 0.95], grav: [5.2, 6.8], life: [1.9, 2.3], tail: [0.090, 0.150], size: [0.60, 1.05], fade: [1.00, 1.25], sparkle: 0.20 }, // peony
  { count: 400, speed: [18, 25], drag: [0.60, 0.82], grav: [5.8, 7.2], life: [2.1, 2.6], tail: [0.130, 0.200], size: [0.60, 1.00], fade: [0.92, 1.15], sparkle: 0.45 }, // chrysanthemum
  { count: 280, speed: [14, 19], drag: [1.00, 1.30], grav: [3.0, 4.0], life: [2.3, 2.8], tail: [0.160, 0.230], size: [0.70, 1.15], fade: [0.70, 0.92], sparkle: 0.30 }, // willow
  { count: 250, speed: [19, 25], drag: [0.68, 0.90], grav: [4.4, 5.8], life: [1.8, 2.2], tail: [0.080, 0.130], size: [0.60, 1.00], fade: [1.05, 1.28], sparkle: 0.15 }, // ring
  { count: 380, speed: [21, 28], drag: [0.75, 0.98], grav: [5.6, 7.0], life: [2.0, 2.5], tail: [0.110, 0.170], size: [0.65, 1.05], fade: [0.98, 1.22], sparkle: 0.35 }, // palm
  { count: 240, speed: [11, 15], drag: [1.00, 1.25], grav: [4.8, 6.0], life: [1.8, 2.2], tail: [0.090, 0.150], size: [0.55, 0.90], fade: [0.80, 1.00], sparkle: 0.95 }, // crackle
];

const QUALITY_HIGH = {
  quality: 'high',
  seed: 0x2026f1,
  maxParticles: 3200,
  volleyMin: 0.95, volleyMax: 1.55,    // volley cadence (s) — inside the 1.2–2.0 s spec
  maxPerVolley: 3,
  concurrency: [5, 6],
  finaleEvery: [17, 26],
  rocketChance: 0.32,
  emitterRate: 68,                    // rocket trail sparks per second
  maxGlows: 36,
  particleScale: 1.0,
};

const QUALITY_LOW = {
  quality: 'low',
  seed: 0x2026f1,
  maxParticles: 1400,
  volleyMin: 1.3, volleyMax: 2.2,
  maxPerVolley: 2,
  concurrency: [2, 4],
  finaleEvery: [24, 36],
  rocketChance: 0.25,
  emitterRate: 40,
  maxGlows: 20,
  particleScale: 0.55,
};

/* ------------------------------------------------------------------ *
 *  Rocket / glow pool kinds
 * ------------------------------------------------------------------ */
const KIND_FLASH = 0;
const KIND_ROCKET = 1;

/* ================================================================== *
 *  FACTORY
 * ================================================================== */
export function createFireworks({ scene, camera, quality = 'high' } = {}) {
  if (!scene) throw new Error('createFireworks: scene is required');
  const cfg = quality === 'low' ? QUALITY_LOW : QUALITY_HIGH;
  const MAX = cfg.maxParticles;
  const GMAX = cfg.maxGlows;
  const rng = makePRNG(cfg.seed);
  const rand = (a, b) => rr(rng, a, b);
  const randInt = (a, b) => a + Math.floor(rng() * (b - a + 1));

  const isLow = () => cfg.quality === 'low';

  const palettes = PALETTE_DEFS.map((p) => ({
    name: p.name,
    weight: p.weight,
    core: hexLinear(p.core),
    mid: hexLinear(p.mid),
    edge: hexLinear(p.edge),
  }));

  function pickWeighted(weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = rng() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return 0;
  }
  function pickPalette() { return pickWeighted(palettes.map((p) => p.weight)); }
  function pickStyle() { return pickWeighted(STYLE_WEIGHTS); }
  function paletteIndexByName(name) {
    if (!name) return -1;
    for (let i = 0; i < palettes.length; i++) if (palettes[i].name === name) return i;
    return -1;
  }

  /* ---------------------------------------------------------------- *
   *  Scene group
   * ---------------------------------------------------------------- */
  const group = new THREE.Group();
  group.name = 'fireworks';
  if (!group.parent) scene.add(group);

  /* ---------------------------------------------------------------- *
   *  Soft sprite textures (alpha only; colour comes from HDR vertices)
   * ---------------------------------------------------------------- */
  const sparkTex = canvasTexture(
    128, 128,
    (g, w, h) => {
      g.clearRect(0, 0, w, h);
      const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      grad.addColorStop(0.0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.10, 'rgba(255,255,255,0.97)');
      grad.addColorStop(0.24, 'rgba(255,255,255,0.55)');
      grad.addColorStop(0.46, 'rgba(255,255,255,0.16)');
      grad.addColorStop(0.72, 'rgba(255,255,255,0.035)');
      grad.addColorStop(1.0, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    },
    { srgb: false },
  );

  const glowTex = canvasTexture(
    128, 128,
    (g, w, h) => {
      g.clearRect(0, 0, w, h);
      const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      grad.addColorStop(0.0, 'rgba(255,255,255,0.90)');
      grad.addColorStop(0.18, 'rgba(255,255,255,0.62)');
      grad.addColorStop(0.42, 'rgba(255,255,255,0.22)');
      grad.addColorStop(0.70, 'rgba(255,255,255,0.055)');
      grad.addColorStop(1.0, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    },
    { srgb: false },
  );

  const POINT_VERT = /* glsl */ `
    attribute vec3 aColor;
    attribute float aSize;
    uniform float uScale;
    uniform float uSizeMul;
    uniform float uGain;
    varying vec3 vColor;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = clamp(aSize * uSizeMul * uScale / max(-mv.z, 1.0), 1.0, 460.0);
      vColor = aColor * uGain;
    }
  `;
  const POINT_FRAG = /* glsl */ `
    uniform sampler2D uMap;
    uniform float uOpacity;
    varying vec3 vColor;
    void main() {
      float a = texture2D(uMap, gl_PointCoord).a;
      if (a < 0.004) discard;
      gl_FragColor = vec4(vColor * (a * uOpacity), 1.0);
    }
  `;

  function makePointMaterial(tex, sizeMul = 1, gain = 1) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: tex },
        uScale: { value: 1300 },
        uSizeMul: { value: sizeMul },
        uGain: { value: gain },
        uOpacity: { value: 1 },
      },
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
  }

  /* ---------------------------------------------------------------- *
   *  Shared pooled geometry — sparks (trails + heads)
   * ---------------------------------------------------------------- */
  // simulation arrays (index == pool slot; slots [0, sparkCount) are alive)
  const aPos = new Float32Array(MAX * 3);
  const aVel = new Float32Array(MAX * 3);
  const aCol = new Float32Array(MAX * 3);   // linear HDR colour
  const aLife = new Float32Array(MAX);
  const aMaxLife = new Float32Array(MAX);
  const aDrag = new Float32Array(MAX);
  const aGrav = new Float32Array(MAX);
  const aSize = new Float32Array(MAX);
  const aTail = new Float32Array(MAX);
  const aFadeExp = new Float32Array(MAX);
  const aTwAmp = new Float32Array(MAX);
  const aTwFreq = new Float32Array(MAX);
  const aTwPhase = new Float32Array(MAX);
  let sparkCount = 0;

  // render buffers
  const trailPos = new Float32Array(MAX * 6);   // 2 verts / spark
  const trailCol = new Float32Array(MAX * 6);
  const headPos = new Float32Array(MAX * 3);
  const headCol = new Float32Array(MAX * 3);
  const headSize = new Float32Array(MAX);

  const trailGeo = new THREE.BufferGeometry();
  const trailPosAttr = new THREE.BufferAttribute(trailPos, 3).setUsage(THREE.DynamicDrawUsage);
  const trailColAttr = new THREE.BufferAttribute(trailCol, 3).setUsage(THREE.DynamicDrawUsage);
  trailGeo.setAttribute('position', trailPosAttr);
  trailGeo.setAttribute('color', trailColAttr);
  trailGeo.setDrawRange(0, 0);

  const trailMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    fog: false,
    opacity: 1,
  });
  const trails = new THREE.LineSegments(trailGeo, trailMat);
  trails.frustumCulled = false;
  trails.renderOrder = 8;
  trails.visible = false;
  group.add(trails);

  const headGeo = new THREE.BufferGeometry();
  const headPosAttr = new THREE.BufferAttribute(headPos, 3).setUsage(THREE.DynamicDrawUsage);
  const headColAttr = new THREE.BufferAttribute(headCol, 3).setUsage(THREE.DynamicDrawUsage);
  const headSizeAttr = new THREE.BufferAttribute(headSize, 1).setUsage(THREE.DynamicDrawUsage);
  headGeo.setAttribute('position', headPosAttr);
  headGeo.setAttribute('aColor', headColAttr);
  headGeo.setAttribute('aSize', headSizeAttr);
  headGeo.setDrawRange(0, 0);

  const headMat = makePointMaterial(sparkTex, 1.0, 1.0);
  const heads = new THREE.Points(headGeo, headMat);
  heads.frustumCulled = false;
  heads.renderOrder = 9;
  heads.visible = false;
  group.add(heads);

  // one extra soft additive halo layer sharing the same geometry: gives every
  // spark a faint colour bloom (no extra buffers, one extra draw call).
  const haloMat = makePointMaterial(glowTex, 2.2, 0.12);
  const halos = new THREE.Points(headGeo, haloMat);
  halos.frustumCulled = false;
  halos.renderOrder = 8;
  halos.visible = false;
  group.add(halos);

  /* ---------------------------------------------------------------- *
   *  Glow pool (muzzle flashes + rocket heads) — one more draw call
   * ---------------------------------------------------------------- */
  const gPos = new Float32Array(GMAX * 3);
  const gVel = new Float32Array(GMAX * 3);
  const gCol = new Float32Array(GMAX * 3);
  const gLife = new Float32Array(GMAX);
  const gLifeMax = new Float32Array(GMAX);
  const gSize0 = new Float32Array(GMAX);
  const gSize1 = new Float32Array(GMAX);
  const gDrag = new Float32Array(GMAX);
  const gGrav = new Float32Array(GMAX);
  const gEmit = new Float32Array(GMAX);
  const gKind = new Uint8Array(GMAX);
  const gStyle = new Int8Array(GMAX);
  const gPal = new Int8Array(GMAX);
  const gTier = new Float32Array(GMAX);
  const gSpeed = new Float32Array(GMAX);
  let glowCount = 0;

  const glowPos = new Float32Array(GMAX * 3);
  const glowCol = new Float32Array(GMAX * 3);
  const glowSize = new Float32Array(GMAX);

  const glowGeo = new THREE.BufferGeometry();
  const glowPosAttr = new THREE.BufferAttribute(glowPos, 3).setUsage(THREE.DynamicDrawUsage);
  const glowColAttr = new THREE.BufferAttribute(glowCol, 3).setUsage(THREE.DynamicDrawUsage);
  const glowSizeAttr = new THREE.BufferAttribute(glowSize, 1).setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('position', glowPosAttr);
  glowGeo.setAttribute('aColor', glowColAttr);
  glowGeo.setAttribute('aSize', glowSizeAttr);
  glowGeo.setDrawRange(0, 0);

  const glowMat = makePointMaterial(glowTex, 1.0, 1.0);
  const glows = new THREE.Points(glowGeo, glowMat);
  glows.frustumCulled = false;
  glows.renderOrder = 10;
  glows.visible = false;
  group.add(glows);

  /* ---------------------------------------------------------------- *
   *  State
   * ---------------------------------------------------------------- */
  let simTime = 0;
  let active = false;
  let opacity = 1;
  let launchTimer = 0.05;
  let finaleTimer = 0;
  let totalLaunches = 0;
  let totalBursts = 0;
  let rocketsInFlight = 0;
  const liveBursts = [];     // end times (simTime) of bursts that are still visible
  const pendingLaunches = []; // { at, style, pal, tier, deep }

  const stats = {
    quality: cfg.quality,
    drawCalls: 0,
    particles: 0,
    bursts: 0,
    glows: 0,
    capacity: MAX,
    launches: 0,
    burstsTotal: 0,
  };

  /* ---------------------------------------------------------------- *
   *  Small helpers / temps (no per-frame allocation)
   * ---------------------------------------------------------------- */
  const _p = new THREE.Vector3();
  const _tmpA = new THREE.Vector3();
  const _tmpB = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _u = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _q = new THREE.Vector3();
  const VIEW = { W: 1500, H: 950 };
  const _recent = []; // recent screen-space burst centres (spacing) {x, y, r}
  const _moonScr = { x: 0, y: 0, r: 0, ok: false };

  function updatePointScale() {
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    const h = (typeof window !== 'undefined' ? window.innerHeight || 950 : 950) * dpr;
    const p5 = camera && camera.projectionMatrix ? camera.projectionMatrix.elements[5] : 2.747;
    const s = 0.5 * h * p5;
    headMat.uniforms.uScale.value = s;
    haloMat.uniforms.uScale.value = s;
    glowMat.uniforms.uScale.value = s;
  }

  /* ---------------------------------------------------------------- *
   *  Spark spawn / kill
   * ---------------------------------------------------------------- */
  function moveParticle(dst, src) {
    const d3 = dst * 3, s3 = src * 3;
    aPos[d3] = aPos[s3]; aPos[d3 + 1] = aPos[s3 + 1]; aPos[d3 + 2] = aPos[s3 + 2];
    aVel[d3] = aVel[s3]; aVel[d3 + 1] = aVel[s3 + 1]; aVel[d3 + 2] = aVel[s3 + 2];
    aCol[d3] = aCol[s3]; aCol[d3 + 1] = aCol[s3 + 1]; aCol[d3 + 2] = aCol[s3 + 2];
    aLife[dst] = aLife[src]; aMaxLife[dst] = aMaxLife[src];
    aDrag[dst] = aDrag[src]; aGrav[dst] = aGrav[src];
    aSize[dst] = aSize[src]; aTail[dst] = aTail[src];
    aFadeExp[dst] = aFadeExp[src];
    aTwAmp[dst] = aTwAmp[src]; aTwFreq[dst] = aTwFreq[src]; aTwPhase[dst] = aTwPhase[src];
  }

  function spawnSpark(x, y, z, vx, vy, vz, cr, cg, cb, lifeMax, sz, dragV, gravV, tailV, fadeV, twAmp, twFreq) {
    if (sparkCount >= MAX) return -1;
    const i = sparkCount++;
    const i3 = i * 3, i6 = i * 6;
    aPos[i3] = x; aPos[i3 + 1] = y; aPos[i3 + 2] = z;
    aVel[i3] = vx; aVel[i3 + 1] = vy; aVel[i3 + 2] = vz;
    aCol[i3] = cr; aCol[i3 + 1] = cg; aCol[i3 + 2] = cb;
    aLife[i] = 0;
    aMaxLife[i] = lifeMax;
    aDrag[i] = dragV;
    aGrav[i] = gravV;
    aSize[i] = sz;
    aTail[i] = tailV;
    aFadeExp[i] = fadeV;
    aTwAmp[i] = twAmp;
    aTwFreq[i] = twFreq;
    aTwPhase[i] = rng() * TAU;

    // valid first-frame visuals (the next update rewrites these)
    headPos[i3] = x; headPos[i3 + 1] = y; headPos[i3 + 2] = z;
    headCol[i3] = cr; headCol[i3 + 1] = cg; headCol[i3 + 2] = cb;
    headSize[i] = sz;
    trailPos[i6] = x; trailPos[i6 + 1] = y; trailPos[i6 + 2] = z;
    trailPos[i6 + 3] = x; trailPos[i6 + 4] = y; trailPos[i6 + 5] = z;
    trailCol[i6] = 0; trailCol[i6 + 1] = 0; trailCol[i6 + 2] = 0;
    trailCol[i6 + 3] = 0; trailCol[i6 + 4] = 0; trailCol[i6 + 5] = 0;
    return i;
  }

  /* ---------------------------------------------------------------- *
   *  Glow spawn / kill
   * ---------------------------------------------------------------- */
  function moveGlow(dst, src) {
    const d3 = dst * 3, s3 = src * 3;
    for (let k = 0; k < 3; k++) { gPos[d3 + k] = gPos[s3 + k]; gVel[d3 + k] = gVel[s3 + k]; gCol[d3 + k] = gCol[s3 + k]; }
    gLife[dst] = gLife[src]; gLifeMax[dst] = gLifeMax[src];
    gSize0[dst] = gSize0[src]; gSize1[dst] = gSize1[src];
    gDrag[dst] = gDrag[src]; gGrav[dst] = gGrav[src]; gEmit[dst] = gEmit[src];
    gKind[dst] = gKind[src]; gStyle[dst] = gStyle[src]; gPal[dst] = gPal[src]; gTier[dst] = gTier[src];
    gSpeed[dst] = gSpeed[src];
  }

  function renderGlowSlot(i) {
    const i3 = i * 3;
    glowPos[i3] = gPos[i3]; glowPos[i3 + 1] = gPos[i3 + 1]; glowPos[i3 + 2] = gPos[i3 + 2];
    const u = Math.min(1, gLife[i] / Math.max(0.0001, gLifeMax[i]));
    if (gKind[i] === KIND_ROCKET) {
      const flick = 1 + 0.20 * Math.sin(simTime * 47 + i * 2.31) + 0.08 * Math.sin(simTime * 113 + i);
      glowCol[i3] = gCol[i3] * flick; glowCol[i3 + 1] = gCol[i3 + 1] * flick; glowCol[i3 + 2] = gCol[i3 + 2] * flick;
      glowSize[i] = gSize0[i];
    } else {
      const f = (1 - u) * (1 - u);
      glowCol[i3] = gCol[i3] * f; glowCol[i3 + 1] = gCol[i3 + 1] * f; glowCol[i3 + 2] = gCol[i3 + 2] * f;
      glowSize[i] = gSize0[i] + (gSize1[i] - gSize0[i]) * u;
    }
  }

  function spawnGlow(x, y, z, vx, vy, vz, lifeMax, size0, size1, cr, cg, cb, dragV, gravV, kind, style, pal, tier, speedMul = 1) {
    if (glowCount >= GMAX) return -1;
    const i = glowCount++;
    const i3 = i * 3;
    gPos[i3] = x; gPos[i3 + 1] = y; gPos[i3 + 2] = z;
    gVel[i3] = vx; gVel[i3 + 1] = vy; gVel[i3 + 2] = vz;
    gCol[i3] = cr; gCol[i3 + 1] = cg; gCol[i3 + 2] = cb;
    gLife[i] = 0; gLifeMax[i] = lifeMax;
    gSize0[i] = size0; gSize1[i] = size1;
    gDrag[i] = dragV; gGrav[i] = gravV; gEmit[i] = 0;
    gKind[i] = kind; gStyle[i] = style; gPal[i] = pal; gTier[i] = tier; gSpeed[i] = speedMul;
    renderGlowSlot(i);
    return i;
  }

  function killGlow(i) {
    glowCount--;
    if (i !== glowCount) moveGlow(i, glowCount);
    if (glowCount > 0) renderGlowSlot(i < glowCount ? i : glowCount - 1);
  }

  /* ---------------------------------------------------------------- *
   *  Burst construction
   * ---------------------------------------------------------------- */
  function spawnMuzzleFlash(x, y, z, pal, tier) {
    const k = 0.85 + 0.3 * tier;
    // hot core
    spawnGlow(
      x, y, z, 0, 0, 0,
      0.20 + 0.06 * rng(),
      (2.6 + 1.2 * tier) * k, (3.4 + 1.6 * tier) * k,
      pal.core[0] * 1.25, pal.core[1] * 1.25, pal.core[2] * 1.25,
      0, 0, KIND_FLASH, -1, -1, 0,
    );
    // soft coloured halo
    spawnGlow(
      x + rand(-0.5, 0.5), y + rand(-0.5, 0.5), z + rand(-0.5, 0.5), 0, 0, 0,
      0.34 + 0.14 * rng(),
      (8.0 + 5.0 * tier) * k, (13.0 + 7.0 * tier) * k,
      pal.mid[0] * 0.9, pal.mid[1] * 0.9, pal.mid[2] * 0.9,
      0, 0, KIND_FLASH, -1, -1, 0,
    );
  }

  /**
   * Spawn one burst. tier ~0.6 small, 1.0 medium, 1.35 large. deep = distant/fainter.
   * speedMul lets the placement code hit an exact on-screen radius for the chosen depth.
   */
  function spawnBurstAt(x, y, z, style, palIdx, tier, deep = false, speedMul = 1) {
    const room = MAX - sparkCount;
    if (room < 32) return false;
    if (palIdx < 0 || palIdx >= palettes.length) palIdx = pickPalette();
    const pal = palettes[palIdx];
    const def = STYLE_DEFS[style] || STYLE_DEFS[0];
    const pal2 = rng() < 0.34 ? palettes[pickPalette()] : null;
    const tierP = 0.62 + 0.62 * tier; // particle multiplier
    let n = Math.round(def.count * tierP * cfg.particleScale * (deep ? 0.62 : 1));
    n = Math.min(n, room - 12);
    if (n < 18) return false;

    const speedScale = (0.78 + 0.22 * tier) * (deep ? 0.8 : 1) * speedMul;
    const baseSpeed = rand(def.speed[0], def.speed[1]) * speedScale;
    const baseDrag = rand(def.drag[0], def.drag[1]);
    const baseGrav = rand(def.grav[0], def.grav[1]);
    const baseLife = rand(def.life[0], def.life[1]) * (0.92 + 0.08 * tier) * (deep ? 1.08 : 1);
    const baseTail = rand(def.tail[0], def.tail[1]);
    const sizeScale = (0.85 + 0.25 * tier) * (deep ? 1.12 : 1);
    const baseSize = rand(def.size[0], def.size[1]) * sizeScale;
    const baseFade = rand(def.fade[0], def.fade[1]);
    const sparkle = def.sparkle;
    const burstBase = deep ? 2.5 : 3.4 + 0.7 * tier;

    let cx = x, cy = y, cz = z;
    if (deep) {
      cx += rand(-2, 2); cy += rand(-2, 2); cz += rand(-2, 2);
    }

    // ring frame — face the camera so the ring reads as a ring, never as an edge-on line
    let ringUx = 0, ringUy = 0, ringUz = 0, ringVx = 0, ringVy = 0, ringVz = 0;
    if (style === STYLE_RING) {
      if (camera) {
        _n.copy(camera.position).sub(_tmpA.set(cx, cy, cz)).normalize();
      } else {
        _n.set(rand(-1, 1), rand(-1, 1), rand(-1, 1));
      }
      _n.x += rand(-0.34, 0.34);
      _n.y += rand(-0.28, 0.28);
      _n.z += rand(-0.34, 0.34);
      if (_n.lengthSq() < 0.02) _n.set(0.2, 1, 0.1);
      _n.normalize();
      _u.set(0, 1, 0);
      if (Math.abs(_n.y) > 0.9) _u.set(1, 0, 0);
      _u.crossVectors(_n, _u).normalize();
      _v.crossVectors(_n, _u).normalize();
      ringUx = _u.x; ringUy = _u.y; ringUz = _u.z;
      ringVx = _v.x; ringVy = _v.y; ringVz = _v.z;
    }

    // palm arms
    let armCount = 0, perArm = 0;
    if (style === STYLE_PALM) {
      armCount = randInt(9, 13);
      perArm = Math.max(3, Math.round(n / armCount));
      n = Math.min(n, armCount * perArm);
    }

    for (let k = 0; k < n; k++) {
      let dx = 0, dy = 0, dz = 0, sp = baseSpeed;

      if (style === STYLE_RING) {
        const th = rng() * TAU;
        const ct = Math.cos(th), st = Math.sin(th);
        dx = ringUx * ct + ringVx * st;
        dy = ringUy * ct + ringVy * st;
        dz = ringUz * ct + ringVz * st;
        // thin the ring plane slightly
        dx += _n.x * rand(-0.05, 0.05);
        dy += _n.y * rand(-0.05, 0.05);
        dz += _n.z * rand(-0.05, 0.05);
        sp = baseSpeed * rand(0.94, 1.07);
      } else if (style === STYLE_PALM) {
        const arm = Math.floor(k / perArm);
        const j = k % perArm;
        // deterministic arm direction per arm index
        const az = (arm / armCount) * TAU + rand(-0.06, 0.06);
        const el = rand(0.12, 1.22);
        const ce = Math.cos(el);
        dx = ce * Math.cos(az);
        dy = Math.sin(el);
        dz = ce * Math.sin(az);
        const frac = (j + 1) / perArm;
        sp = baseSpeed * (0.28 + 0.78 * frac) * rand(0.94, 1.06);
      } else if (style === STYLE_PEONY || style === STYLE_CHRYS) {
        // even Fibonacci shell + jitter: a clean radiating sphere, no random clumps
        const uz = 1 - 2 * ((k + 0.5) / n);
        const jz = rand(-0.05, 0.05);
        const u2 = Math.max(-1, Math.min(1, uz + jz));
        const ph = k * 2.399963229728653 + rand(-0.10, 0.10);
        const sxy = Math.sqrt(Math.max(0, 1 - u2 * u2));
        dx = sxy * Math.cos(ph);
        dy = u2;
        dz = sxy * Math.sin(ph);
        if (style === STYLE_PEONY) {
          // 72% shell + 28% filled centre for depth
          const shell = rng() < 0.72;
          sp = baseSpeed * (shell ? rand(0.92, 1.08) : rand(0.48, 0.9));
        } else {
          sp = baseSpeed * rand(0.88, 1.10);
        }
      } else if (style === STYLE_WILLOW) {
        // drooping golden willow: start outward/up then fall slowly
        const uz = rand(-1, 1);
        const ph = rng() * TAU;
        const sxy = Math.sqrt(Math.max(0, 1 - uz * uz));
        dx = sxy * Math.cos(ph);
        dy = uz * 0.72 + 0.28;
        dz = sxy * Math.sin(ph);
        sp = baseSpeed * rand(0.85, 1.1);
      } else {
        // uniform random sphere (crackle / fallback)
        const uz = rand(-1, 1);
        const ph = rng() * TAU;
        const sxy = Math.sqrt(Math.max(0, 1 - uz * uz));
        dx = sxy * Math.cos(ph);
        dy = uz;
        dz = sxy * Math.sin(ph);
        sp = baseSpeed * rand(0.9, 1.1);
      }

      // colour: mostly saturated mid-tone, a few white-hot cores / deep edges
      const rc = rng();
      let cr, cg, cb, inten;
      if (rc < 0.12) {
        cr = pal.core[0]; cg = pal.core[1]; cb = pal.core[2];
        inten = burstBase * 1.35;
      } else if (rc < 0.88) {
        cr = pal.mid[0]; cg = pal.mid[1]; cb = pal.mid[2];
        inten = burstBase;
      } else {
        cr = pal.edge[0]; cg = pal.edge[1]; cb = pal.edge[2];
        inten = burstBase * 0.85;
      }
      if (pal2 && rng() < 0.32) { cr = pal2.mid[0]; cg = pal2.mid[1]; cb = pal2.mid[2]; inten = burstBase; }
      inten *= rand(0.86, 1.14);
      cr *= inten; cg *= inten; cb *= inten;

      const twAmp = rng() < sparkle ? rand(0.35, 0.8) : 0;
      const twFreq = rand(20, 44);

      // slight positional scatter at birth keeps the centre alive
      const scat = style === STYLE_PALM ? 0.25 : 0.7;
      spawnSpark(
        cx + dx * rand(0, scat), cy + dy * rand(0, scat), cz + dz * rand(0, scat),
        dx * sp, dy * sp, dz * sp,
        cr, cg, cb,
        baseLife * rand(0.88, 1.12),
        baseSize * rand(0.82, 1.18),
        baseDrag * rand(0.9, 1.1),
        baseGrav * rand(0.9, 1.1),
        baseTail * rand(0.85, 1.15),
        baseFade * rand(0.92, 1.08),
        twAmp, twFreq,
      );
    }

    spawnMuzzleFlash(cx, cy, cz, pal, tier);

    // long-lived soft bloom at the burst centre: makes the whole shell luminous
    const natR = (((def.speed[0] + def.speed[1]) * 0.5 * (0.78 + 0.22 * tier) * (deep ? 0.8 : 1) * speedMul)
      / ((def.drag[0] + def.drag[1]) * 0.5));
    spawnGlow(
      cx, cy, cz, 0, 0, 0,
      baseLife * 0.78,
      natR * 0.55, natR * 2.15,
      pal.mid[0] * 0.40, pal.mid[1] * 0.40, pal.mid[2] * 0.40,
      0, 0, KIND_FLASH, -1, -1, 0,
    );

    liveBursts.push(simTime + baseLife);
    totalBursts++;
    return true;
  }

  /* ---------------------------------------------------------------- *
   *  Screen-space burst placement
   *
   *  The show is composed in screen space, not world space: a candidate is
   *  chosen in two clear-sky columns / above the wheel crown, then unprojected
   *  at the distance that makes the burst the requested on-screen size. That
   *  guarantees every burst is fully framed, clear of the wheel disc, clear
   *  of the moon and out of the top 8% of the frame for any camera pose.
   * ---------------------------------------------------------------- */
  function viewSize() {
    VIEW.W = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1500;
    VIEW.H = (typeof window !== 'undefined' && window.innerHeight) ? window.innerHeight : 950;
  }

  function projectPx(x, y, z, out) {
    _tmpB.set(x, y, z).project(camera);
    out.x = (_tmpB.x * 0.5 + 0.5) * VIEW.W;
    out.y = (0.5 - _tmpB.y * 0.5) * VIEW.H;
    out.z = _tmpB.z;
    return out;
  }

  /** Find the Lead's moon sprite (normal-blended sprite inside the night group). */
  function findMoonScreen() {
    _moonScr.ok = false;
    if (!scene || !scene.getObjectByName) return false;
    const night = scene.getObjectByName('nightMode');
    if (!night) return false;
    let sprite = null;
    night.traverse((o) => {
      if (sprite || !o.isSprite || !o.material || !o.material.map) return;
      if (o.material.blending === THREE.AdditiveBlending) return; // that's the halo
      sprite = o;
    });
    if (!sprite) return false;
    sprite.getWorldPosition(_tmpA);
    if (_tmpA.distanceTo(camera.position) < 10) return false;
    projectPx(_tmpA.x, _tmpA.y, _tmpA.z, _moonScr);
    if (_moonScr.z > 1) return false;
    _moonScr.r = Math.max(VIEW.W, VIEW.H) * 0.11;
    _moonScr.ok = true;
    return true;
  }

  /** Natural (final) world radius of a burst style, used to pick the depth. */
  function styleNaturalRadius(style, tier) {
    const d = STYLE_DEFS[style] || STYLE_DEFS[0];
    const v = (d.speed[0] + d.speed[1]) * 0.5 * (0.78 + 0.22 * tier);
    const drag = (d.drag[0] + d.drag[1]) * 0.5;
    return v / drag;
  }

  /** Pick a framed screen-space centre in one of the clear-sky regions. */
  function pickScreenCentre(Rp, deep, W, H, hub, wheelR) {
    const topLimit = 0.085 * H;
    const sideLimit = 0.028 * W;
    for (let attempt = 0; attempt < 40; attempt++) {
      const left = rng() < 0.5;
      let x0, x1;
      if (left) {
        x0 = Math.max(Rp * 0.95 + sideLimit, 0.055 * W);
        x1 = hub.x - wheelR * 1.06 - Rp * 0.16;
      } else {
        x0 = hub.x + wheelR * 1.06 + Rp * 0.16;
        x1 = W - Math.max(Rp * 0.95, 0.055 * W);
      }
      if (x1 <= x0 + 10) continue;
      const x = rand(x0, x1);

      // vertical band: upper sky, comfortably inside the frame (biased upward)
      const yTop = Math.max(topLimit + Rp, 0.105 * H);
      const yBot = (deep ? 0.68 : 0.63) * H - Rp * 0.30;
      if (yBot <= yTop + 10) continue;
      const y = yTop + (yBot - yTop) * Math.pow(rng(), 1.45);

      // fully framed with a margin
      if (x - Rp < sideLimit || x + Rp > W - sideLimit) continue;
      if (y - Rp < topLimit || y + Rp > 0.73 * H) continue;
      // centre must be outside the wheel disc (burst may graze the rim)
      if (Math.hypot(x - hub.x, y - hub.y) < wheelR * 1.06) continue;
      // keep the moon clean
      if (_moonScr.ok && Math.hypot(x - _moonScr.x, y - _moonScr.y) < _moonScr.r + Rp * 0.55) continue;
      // keep bursts from stacking on top of each other (recent only)
      let clash = false;
      for (let k = 0; k < _recent.length; k++) {
        const c = _recent[k];
        if (Math.hypot(x - c.x, y - c.y) < (Rp + c.r) * 0.62) { clash = true; break; }
      }
      if (clash) continue;
      return { x, y };
    }
    return null;
  }

  /** Drop stale spacing constraints (they must never starve the show). */
  function pruneRecent() {
    let w = 0;
    for (let i = 0; i < _recent.length; i++) {
      if (simTime - _recent[i].t < 2.5) _recent[w++] = _recent[i];
    }
    _recent.length = w;
  }

  const _targetPos = new THREE.Vector3();
  function worldFromScreenPx(px, py, dist, out) {
    const ndcX = (px / VIEW.W) * 2 - 1;
    const ndcY = 1 - (py / VIEW.H) * 2;
    _tmpA.set(ndcX, ndcY, 0.5).unproject(camera);
    _tmpA.sub(camera.position).normalize();
    out.copy(camera.position).addScaledVector(_tmpA, dist);
    return out;
  }

  /**
   * Returns { x, y, z, deep, speedMul, screenRadius } — a sky position whose
   * burst will be fully framed, or null if the camera cannot give one.
   */
  function pickBurstTarget(style, tier, wantDeep = -1) {
    if (!camera) return null;
    camera.updateMatrixWorld();
    viewSize();
    findMoonScreen();
    const hub = projectPx(0, HUB_Y, 0, { x: 0, y: 0, z: 0 });
    const top = projectPx(0, HUB_Y + R, 0, { x: 0, y: 0, z: 0 });
    let wheelR = Math.hypot(top.x - hub.x, top.y - hub.y);
    if (!(wheelR > 0.04 * VIEW.H)) wheelR = 0.3 * VIEW.H;
    if (hub.z > 1 || top.z > 1) return null;

    const p5 = camera.projectionMatrix ? camera.projectionMatrix.elements[5] : 2.747;
    const uScale = 0.5 * VIEW.H * p5; // css px per world unit at distance 1

    const deep = wantDeep >= 0 ? wantDeep > 0.5 : rng() < 0.12;
    const Rnat = styleNaturalRadius(style, tier) * (deep ? 0.8 : 1);
    pruneRecent();
    let Rp = deep ? rand(58, 92) : rand(112, 172) * (0.9 + 0.18 * tier);

    for (let round = 0; round < 2; round++) {
      for (let attempt = 0; attempt < 14; attempt++) {
        const c = pickScreenCentre(Rp, deep, VIEW.W, VIEW.H, hub, wheelR);
        if (!c) continue;
        const dist = THREE.MathUtils.clamp((Rnat * uScale) / Rp, 165, 420);
        worldFromScreenPx(c.x, c.y, dist, _targetPos);
        const p = _targetPos;
        if (p.y < 34 || p.y > 300) continue;
        if (p.z > -4 || p.z < -430) continue;
        if (Math.abs(p.x) > 480) continue;
        const speedMul = THREE.MathUtils.clamp((Rp * dist) / (Rnat * uScale), 0.65, 1.85);
        _recent.push({ x: c.x, y: c.y, r: Rp, t: simTime });
        if (_recent.length > 5) _recent.shift();
        return { x: p.x, y: p.y, z: p.z, deep, speedMul, screenRadius: Rp };
      }
      // still nothing? drop the spacing constraints and try again
      _recent.length = 0;
      Rp = Math.max(90, Rp * 0.86);
    }

    // guaranteed fallback: a clean spot beside the wheel, high in the sky
    const side = rng() < 0.5 ? -1 : 1;
    const fx = THREE.MathUtils.clamp(hub.x + side * (wheelR * 1.22 + 24), 0.12 * VIEW.W, VIEW.W - 0.12 * VIEW.W);
    const fy = THREE.MathUtils.clamp(hub.y - wheelR * 0.9, 0.20 * VIEW.H, 0.44 * VIEW.H);
    const rp = 120;
    const fdist = THREE.MathUtils.clamp((Rnat * uScale) / rp, 165, 420);
    worldFromScreenPx(fx, fy, fdist, _targetPos);
    const fspeedMul = THREE.MathUtils.clamp((rp * fdist) / (Rnat * uScale), 0.65, 1.85);
    return { x: _targetPos.x, y: _targetPos.y, z: _targetPos.z, deep: false, speedMul: fspeedMul, screenRadius: rp };
  }

  /** Legacy/simple sky fallback (also used if the camera is unavailable). */
  function pickBurstPosition(out) {
    const t = pickBurstTarget(pickStyle(), 1.0);
    if (t) { out.set(t.x, t.y, t.z); out.speedMul = t.speedMul; out.deep = t.deep; return out; }
    out.set(rand(-55, 55), rand(58, 86), rand(-95, -40));
    out.speedMul = 1;
    out.deep = false;
    return out;
  }

  /* ---------------------------------------------------------------- *
   *  Rockets & direct bursts
   * ---------------------------------------------------------------- */
  function launchRocket(spec) {
    const target = spec.pos
      ? { x: spec.pos.x, y: spec.pos.y, z: spec.pos.z, deep: !!spec.deep, speedMul: spec.speedMul || 1 }
      : pickBurstTarget(spec.style, spec.tier);
    if (!target) {
      // last-resort world-space fallback: never let the show go quiet
      target = { x: rand(-48, 48), y: rand(58, 86), z: rand(-95, -40), deep: false, speedMul: 1 };
    }
    const tx = target.x, ty = target.y, tz = target.z;
    totalLaunches++;

    const useRocket = !target.deep
      && Math.abs(tx) < 135
      && tz > -250
      && glowCount < GMAX - 2
      && rng() < cfg.rocketChance;
    if (!useRocket) {
      spawnBurstAt(tx, ty, tz, spec.style, spec.pal, spec.tier, !!target.deep, target.speedMul);
      return;
    }
    const T = rand(0.95, 1.35);
    const sx = tx + rand(-14, 14);
    const sz = tz + rand(-14, 8);
    const sy = rand(0.6, 3.2);
    const g = 6.0;
    const vx = (tx - sx) / T;
    const vz = (tz - sz) / T;
    const vy = (ty - sy) / T + 0.5 * g * T;
    const warm = 0.5 + 0.5 * rng();
    spawnGlow(
      sx, sy, sz, vx, vy, vz, T, 1.5 + 0.6 * spec.tier, 1.5 + 0.6 * spec.tier,
      2.9 + warm * 1.2, 2.5 + warm * 1.0, 1.9 + warm * 0.8,
      0, g, KIND_ROCKET, spec.style, spec.pal, spec.tier, target.speedMul,
    );
    rocketsInFlight++;
    // a little launch flash at the ground
    spawnGlow(sx, sy, sz, 0, 0, 0, 0.22, 2.4, 5.0,
      1.6, 1.05, 0.55, 0, 0, KIND_FLASH, -1, -1, 0);
  }

  function queueVolley(n) {
    const now = simTime;
    for (let k = 0; k < n; k++) {
      if (pendingLaunches.length > 10) break;
      pendingLaunches.push({
        at: now + rand(0.05, 0.55) + k * rand(0.10, 0.30),
        style: pickStyle(),
        pal: pickPalette(),
        tier: (() => { const r = rng(); return r < 0.42 ? 0.62 : r < 0.86 ? 1.0 : 1.35; })(),
        deep: false,
      });
    }
  }

  function queueFinale() {
    const n = isLow() ? 4 : randInt(5, 6);
    for (let k = 0; k < n; k++) {
      pendingLaunches.push({
        at: simTime + k * rand(0.08, 0.22) + rand(0, 0.15),
        style: k === 0 ? STYLE_WILLOW : pickStyle(),
        pal: k % 3 === 0 ? paletteIndexByName('gold') : pickPalette(),
        tier: k === 0 ? 1.35 : rand(1.1, 1.35),
        deep: false,
      });
    }
  }

  /* ---------------------------------------------------------------- *
   *  Per-frame simulation
   * ---------------------------------------------------------------- */
  function pruneBursts() {
    let w = 0;
    for (let i = 0; i < liveBursts.length; i++) {
      if (liveBursts[i] > simTime) liveBursts[w++] = liveBursts[i];
    }
    liveBursts.length = w;
  }

  function updateScheduler(dt) {
    if (!active) return;
    // pending staggered launches
    for (let i = pendingLaunches.length - 1; i >= 0; i--) {
      if (pendingLaunches[i].at <= simTime) {
        const spec = pendingLaunches[i];
        pendingLaunches.splice(i, 1);
        launchRocket(spec);
      }
    }
    launchTimer -= dt;
    if (launchTimer <= 0) {
      launchTimer = rand(cfg.volleyMin, cfg.volleyMax);
      // in-flight rockets will pop later; weight them partially so the show keeps
      // 3–5 bursts alive at any moment instead of damping itself into silence
      const projected = liveBursts.length
        + pendingLaunches.length * 0.6
        + rocketsInFlight * 0.6;
      if (liveBursts.length < cfg.concurrency[1] + 1) {
        const desired = randInt(cfg.concurrency[0], cfg.concurrency[1]);
        let need = desired - projected;
        if (need < 1) need = 1;
        need = Math.min(need, cfg.maxPerVolley);
        queueVolley(need);
      }
    }
    finaleTimer -= dt;
    if (finaleTimer <= 0) {
      finaleTimer = rand(cfg.finaleEvery[0], cfg.finaleEvery[1]);
      queueFinale();
    }
  }

  const HEAD_GAIN = 1.30;
  const TRAIL_GAIN = 2.45;
  const TRAIL_TAIL = 0.05;

  function updateSparks(dt) {
    let i = 0;
    while (i < sparkCount) {
      const life = aLife[i] + dt;
      const maxLife = aMaxLife[i];
      if (life >= maxLife) {
        sparkCount--;
        if (i !== sparkCount) moveParticle(i, sparkCount);
        continue;
      }
      aLife[i] = life;
      const i3 = i * 3;

      // drag (linearised) + gravity
      const k = Math.max(0, 1 - aDrag[i] * dt);
      let vx = aVel[i3] * k;
      let vy = aVel[i3 + 1] * k - aGrav[i] * dt;
      let vz = aVel[i3 + 2] * k;
      aVel[i3] = vx; aVel[i3 + 1] = vy; aVel[i3 + 2] = vz;

      const x = aPos[i3] + vx * dt;
      const y = aPos[i3 + 1] + vy * dt;
      const z = aPos[i3 + 2] + vz * dt;
      aPos[i3] = x; aPos[i3 + 1] = y; aPos[i3 + 2] = z;

      // fade
      const u = life / maxLife;
      let fade = Math.pow(1 - u, aFadeExp[i]);
      if (u < 0.045) fade *= u / 0.045;
      // twinkle
      let g = fade * HEAD_GAIN;
      if (aTwAmp[i] > 0.001) {
        g *= 1 + aTwAmp[i] * Math.sin(life * aTwFreq[i] + aTwPhase[i]);
      }

      // head
      headPos[i3] = x; headPos[i3 + 1] = y; headPos[i3 + 2] = z;
      headCol[i3] = aCol[i3] * g;
      headCol[i3 + 1] = aCol[i3 + 1] * g;
      headCol[i3 + 2] = aCol[i3 + 2] * g;
      headSize[i] = aSize[i] * (0.82 + 0.30 * fade);

      // motion-streak trail: back-extrapolated from velocity (stable across fps)
      const t = aTail[i];
      const tx = x - vx * t, ty = y - vy * t, tz = z - vz * t;
      const i6 = i * 6;
      trailPos[i6] = tx; trailPos[i6 + 1] = ty; trailPos[i6 + 2] = tz;
      trailPos[i6 + 3] = x; trailPos[i6 + 4] = y; trailPos[i6 + 5] = z;
      const tg = fade * TRAIL_GAIN;
      const tw = tg * TRAIL_TAIL;
      trailCol[i6] = aCol[i3] * tw;
      trailCol[i6 + 1] = aCol[i3 + 1] * tw;
      trailCol[i6 + 2] = aCol[i3 + 2] * tw;
      trailCol[i6 + 3] = aCol[i3] * tg;
      trailCol[i6 + 4] = aCol[i3 + 1] * tg;
      trailCol[i6 + 5] = aCol[i3 + 2] * tg;

      i++;
    }

    const vis = sparkCount > 0;
    trails.visible = vis;
    heads.visible = vis;
    halos.visible = vis;
    if (vis) {
      trailGeo.setDrawRange(0, sparkCount * 2);
      headGeo.setDrawRange(0, sparkCount);
      trailPosAttr.needsUpdate = true;
      trailColAttr.needsUpdate = true;
      headPosAttr.needsUpdate = true;
      headColAttr.needsUpdate = true;
      headSizeAttr.needsUpdate = true;
    }
  }

  function updateGlows(dt) {
    let i = 0;
    while (i < glowCount) {
      const life = gLife[i] + dt;
      const i3 = i * 3;
      if (life >= gLifeMax[i]) {
        if (gKind[i] === KIND_ROCKET) {
          rocketsInFlight = Math.max(0, rocketsInFlight - 1);
          if (gStyle[i] >= 0) {
            spawnBurstAt(gPos[i3], gPos[i3 + 1], gPos[i3 + 2], gStyle[i], gPal[i], gTier[i], false, gSpeed[i] || 1);
          }
        }
        gLife[i] = life;
        killGlow(i);
        // killGlow may have swapped a live entry into slot i — reprocess it
        continue;
      }
      gLife[i] = life;

      if (gKind[i] === KIND_ROCKET) {
        const k = Math.max(0, 1 - gDrag[i] * dt);
        gVel[i3] *= k;
        gVel[i3 + 1] = gVel[i3 + 1] * k - gGrav[i] * dt;
        gVel[i3 + 2] *= k;
        gPos[i3] += gVel[i3] * dt;
        gPos[i3 + 1] += gVel[i3 + 1] * dt;
        gPos[i3 + 2] += gVel[i3 + 2] * dt;

        // sparkly launch trail
        gEmit[i] += dt * cfg.emitterRate;
        const px = gPos[i3], py = gPos[i3 + 1], pz = gPos[i3 + 2];
        while (gEmit[i] >= 1) {
          gEmit[i] -= 1;
          if (sparkCount >= MAX - 4) break;
          const ic = 2.0 * rand(0.85, 1.15);
          spawnSpark(
            px + rand(-0.25, 0.25), py + rand(-0.25, 0.25), pz + rand(-0.25, 0.25),
            gVel[i3] * 0.12 + rand(-1.4, 1.4),
            gVel[i3 + 1] * 0.10 + rand(-1.2, 0.6),
            gVel[i3 + 2] * 0.12 + rand(-1.4, 1.4),
            1.0 * ic, 0.72 * ic, 0.34 * ic,
            rand(0.35, 0.7), rand(0.16, 0.28),
            rand(1.1, 1.7), rand(3.5, 5.0), rand(0.02, 0.035),
            rand(0.9, 1.15), 0, 0,
          );
        }
      }
      renderGlowSlot(i);
      i++;
    }

    const vis = glowCount > 0;
    glows.visible = vis;
    if (vis) {
      glowGeo.setDrawRange(0, glowCount);
      glowPosAttr.needsUpdate = true;
      glowColAttr.needsUpdate = true;
      glowSizeAttr.needsUpdate = true;
    }
  }

  /* ---------------------------------------------------------------- *
   *  Public API
   * ---------------------------------------------------------------- */
  function setActive(on) {
    const next = !!on;
    if (next === active) return;
    active = next;
    if (active) {
      launchTimer = 0.05;
      finaleTimer = rand(cfg.finaleEvery[0], cfg.finaleEvery[1]);
      pendingLaunches.length = 0;
    } else {
      pendingLaunches.length = 0;
      // cancel in-flight rockets (they disappear without popping)
      for (let i = 0; i < glowCount; i++) {
        if (gKind[i] === KIND_ROCKET) {
          gStyle[i] = -1;
          gLifeMax[i] = Math.min(gLifeMax[i], gLife[i] + 0.18);
        }
      }
      // let existing sparks finish quickly
      for (let i = 0; i < sparkCount; i++) {
        aMaxLife[i] = Math.min(aMaxLife[i], aLife[i] + rand(0.55, 1.05));
      }
    }
  }

  function setOpacity(v) {
    opacity = Math.max(0, Math.min(1, Number(v) || 0));
    headMat.uniforms.uOpacity.value = opacity;
    haloMat.uniforms.uOpacity.value = opacity;
    glowMat.uniforms.uOpacity.value = opacity;
    trailMat.opacity = opacity;
    group.visible = opacity > 0.002;
  }

  function update(dt, _time) {
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, 0.05);

    // fully transparent -> free pass
    if (opacity <= 0.002) {
      stats.drawCalls = 0;
      stats.particles = sparkCount;
      return;
    }

    simTime += dt;

    updateScheduler(dt);
    updateGlows(dt);
    updateSparks(dt);

    pruneBursts();
    updatePointScale();

    // stats
    let draws = 0;
    if (trails.visible) draws++;
    if (heads.visible) draws++;
    if (halos.visible) draws++;
    if (glows.visible) draws++;
    stats.drawCalls = draws;
    stats.particles = sparkCount;
    stats.bursts = liveBursts.length;
    stats.glows = glowCount;
    stats.launches = totalLaunches;
    stats.burstsTotal = totalBursts;
  }

  function burst(worldPos, paletteName) {
    let target;
    if (worldPos) {
      const isArr = Array.isArray(worldPos);
      target = {
        x: isArr ? +worldPos[0] : +worldPos.x,
        y: isArr ? +worldPos[1] : +worldPos.y,
        z: isArr ? +worldPos[2] : +worldPos.z,
        deep: false, speedMul: 1,
      };
    } else {
      const style0 = pickStyle();
      target = pickBurstTarget(style0, 1.15, 0);
      if (!target) target = { x: rand(-40, 40), y: rand(58, 80), z: rand(-95, -40), deep: false, speedMul: 1 };
    }
    let pal = paletteIndexByName(paletteName);
    if (pal < 0) pal = pickPalette();
    const style = pickStyle();
    const ok = spawnBurstAt(
      target.x, target.y, target.z,
      style, pal, target.deep ? 0.72 : 1.25,
      !!target.deep, target.speedMul || 1,
    );
    if (!ok) return null;
    totalLaunches++;
    return { x: target.x, y: target.y, z: target.z, palette: palettes[pal].name, style };
  }

  // initial uniforms / visibility
  setOpacity(1);
  updatePointScale();
  group.visible = true;

  console.info(
    `[fireworks] ready · quality=${cfg.quality} · pool=${MAX} sparks / ${GMAX} glows · ` +
    `${palettes.length} palettes · 4 pooled draw calls`,
  );

  return { group, setActive, setOpacity, update, burst, stats };
}
