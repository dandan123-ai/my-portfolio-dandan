/**
 * Dream Wheel — shared design system.
 * All modules import from here so geometry, palette and mood stay coherent.
 * three.js r160 is available via the import map: "three" and "three/addons/".
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/BufferGeometryUtils.js';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ *
 *  World scale
 * ------------------------------------------------------------------ */
export const R = 20;                 // rim outer radius
export const HUB_Y = 26.0;           // axle height above ground (1.30 R)
export const RIM_Z = 0.62;           // wheel rims sit at z = ±RIM_Z
export const TOWER_Z = 2.35;         // A-frame planes at z = ±TOWER_Z
export const CABIN_COUNT = 24;
export const BASE_H = 0.55;          // top of the stone plinth
export const WHEEL_DEPTH = 1.9;      // total structural depth of the wheel disc

/* ------------------------------------------------------------------ *
 *  Camera / light direction (golden-hour key from front-left)
 * ------------------------------------------------------------------ */
export const CAM_HOME = new THREE.Vector3(-27, 9.5, 74);
export const LOOK_HOME = new THREE.Vector3(0, 24.5, 0);
export const SUN_POS = new THREE.Vector3(-44, 26, 24);
export const SUN_DIR = SUN_POS.clone().normalize();
export const KICKER_POS = new THREE.Vector3(34, 16, -58);
export const SKY = {
  zenith: '#3f7fc4',
  mid: '#8fc3ea',
  horizon: '#f6dcc4',
  haze: '#f3ddc8',
};
export const FOG_COLOR = '#efd9c8';

/* ------------------------------------------------------------------ *
 *  Palette
 * ------------------------------------------------------------------ */
export const PALETTE = {
  steel: '#f7f0e6',        // main painted steel
  steelSecondary: '#eadfd0', // secondary hoops, inner faces
  steelShadow: '#d2c1ac',  // junction nodes, recesses
  steelEdge: '#8c7864',    // deep structural shadow
  gold: '#c9a063',         // polished brass
  goldDeep: '#8a6534',
  goldLight: '#e8cd96',
  shell: '#f9ede8',        // cabin hull
  shellTop: '#fdf6f0',     // cabin dome
  glass: '#dcebf4',
  stone: '#e4d8c6',        // plinth
  stoneDark: '#b7a892',
  stoneJoint: '#9c8d79',
  soil: '#5c4c3e',
  petalPink: '#d9576f',
};

// Weighted rose palette — rosy blush/pink forward with cream as light, deep rose as accent.
export const FLOWER_PALETTE = [
  { hex: '#f3b7c0', weight: 26 },
  { hex: '#e8839a', weight: 24 },
  { hex: '#f8e7d2', weight: 14 },
  { hex: '#d9576f', weight: 14 },
  { hex: '#f6cdb6', weight: 8 },
  { hex: '#c9587a', weight: 8 },
  { hex: '#c3a4d4', weight: 3 },
  { hex: '#a87fbe', weight: 2 },
  { hex: '#b84a66', weight: 1 },
];

export const LEAF_COLORS = ['#6f8f58', '#83a066', '#95ad7e', '#a9ba8c', '#bccaa1'];

/* ------------------------------------------------------------------ *
 *  Materials (created once, shared by every module)
 *  scene.environment is assigned later by the environment module.
 * ------------------------------------------------------------------ */
const std = (color, roughness, metalness, extra = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });

export const MATS = {
  steel: std(PALETTE.steel, 0.46, 0.06, { envMapIntensity: 0.9 }),
  steelSecondary: std(PALETTE.steelSecondary, 0.55, 0.04, { envMapIntensity: 0.75 }),
  steelShadow: std(PALETTE.steelShadow, 0.62, 0.05, { envMapIntensity: 0.6 }),
  steelEdge: std(PALETTE.steelEdge, 0.72, 0.04, { envMapIntensity: 0.4 }),
  gold: std(PALETTE.gold, 0.23, 0.94, { envMapIntensity: 1.25 }),
  goldDeep: std(PALETTE.goldDeep, 0.34, 0.9, { envMapIntensity: 0.9 }),
  goldLight: std(PALETTE.goldLight, 0.2, 0.95, { envMapIntensity: 1.35 }),
  stone: std(PALETTE.stone, 0.88, 0.0, { envMapIntensity: 0.35 }),
  stoneDark: std(PALETTE.stoneDark, 0.92, 0.0, { envMapIntensity: 0.25 }),
  shell: new THREE.MeshPhysicalMaterial({
    color: PALETTE.shell, roughness: 0.3, metalness: 0.0,
    clearcoat: 0.7, clearcoatRoughness: 0.22, envMapIntensity: 1.1,
  }),
  shellTop: new THREE.MeshPhysicalMaterial({
    color: PALETTE.shellTop, roughness: 0.26, metalness: 0.0,
    clearcoat: 0.75, clearcoatRoughness: 0.18, envMapIntensity: 1.15,
  }),
  glass: new THREE.MeshPhysicalMaterial({
    color: '#a9c3d2', roughness: 0.06, metalness: 0.0,
    transparent: true, opacity: 0.44, depthWrite: false,
    clearcoat: 1.0, clearcoatRoughness: 0.04, envMapIntensity: 1.85,
    side: THREE.DoubleSide,
  }),
  rose: new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.55, metalness: 0.0,
    side: THREE.DoubleSide, envMapIntensity: 0.55,
  }),
  leaf: new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.68, metalness: 0.0,
    side: THREE.DoubleSide, envMapIntensity: 0.5,
  }),
  petalParticle: new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, depthWrite: false,
    opacity: 0.92, side: THREE.DoubleSide,
  }),
};

/* ------------------------------------------------------------------ *
 *  Deterministic PRNG (screenshots must be reproducible)
 * ------------------------------------------------------------------ */
export function makePRNG(seed = 0x5eed1234) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const rr = (rng, a, b) => a + (b - a) * rng();
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
export function weightedPick(rng, weighted) {
  let total = 0;
  for (const w of weighted) total += w.weight;
  let r = rng() * total;
  for (const w of weighted) { r -= w.weight; if (r <= 0) return w.hex; }
  return weighted[weighted.length - 1].hex;
}

/* ------------------------------------------------------------------ *
 *  Geometry helpers
 * ------------------------------------------------------------------ */
const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);

/** Oriented box member from a to b. */
export function memberBox(a, b, w, h = w) {
  _dir.subVectors(b, a);
  const len = _dir.length();
  const g = new THREE.BoxGeometry(w, len, h);
  g.translate(0, len / 2, 0);
  _q.setFromUnitVectors(UP, _dir.normalize());
  _m.compose(a.clone(), _q, _one);
  g.applyMatrix4(_m);
  return g;
}

/** Oriented cylinder member from a to b. */
export function memberCyl(a, b, radius, seg = 8) {
  _dir.subVectors(b, a);
  const len = _dir.length();
  const g = new THREE.CylinderGeometry(radius, radius, len, seg);
  g.translate(0, len / 2, 0);
  _q.setFromUnitVectors(UP, _dir.normalize());
  _m.compose(a.clone(), _q, _one);
  g.applyMatrix4(_m);
  return g;
}

export function mergeAll(geometries) {
  if (!geometries.length) return new THREE.BufferGeometry();
  const merged = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();
  return merged;
}

/** Lathe from [radius, y] pairs (array of [x, y]). */
export function lathe(points, segments = 40) {
  const pts = points.map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, segments);
}

/** Horizontal ring band (annulus) extruded flat in the XY plane along Z. */
export function ringBand(inner, outer, depth, segments = 200, bevel = 0.0) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, 0, TAU, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, inner, 0, TAU, true);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel,
    bevelSegments: 2, curveSegments: segments, steps: 1,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

/** Simple rounded-slab via ExtrudeGeometry in XZ plane, height along Y. */
export function stoneSlab(width, depth, height, radius = 0.3) {
  const shape = new THREE.Shape();
  const w = width / 2 - radius, d = depth / 2 - radius;
  shape.moveTo(-w - radius, -d);
  shape.lineTo(-w - radius, d);
  shape.quadraticCurveTo(-w - radius, d + radius, -w, d + radius);
  shape.lineTo(w, d + radius);
  shape.quadraticCurveTo(w + radius, d + radius, w + radius, d);
  shape.lineTo(w + radius, -d);
  shape.quadraticCurveTo(w + radius, -d - radius, w, -d - radius);
  shape.lineTo(-w, -d - radius);
  shape.quadraticCurveTo(-w - radius, -d - radius, -w - radius, -d);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 6 });
  // Shape lives in XY, extrusion along +Z. Rotate so the slab lies in XZ with height along +Y.
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Small canvas texture helper. */
export function canvasTexture(w, h, draw, { repeat = null, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(repeat[0], repeat[1]); }
  tex.anisotropy = 4;
  return tex;
}

/** Hex string -> THREE.Color. */
export const color = (hex) => new THREE.Color(hex);

/** Enable cast/receive shadow on a whole subtree. */
export function shadows(root, cast = true, receive = true) {
  root.traverse((o) => {
    if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; }
  });
  return root;
}

/** URL query helper, e.g. getParam('angleDeg', 0). */
export function getParam(name, def = null) {
  const v = new URLSearchParams(location.search).get(name);
  return v === null ? def : v;
}
