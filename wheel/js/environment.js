/**
 * Dream Wheel — golden-hour environment.
 *
 * Builds: photographic CC0 HDRI sky (rotated + graded offline so the sun azimuth matches
 * design.SUN_DIR), PMREM environment for IBL, key/fill/bounce/kicker lighting rig with a soft
 * shadow map sized to the wheel, a procedurally paved circular plaza, contact darkening,
 * a distant tree-line silhouette, warm horizon fog and a subtle sun glow sprite.
 *
 * Public API (CONTRACT §3.2):
 *   buildEnvironment({ scene, renderer, quality }) ->
 *     { update(dt, time), sunDir: THREE.Vector3, stats, ready: Promise, dispose() }
 *
 * Assets (built by assets/sky-build.mjs from Poly Haven CC0 sources):
 *   assets/sky.hdr      2k  visible background sky
 *   assets/sky-env.hdr  1k  IBL / reflections only (dimmed + warm ground bounce baked in)
 */
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import {
  TAU, R, HUB_Y, SUN_DIR, KICKER_POS, FOG_COLOR, PALETTE,
  makePRNG, rr, canvasTexture, mergeAll, memberCyl,
} from './design.js';

const SKY_URL = new URL('../assets/sky.hdr', import.meta.url).href;
const SKY_ENV_URL = new URL('../assets/sky-env.hdr', import.meta.url).href;
const HDRI_NAME = 'kloofendal_48d_partly_cloudy_puresky (Poly Haven, CC0)';

const PLAZA_RADIUS = 132;
const GRASS_RADIUS = 340;
const TREELINE_RADIUS = 168;
const TREELINE_HEIGHT = 32;
const HEDGE_RADIUS = 124;
const HEDGE_HEIGHT = 8;

/* ================================================================== *
 *  Canvas texture helpers
 * ================================================================== */

/** Tileable 2D value noise (period `period` cells across the canvas). */
function valueNoise(rand, period) {
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  const at = (ix, iy) => g[((iy % period + period) % period) * period + (((ix % period) + period) % period)];
  const sm = (t) => t * t * (3 - 2 * t);
  return (u, v) => {
    const x = u * period, y = v * period;
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = sm(x - ix), fy = sm(y - iy);
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

/** Fine tileable stone-grain map, reused as bump + roughness. */
function makeStoneDetailTexture(quality) {
  const size = 512;
  const rand = makePRNG(0x51a7e);
  const n1 = valueNoise(rand, 12);
  const n2 = valueNoise(rand, 31);
  const n3 = valueNoise(rand, 73);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // rounded stone bumps + fine grit
      let h = 0.55 + 0.30 * n1(u, v) + 0.16 * n2(u, v) + 0.07 * n3(u, v);
      h = Math.min(1, Math.max(0, h));
      const grit = (rand() - 0.5) * 0.06;
      const val = Math.round(255 * Math.min(1, Math.max(0, h + grit)));
      const i = (y * size + x) * 4;
      img.data[i] = val;
      img.data[i + 1] = val;
      img.data[i + 2] = val;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(quality === 'low' ? 34 : 52, quality === 'low' ? 34 : 52);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/**
 * Circular stone plaza: quiet light warm-neutral stone. Very low-contrast concentric courses
 * with barely-visible joints, large soft mottling and fine sand/stone grain. Drawn once at init.
 * Deliberately understated — the wheel and the roses are the subject, the plaza must not compete.
 */
function makePlazaTexture(quality) {
  const size = quality === 'low' ? 1024 : 2048;
  const rand = makePRNG(0xc0ffee);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const cx = size / 2, cy = size / 2;
  const pxPerUnit = size / (2 * PLAZA_RADIUS);

  // base: warm light-grey stone (mid tone — the wheel is the brightest subject)
  ctx.fillStyle = '#c1bdb3';
  ctx.fillRect(0, 0, size, size);

  // large, very soft mottling — tonal life without visible pattern
  for (let i = 0; i < 460; i++) {
    const x = rand() * size, y = rand() * size;
    const rad = rr(rand, size * 0.008, size * 0.075);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const warm = rand() < 0.5;
    const a = rr(rand, 0.016, 0.045);
    g.addColorStop(0, warm ? `rgba(190,180,164,${a})` : `rgba(150,154,156,${a})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }

  // concentric courses: wide, almost invisible tonal breaks between courses
  const ringW = 3.4 * pxPerUnit;
  const ringCount = Math.ceil(PLAZA_RADIUS / 3.4);
  const stoneTones = [
    [191, 186, 177], [187, 182, 173], [195, 190, 181], [184, 179, 170], [189, 184, 175],
  ];
  const sectorCounts = [10, 14, 18, 24, 30, 36, 48, 60];
  for (let i = ringCount - 1; i >= 0; i--) {
    const r0 = i * ringW, r1 = (i + 1) * ringW;
    const sectors = sectorCounts[Math.min(sectorCounts.length - 1, Math.floor(i / 4))];
    const stagger = (i % 2) * (Math.PI / sectors);
    const period = TAU / sectors;
    for (let j = 0; j < sectors; j++) {
      const a0 = stagger + j * period, a1 = a0 + period;
      const tone = stoneTones[Math.floor(rand() * stoneTones.length)];
      const jitter = (rand() - 0.5) * 6;
      ctx.fillStyle = `rgb(${Math.round(tone[0] + jitter)},${Math.round(tone[1] + jitter)},${Math.round(tone[2] + jitter)})`;
      ctx.beginPath();
      ctx.arc(cx, cy, r1, a0, a1, false);
      ctx.arc(cx, cy, r0, a1, a0, true);
      ctx.closePath();
      ctx.fill();
    }
  }

  // joints: quiet but readable stone courses (the plaza is a plaza, not sand)
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(128,122,112,0.11)';
  ctx.lineWidth = Math.max(1.6, size / 1150);
  for (let i = 1; i <= ringCount; i++) {
    const r = i * ringW;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(128,122,112,0.08)';
  for (let i = 0; i < ringCount; i++) {
    const r0 = i * ringW, r1 = (i + 1) * ringW;
    const sectors = sectorCounts[Math.min(sectorCounts.length - 1, Math.floor(i / 4))];
    const stagger = (i % 2) * (Math.PI / sectors);
    const period = TAU / sectors;
    ctx.lineWidth = Math.max(1.0, size / 2000);
    for (let j = 0; j < sectors; j++) {
      const a = stagger + j * period;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r0 + 1), cy + Math.sin(a) * (r0 + 1));
      ctx.lineTo(cx + Math.cos(a) * (r1 - 1), cy + Math.sin(a) * (r1 - 1));
      ctx.stroke();
    }
  }

  // fine sand/stone grain
  for (let i = 0; i < 70000; i++) {
    const x = rand() * size, y = rand() * size;
    const a = rand();
    ctx.fillStyle = a < 0.5
      ? `rgba(120,108,90,${rr(rand, 0.012, 0.045)})`
      : `rgba(255,250,240,${rr(rand, 0.012, 0.05)})`;
    const s = rr(rand, 0.6, 1.8) * (size / 2048);
    ctx.fillRect(x, y, s, s);
  }
  // a few faint hairline cracks / weathering streaks
  ctx.strokeStyle = 'rgba(140,128,110,0.10)';
  for (let i = 0; i < 90; i++) {
    const x = rand() * size, y = rand() * size;
    const len = rr(rand, 6, 40) * (size / 2048);
    const ang = rand() * TAU;
    ctx.lineWidth = rr(rand, 0.5, 1.2);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

/** Soft radial contact-darkening under the plinth. */
function makeContactTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
  g.addColorStop(0, 'rgba(0,0,0,0.62)');
  g.addColorStop(0.35, 'rgba(0,0,0,0.42)');
  g.addColorStop(0.7, 'rgba(0,0,0,0.14)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Distant tree-line silhouette wrapped around a cylinder. Three depth layers of soft tree
 * crowns. Deliberately desaturated + low-contrast + blurred so it reads as a hazy distant
 * skyline washed by atmospheric perspective (fog does most of the work on the real page).
 * Drawn tileable so the ring has no seam.
 */
function makeTreelineTexture(quality) {
  const W = quality === 'low' ? 1024 : 2048;
  const H = 256;
  const rand = makePRNG(0x7ee11e);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  const blob = (x, y, r, color, squash) => {
    for (let k = -1; k <= 1; k++) {
      const px = x + k * W;
      if (px + r < 0 || px - r > W) continue;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(px, y, r, r * squash, 0, 0, TAU);
      ctx.fill();
    }
  };

  // hazy, desaturated sage/olive layers (fog adds the rest) — a park boundary, not hills
  const layers = [
    { color: 'rgba(142,152,148,0.52)', n: 130, baseY: H * 0.55, rMin: 22, rMax: 64, squash: 0.52, blur: 3 },
    { color: 'rgba(116,129,113,0.64)', n: 165, baseY: H * 0.68, rMin: 16, rMax: 48, squash: 0.56, blur: 2 },
    { color: 'rgba(92,106,86,0.80)', n: 185, baseY: H * 0.81, rMin: 12, rMax: 38, squash: 0.6, blur: 1 },
  ];
  if (ctx.filter !== undefined) {
    for (const L of layers) {
      ctx.filter = `blur(${L.blur}px)`;
      for (let i = 0; i < L.n; i++) {
        const x = rand() * W;
        const r = rr(rand, L.rMin, L.rMax);
        const y = L.baseY + rr(rand, -r * 0.4, r * 0.15);
        blob(x, y, r, L.color, L.squash);
      }
      // a few taller, thinner trees for skyline variation
      for (let i = 0; i < 14; i++) {
        const x = rand() * W;
        const h = rr(rand, H * 0.18, H * 0.34);
        ctx.fillStyle = L.color;
        ctx.fillRect(x - 1.5, H - h, 3, h);
        blob(x, H - h, rr(rand, 10, 22), L.color, 1.2);
      }
    }
    ctx.filter = 'none';
  }
  // solid base band so the ring always meets the ground
  ctx.fillStyle = 'rgba(104,114,100,1)';
  ctx.fillRect(0, H - 18, W, 18);
  // a low hedge of dusty-rose blooms along the base (garden feel, very low contrast)
  for (let i = 0; i < 140; i++) {
    const x = rand() * W;
    const y = H - rr(rand, 4, 30);
    const r = rr(rand, 3, 8);
    ctx.fillStyle = `rgba(206,152,152,${rr(rand, 0.18, 0.42)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
  // in-texture haze toward the ground line + over the whole silhouette
  const haze = ctx.createLinearGradient(0, H * 0.35, 0, H);
  haze.addColorStop(0, 'rgba(239,223,206,0)');
  haze.addColorStop(0.7, 'rgba(239,223,206,0.20)');
  haze.addColorStop(1, 'rgba(239,223,206,0.50)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, W, H);
  // atmospheric flattening: warm-grey wash so it reads as a distant park boundary
  ctx.fillStyle = 'rgba(233,219,204,0.20)';
  ctx.fillRect(0, 0, W, H);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Near garden hedge ring: dense clipped-foliage silhouette with sparse dusty-rose blooms,
 * sitting on the plaza edge. Low-contrast and fog-washed so it frames the wheel without
 * competing with it.
 */
function makeHedgeTexture(quality) {
  const W = quality === 'low' ? 1024 : 2048;
  const H = 160;
  const rand = makePRNG(0x4ed9e);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const drawBlob = (x, y, r, color) => {
    for (let k = -1; k <= 1; k++) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(x + k * W, y, r, r * 0.78, 0, 0, TAU);
      ctx.fill();
    }
  };
  // body of the hedge
  const tones = ['rgba(86,102,80,0.82)', 'rgba(99,116,90,0.82)', 'rgba(74,90,70,0.85)', 'rgba(108,124,98,0.8)'];
  for (let i = 0; i < 420; i++) {
    const x = rand() * W;
    const r = rr(rand, 8, 24);
    const y = H - rr(rand, 4, 52) - r * 0.5;
    drawBlob(x, y, r, tones[Math.floor(rand() * tones.length)]);
  }
  // trimmed top edge + solid base
  ctx.fillStyle = 'rgba(84,99,78,0.9)';
  ctx.fillRect(0, H - 46, W, 46);
  ctx.fillStyle = 'rgba(70,84,64,1)';
  ctx.fillRect(0, H - 12, W, 12);
  // foliage highlights
  for (let i = 0; i < 500; i++) {
    const x = rand() * W;
    const y = H - rr(rand, 6, 54);
    ctx.fillStyle = `rgba(150,168,132,${rr(rand, 0.06, 0.2)})`;
    ctx.beginPath();
    ctx.arc(x, y, rr(rand, 1, 3.4), 0, TAU);
    ctx.fill();
  }
  // sparse dusty-rose blooms in the hedge
  for (let i = 0; i < 210; i++) {
    const x = rand() * W;
    const y = H - rr(rand, 8, 50);
    const r = rr(rand, 1.6, 4.2);
    const warm = rand() < 0.5;
    ctx.fillStyle = warm ? `rgba(222,158,158,${rr(rand, 0.3, 0.6)})` : `rgba(238,198,190,${rr(rand, 0.25, 0.55)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
  // atmospheric haze wash
  const haze = ctx.createLinearGradient(0, H * 0.2, 0, H);
  haze.addColorStop(0, 'rgba(239,223,206,0.06)');
  haze.addColorStop(1, 'rgba(239,223,206,0.34)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, W, H);
  // heavy warm-grey wash — distant, hazy, not a saturated hedge stripe
  ctx.fillStyle = 'rgba(233,219,204,0.28)';
  ctx.fillRect(0, 0, W, H);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  tex.anisotropy = 4;
  return tex;
}

/** Additive warm sun glow sprite texture. */
function makeGlowTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,244,222,1)');
  g.addColorStop(0.12, 'rgba(255,231,190,0.72)');
  g.addColorStop(0.32, 'rgba(255,206,150,0.25)');
  g.addColorStop(0.62, 'rgba(255,190,130,0.07)');
  g.addColorStop(1, 'rgba(255,180,120,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Procedural equirect fallback sky (only used if the HDRI cannot be loaded):
 * golden-hour gradient + painterly cumulus + sun glow. Also used for PMREM.
 */
function makeProceduralSkyTexture(quality) {
  const W = quality === 'low' ? 1024 : 2048;
  const H = W / 2;
  const rand = makePRNG(0x5c1e5);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  // vertical gradient: zenith blue -> mid sky -> warm horizon -> warm dim ground
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0.0, '#2a5f9e');
  grad.addColorStop(0.22, '#3f7fc4');
  grad.addColorStop(0.38, '#7fb2de');
  grad.addColorStop(0.455, '#c8dcec');
  grad.addColorStop(0.49, '#f3ddc4');
  grad.addColorStop(0.52, '#e8d2bb');
  grad.addColorStop(0.62, '#bfae9c');
  grad.addColorStop(1.0, '#8d8175');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const sunU = (Math.atan2(SUN_DIR.z, SUN_DIR.x) / TAU + 0.5) * W;
  const sunV = (0.5 - Math.asin(SUN_DIR.y) / Math.PI) * H;

  // sun glow
  const sg = ctx.createRadialGradient(sunU, sunV, 0, sunU, sunV, W * 0.32);
  sg.addColorStop(0, 'rgba(255,246,224,1)');
  sg.addColorStop(0.06, 'rgba(255,231,186,0.9)');
  sg.addColorStop(0.22, 'rgba(255,208,150,0.35)');
  sg.addColorStop(0.55, 'rgba(255,196,140,0.08)');
  sg.addColorStop(1, 'rgba(255,190,130,0)');
  ctx.fillStyle = sg;
  ctx.fillRect(0, 0, W, H);

  // painterly clouds in a band above the horizon
  for (let i = 0; i < 90; i++) {
    const u = rand();
    const el = rr(rand, 2, 34);
    const v = 0.5 - el / 180;
    const x = u * W, y = v * H;
    const scale = rr(rand, 0.5, 1.7) * (W / 2048);
    const puffs = Math.floor(rr(rand, 3, 9));
    for (let p = 0; p < puffs; p++) {
      const px = x + rr(rand, -70, 70) * scale;
      const py = y + rr(rand, -16, 16) * scale;
      const r = rr(rand, 18, 52) * scale;
      const g2 = ctx.createRadialGradient(px, py, 0, px, py, r);
      const bright = rr(rand, 0.55, 1.0);
      g2.addColorStop(0, `rgba(255,${Math.round(226 + 22 * bright)},${Math.round(206 + 30 * bright)},${0.32 * bright})`);
      g2.addColorStop(0.6, `rgba(248,226,214,${0.16 * bright})`);
      g2.addColorStop(1, 'rgba(240,220,210,0)');
      ctx.fillStyle = g2;
      ctx.fillRect(px - r, py - r, r * 2, r * 2);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ================================================================== *
 *  Scene graph helpers
 * ================================================================== */

/** @returns {THREE.DirectionalLight} */
function makeKeyLight(quality) {
  const sun = new THREE.DirectionalLight('#ffdfae', 3.95);
  sun.name = 'env-key-sun';
  sun.position.copy(SUN_DIR).multiplyScalar(170);
  sun.target.position.set(0, 18, 0);
  sun.castShadow = true;
  const high = quality !== 'low';
  sun.shadow.mapSize.set(high ? 4096 : 2048, high ? 4096 : 2048);
  const cam = sun.shadow.camera;
  cam.left = -56; cam.right = 56;
  cam.top = 56; cam.bottom = -56;
  cam.near = 60; cam.far = 340;
  cam.updateProjectionMatrix();
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.035;
  sun.shadow.camera.updateProjectionMatrix();
  return sun;
}

/**
 * Tileable lawn / garden ground beyond the paved plaza: soft sage-olive green with dry-grass
 * patches, very low contrast so it reads as a fog-washed park lawn at golden hour.
 */
function makeGrassTexture(quality) {
  const size = quality === 'low' ? 256 : 512;
  const rand = makePRNG(0x6a55);
  const n1 = valueNoise(rand, 8);
  const n2 = valueNoise(rand, 23);
  const n3 = valueNoise(rand, 61);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const patch = n1(u, v) * 0.6 + n2(u, v) * 0.3 + n3(u, v) * 0.1;
      // dry-gold <-> sage-green mix
      const r = 150 + patch * 46;
      const g = 146 + patch * 40;
      const b = 104 + patch * 26;
      const i = (y * size + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(64, 64);
  tex.anisotropy = 8;
  return tex;
}

/** Ground: paved circular plaza + lawn beyond it + soft contact darkening. */
function makeGround(quality, stats) {
  const group = new THREE.Group();
  group.name = 'env-ground';

  // lawn / park ground
  const grassTex = makeGrassTexture(quality);
  const grassMat = new THREE.MeshStandardMaterial({
    map: grassTex, roughness: 0.98, metalness: 0.0, color: '#ffffff', envMapIntensity: 0.22,
  });
  const lawn = new THREE.Mesh(new THREE.CircleGeometry(GRASS_RADIUS, 96), grassMat);
  lawn.rotation.x = -Math.PI / 2;
  lawn.position.y = 0;
  lawn.receiveShadow = true;
  lawn.name = 'env-lawn';
  group.add(lawn);
  stats.draws += 1;
  stats.triangles += 96;

  // paved plaza around the wheel
  const map = makePlazaTexture(quality);
  const detail = makeStoneDetailTexture(quality);
  const plazaMat = new THREE.MeshStandardMaterial({
    map,
    bumpMap: detail,
    bumpScale: 0.6,
    roughnessMap: detail,
    roughness: 0.96,
    metalness: 0.0,
    color: '#ffffff',
    envMapIntensity: 0.38,
  });
  plazaMat.name = 'env-plaza';
  const plaza = new THREE.Mesh(new THREE.CircleGeometry(PLAZA_RADIUS, 160), plazaMat);
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = 0.02;
  plaza.receiveShadow = true;
  plaza.name = 'env-plaza-mesh';
  group.add(plaza);
  stats.draws += 1;
  stats.triangles += 160;

  // thin stone curb where paving meets lawn
  const curbMat = new THREE.MeshStandardMaterial({ color: '#b8ae9e', roughness: 0.9, metalness: 0.0, envMapIntensity: 0.3 });
  const curb = new THREE.Mesh(new THREE.TorusGeometry(PLAZA_RADIUS + 0.35, 0.28, 6, 160), curbMat);
  curb.rotation.x = -Math.PI / 2;
  curb.position.y = 0.05;
  curb.receiveShadow = true;
  curb.castShadow = true;
  group.add(curb);
  stats.draws += 1;
  stats.triangles += 1920;

  // contact darkening under the wheel base (plinth is ~39.6 x 6.6)
  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(56, 30),
    new THREE.MeshBasicMaterial({
      map: makeContactTexture(), transparent: true, depthWrite: false,
      color: 0x342b23, opacity: 0.82,
    }),
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.set(0, 0.055, 0);
  contact.renderOrder = 1;
  contact.name = 'env-contact-shadow';
  group.add(contact);
  stats.draws += 1;
  stats.triangles += 2;

  const texs = [map, detail, contact.material.map, grassTex];
  return { group, texs };
}

/** Horizon tree line ring. */
function makeTreeline(quality, stats) {
  const mat = new THREE.MeshBasicMaterial({
    map: makeTreelineTexture(quality),
    transparent: true,
    alphaTest: 0.45,
    side: THREE.BackSide,
    fog: true,
    depthWrite: true,
  });
  const geo = new THREE.CylinderGeometry(TREELINE_RADIUS, TREELINE_RADIUS, TREELINE_HEIGHT, 128, 1, true);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = TREELINE_HEIGHT / 2 - 0.4;
  mesh.name = 'env-treeline';
  stats.draws += 1;
  stats.triangles += 256;
  return mesh;
}

/** Near garden hedge ring on the plaza edge. */
function makeNearHedge(quality, stats) {
  const mat = new THREE.MeshBasicMaterial({
    map: makeHedgeTexture(quality),
    transparent: true,
    alphaTest: 0.5,
    side: THREE.BackSide,
    fog: true,
    depthWrite: true,
  });
  const geo = new THREE.CylinderGeometry(HEDGE_RADIUS, HEDGE_RADIUS, HEDGE_HEIGHT, 96, 1, true);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = HEDGE_HEIGHT / 2 - 0.2;
  mesh.name = 'env-near-hedge';
  stats.draws += 1;
  stats.triangles += 192;
  return mesh;
}

/**
 * Park garden band on the lawn: merged clusters of low-poly trees / rounded shrubs with real
 * volume and lighting, so the horizon reads as a park at golden hour instead of a flat strip.
 * One draw call. Everything sits outside the paved plaza (radius > PLAZA_RADIUS).
 */
function makeParkTrees(quality, stats) {
  const rand = makePRNG(0x1ea5);
  const count = quality === 'low' ? 26 : 48;
  const geos = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + rr(rand, -0.04, 0.04);
    const rad = rr(rand, PLAZA_RADIUS + 12, 330);
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    const h = rr(rand, 9, 24);
    const crownR = h * rr(rand, 0.25, 0.36);
    const trunkH = h - crownR * 1.1;
    // trunk (CylinderGeometry is indexed -> convert so all merged parts share attributes)
    const trunk = memberCyl(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, trunkH, z), Math.max(0.25, h * 0.03), 6);
    geos.push(trunk.index ? trunk.toNonIndexed() : trunk);
    // crown: 2-3 overlapping icosahedra
    const lobes = Math.floor(rr(rand, 2, 4));
    for (let l = 0; l < lobes; l++) {
      const g = new THREE.IcosahedronGeometry(crownR * rr(rand, 0.7, 1.05), 1);
      g.translate(
        x + rr(rand, -crownR * 0.55, crownR * 0.55),
        trunkH + crownR * rr(rand, 0.25, 0.95),
        z + rr(rand, -crownR * 0.55, crownR * 0.55),
      );
      geos.push(g);
    }
  }
  const merged = mergeAll(geos);
  const mat = new THREE.MeshStandardMaterial({
    color: '#5c6a50', roughness: 0.95, metalness: 0.0, envMapIntensity: 0.22,
    flatShading: true,
  });
  const mesh = new THREE.Mesh(merged, mat);
  mesh.name = 'env-park-trees';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  stats.draws += 1;
  stats.triangles += Math.floor(merged.attributes.position.count / 3);
  return mesh;
}

/** Subtle additive sun glow billboard in the sun direction. */
function makeSunGlow(stats) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowTexture(),
    color: 0xffe2b6,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    opacity: 0.42,
    fog: false,
  }));
  sprite.scale.setScalar(240);
  sprite.position.copy(SUN_DIR).multiplyScalar(820);
  sprite.name = 'env-sun-glow';
  stats.draws += 1;
  return sprite;
}

/* ================================================================== *
 *  buildEnvironment
 * ================================================================== */
export function buildEnvironment({ scene, renderer, quality = 'high' } = {}) {
  if (!scene || !renderer) throw new Error('buildEnvironment: scene and renderer are required');

  const stats = {
    quality,
    hdri: HDRI_NAME,
    env: false,
    fallback: false,
    lights: 0,
    draws: 0,
    triangles: 0,
    shadows: 0,
  };

  /* renderer settings (owned by the app, enforced here so all entry points agree) */
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.96;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const root = new THREE.Group();
  root.name = 'env-root';
  scene.add(root);

  /* ------------------------------ sky ------------------------------ */
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  let skyTexture = null;
  let envTarget = null;
  let readyResolve;
  const ready = new Promise((res) => { readyResolve = res; });

  function applySky(bgTex, envTex) {
    bgTex.mapping = THREE.EquirectangularReflectionMapping;
    skyTexture = bgTex;
    scene.background = bgTex;
    const source = envTex || bgTex;
    source.mapping = THREE.EquirectangularReflectionMapping;
    envTarget = pmrem.fromEquirectangular(source);
    scene.environment = envTarget.texture;
    stats.env = true;
    pmrem.dispose();
    if (envTex) envTex.dispose();
  }

  (async () => {
    try {
      const loader = new RGBELoader().setDataType(THREE.HalfFloatType);
      const [bg, envTex] = await Promise.all([
        loader.loadAsync(SKY_URL),
        loader.loadAsync(SKY_ENV_URL).catch(() => null),
      ]);
      if (envTex) envTex.mapping = THREE.EquirectangularReflectionMapping;
      applySky(bg, envTex);
      console.info('[env] HDRI sky ready:', HDRI_NAME);
    } catch (err) {
      // procedural fallback — still gives a believable golden-hour sky + IBL
      console.warn('[env] HDRI unavailable (' + (err && err.message ? err.message : err) + ') — procedural sky fallback');
      stats.fallback = true;
      const tex = makeProceduralSkyTexture(quality);
      try {
        scene.environment = pmrem.fromEquirectangular(tex).texture;
        stats.env = true;
        pmrem.dispose();
      } catch (e) { /* IBL optional */ }
      scene.background = tex;
      skyTexture = tex;
    } finally {
      stats.ready = true;
      readyResolve();
    }
  })();

  /* ---------------------------- lighting --------------------------- */
  const key = makeKeyLight(quality);
  root.add(key, key.target);
  stats.lights += 1;
  stats.shadows += 1;

  const hemi = new THREE.HemisphereLight('#a3c9ec', '#d8b896', 0.18);
  hemi.name = 'env-skyfill';
  hemi.position.set(0, 60, 0);
  root.add(hemi);
  stats.lights += 1;

  // warm stone/rose bounce near the base front-left
  const bounce = new THREE.PointLight('#ff9c63', 36, 30, 2);
  bounce.position.set(-4, 4.5, 14);
  bounce.name = 'env-warm-bounce';
  root.add(bounce);
  stats.lights += 1;

  // rose-pink kiss from the garland toward the steel
  const roseBounce = new THREE.PointLight('#ff9fb0', 22, 26, 2);
  roseBounce.position.set(0, HUB_Y + 1, 9);
  roseBounce.name = 'env-rose-bounce';
  root.add(roseBounce);
  stats.lights += 1;

  // cool-pink kicker from behind right for rim separation
  const kicker = new THREE.DirectionalLight('#ffd0dc', 1.0);
  kicker.position.copy(KICKER_POS);
  kicker.target.position.set(0, 20, 0);
  kicker.name = 'env-kicker';
  root.add(kicker, kicker.target);
  stats.lights += 1;

  /* ----------------------------- ground ---------------------------- */
  const ground = makeGround(quality, stats);
  root.add(ground.group);

  /* ---------------------------- horizon ---------------------------- */
  const treeline = makeTreeline(quality, stats);
  root.add(treeline);
  const nearHedge = makeNearHedge(quality, stats);
  root.add(nearHedge);
  const parkTrees = makeParkTrees(quality, stats);
  root.add(parkTrees);

  /* ------------------------------ glow ----------------------------- */
  const glow = makeSunGlow(stats);
  root.add(glow);

  /* ------------------------------- fog ----------------------------- */
  scene.fog = new THREE.Fog(new THREE.Color(FOG_COLOR).multiplyScalar(0.92), 130, 560);

  /* ----------------------------- update ---------------------------- */
  let timeAcc = 0;
  let disposed = false;
  function update(dt = 0, time = 0) {
    if (disposed) return;
    timeAcc += dt;
    // sun glow breathes very slowly; clouds are baked into the HDRI (static, zero cost)
    const breathe = 0.42 + Math.sin(timeAcc * 0.11) * 0.035;
    glow.material.opacity = breathe;
    glow.material.rotation = timeAcc * 0.012;
    glow.scale.setScalar(238 + Math.sin(timeAcc * 0.07) * 6);
  }

  function dispose() {
    disposed = true;
    if (envTarget) envTarget.dispose();
    if (skyTexture) skyTexture.dispose();
    for (const t of ground.texs) t.dispose();
    treeline.material.map.dispose();
    nearHedge.material.map.dispose();
    glow.material.map.dispose();
    root.traverse((o) => {
      if (o.isMesh || o.isSprite) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      }
    });
    scene.remove(root);
    scene.fog = null;
    if (scene.background === skyTexture) scene.background = null;
    if (scene.environment === (envTarget && envTarget.texture)) scene.environment = null;
  }

  return {
    update,
    sunDir: SUN_DIR.clone(),
    stats,
    ready,
    dispose,
    /** @internal handy for QA screenshots */ _root: root,
  };
}
