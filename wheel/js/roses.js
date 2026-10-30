/**
 * Dream Wheel - procedural rose / garland system  (CONTRACT 3.1)
 *
 * Deterministic procedural roses (seeded), built as layered bent-petal sheets:
 *   - 3 LOD tiers of real garden roses (8-13 petals in 2-3 rings + centre)
 *   - closed buds, pointed curved leaves, leafy foliage clusters, loose petals
 *   - a thick continuous pastel rose garland braided around the wheel rim
 *   - a dense hub rosette covering the hub face (bias +Z, toward camera)
 *   - hanging floral cascades on the lower arc that stay world-down as the wheel spins
 *   - rose garden beds hugging the base plinth in world coordinates
 *
 * Only InstancedMesh layers + a couple of merged meshes: ~18 draw calls total.
 * Shared module-level materials (cloned from the design palette) keep the
 * matte, low-specular rose look: roughness ~0.72, envMapIntensity low.
 *
 * Coordinates: `rotating` is hub-local (rim point = (cos(theta)*R, sin(theta)*R, z));
 * `static` is world space (ground y = 0, plinth top y = BASE_H).
 */
import * as THREE from 'three';
import {
  R, TAU, DEG, MATS, LEAF_COLORS,
  makePRNG, rr, weightedPick,
} from './design.js';

const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const WHITE = new THREE.Color(1, 1, 1);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ------------------------------------------------------------------ *
 *  Rose palette - light, pastel, romantic (Lead-tuned distribution)
 *  dominant cream / blush / pale pink; deep rose and lavender are accents.
 * ------------------------------------------------------------------ */
const ROSE_WEIGHTS = [
  { hex: '#f8e7d2', weight: 20 }, // cream
  { hex: '#f3b7c0', weight: 27 }, // blush (dominant)
  { hex: '#e8839a', weight: 24 }, // pale pink
  { hex: '#f6cdb6', weight: 11 }, // peach
  { hex: '#d9576f', weight: 8 },  // pink
  { hex: '#c9587a', weight: 4 },  // deep rose (accent <= 15 %)
  { hex: '#c3a4d4', weight: 3 },  // sparse lavender
  { hex: '#a87fbe', weight: 2 },  // dusty violet
  { hex: '#b84a66', weight: 1 },  // deep accent
];

/* Matte rose / leaf materials - cloned from the design system so the whole
 * module shares one material per geometry family and stays low-specular. */
const ROSE_MAT = MATS.rose.clone();
ROSE_MAT.roughness = 0.62;
ROSE_MAT.metalness = 0.0;
ROSE_MAT.envMapIntensity = 0.72;
const LEAF_MAT = MATS.leaf.clone();
LEAF_MAT.roughness = 0.72;
LEAF_MAT.metalness = 0.0;
LEAF_MAT.envMapIntensity = 0.40;

/* ================================================================== *
 *  Small geometry utilities
 * ================================================================== */

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qRoll = new THREE.Quaternion();
const _m3 = new THREE.Matrix3();

/** Serialise a set of transformed geometry copies into one indexed BufferGeometry. */
class GeoBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.col = [];
    this.idx = [];
    this.base = 0;
  }
  add(geo, matrix, tint) {
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const col = geo.attributes.color;
    const base = this.base;
    const count = pos.count;
    if (matrix) _m3.getNormalMatrix(matrix);
    for (let i = 0; i < count; i++) {
      _n.fromBufferAttribute(nor, i);
      if (matrix) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
        _n.applyMatrix3(_m3).normalize();
      } else {
        _v.fromBufferAttribute(pos, i);
      }
      this.pos.push(_v.x, _v.y, _v.z);
      this.nor.push(_n.x, _n.y, _n.z);
      if (col) {
        this.col.push(col.getX(i) * tint.r, col.getY(i) * tint.g, col.getZ(i) * tint.b);
      } else {
        this.col.push(tint.r, tint.g, tint.b);
      }
    }
    if (geo.index) {
      const index = geo.index;
      for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    } else {
      for (let i = 0; i < count; i++) this.idx.push(base + i);
    }
    this.base += count;
    return this;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Create one InstancedMesh from a list of {matrix, color} items. */
function createInstancedMesh(geometry, material, items, { castShadow = false, receiveShadow = false } = {}) {
  if (!items || items.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  for (let i = 0; i < items.length; i++) {
    mesh.setMatrixAt(i, items[i].matrix);
    mesh.setColorAt(i, items[i].color);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

const _poseDir = new THREE.Vector3();
/** Compose a pose matrix: +Y of the local geometry points along `dir`. */
function poseMatrix(pos, dir, roll, scaleX, scaleY) {
  _poseDir.copy(dir).normalize();
  _q.setFromUnitVectors(UP, _poseDir);
  _qRoll.setFromAxisAngle(UP, roll);
  _q.multiply(_qRoll);
  return new THREE.Matrix4().compose(pos, _q, new THREE.Vector3(scaleX, scaleY, scaleX));
}

/** Random direction jitter around `dir`. */
function jitterDir(rng, dir, amount) {
  _v.set(rr(rng, -1, 1), rr(rng, -1, 1), rr(rng, -1, 1)).normalize();
  _q.setFromAxisAngle(_v, rr(rng, -amount, amount));
  return dir.clone().applyQuaternion(_q).normalize();
}

function triCountOf(geo) {
  return geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
}

/** A rose colour from the weighted pastel palette, with gentle per-bloom variation. */
function roseColor(rng) {
  const c = new THREE.Color(weightedPick(rng, ROSE_WEIGHTS));
  c.offsetHSL(rr(rng, -0.008, 0.008), rr(rng, -0.03, 0.02), rr(rng, -0.035, 0.025));
  return c;
}

function leafColor(rng) {
  const c = new THREE.Color(LEAF_COLORS[Math.floor(rng() * LEAF_COLORS.length)]);
  c.offsetHSL(rr(rng, -0.012, 0.012), rr(rng, -0.06, 0.05), rr(rng, -0.05, 0.04));
  return c;
}

/* ================================================================== *
 *  ROSE GEOMETRY - layered bent petals, smooth normals, ruffled rims
 * ================================================================== */

/**
 * One petal: a curved quad-strip sheet grown from a base point around the
 * flower axis. The centre line is an arc in the radial/vertical plane
 * (tilt = starting angle from the axis, bend = how much it curls back);
 * the cross-section cups toward the flower centre and can reflex at the tip.
 * Vertex colours bake the depth gradient (deeper pink inner petals -> light rims).
 */
function addPetal(acc, p) {
  const { pos, col, idx } = acc;
  const start = pos.length / 3;
  const segU = p.segU;
  const segV = p.segV;
  const cols = segU + 1;
  const cosPhi = Math.cos(p.phi);
  const sinPhi = Math.sin(p.phi);
  const ds = p.length / segV;

  // centre line (arc integration)
  const rho = new Float32Array(segV + 1);
  const yy = new Float32Array(segV + 1);
  const aa = new Float32Array(segV + 1);
  let cr = p.baseRadius;
  let cy = p.baseHeight;
  rho[0] = cr;
  yy[0] = cy;
  aa[0] = p.tilt;
  for (let j = 1; j <= segV; j++) {
    const aMid = p.tilt + p.bend * ((j - 0.5) / segV);
    cr += ds * Math.sin(aMid);
    cy += ds * Math.cos(aMid);
    rho[j] = cr;
    yy[j] = cy;
    aa[j] = p.tilt + p.bend * (j / segV);
  }

  const width = p.width;
  const shade = p.shade;
  const tone = p.tone;
  const cupBase = p.cup * width;
  const reflex = p.reflex;
  const twist = p.twist || 0;

  for (let j = 0; j <= segV; j++) {
    const t = j / segV;
    // Broad, rounded petal outline: wide across most of the length, blunt tip.
    const shape = Math.pow(Math.sin(Math.PI * Math.min(0.995, 0.02 + 0.98 * t)), 0.38);
    const halfW = 0.5 * width * shape;
    const cupAmt = cupBase * (1 - reflex * t * t);
    const ca = Math.cos(aa[j]);
    const sa = Math.sin(aa[j]);
    const cux = -cosPhi * ca;
    const cuy = sa;
    const cuz = -sinPhi * ca;
    const tx = -sinPhi;
    const tz = cosPhi;
    const tw = twist * t * (1 - t) * 2 * width;
    const along = (0.80 + 0.20 * t) * tone;
    const depth = 0.88 + 0.12 * Math.pow(t, 0.6);
    const rowNoise = 1 + Math.sin(j * 1.7 + p.phi * 3.1) * 0.015;
    for (let i = 0; i <= segU; i++) {
      const u = (i / segU) * 2 - 1;
      const uu = u * u;
      const lat = u * halfW;
      // gentle ruffle along the rim + curled edge tips (soft, not papery)
      const ruffle = Math.sin(u * 3.0 + t * 2.1 + p.phi * 1.9) * 0.006 * t * t;
      const edgeCurl = 0.035 * width * uu * uu * t * t;
      const lift = cupAmt * uu + ruffle + edgeCurl;
      const fold = 0.11 * halfW * Math.sin(u * Math.PI) * (0.15 + 0.85 * t) + tw * u;
      const px = cosPhi * rho[j] + cux * lift + tx * lat + ca * fold * 0.35;
      const py = yy[j] + cuy * lift;
      const pz = sinPhi * rho[j] + cuz * lift + tz * lat - sa * fold * 0.35;
      pos.push(px, py, pz);

      let v = shade * along * depth * (1 + 0.05 * uu) * rowNoise;
      v = clamp(v, 0.55, 1.06);
      col.push(Math.min(1.08, v * 1.01), Math.min(1.08, v * 0.995), Math.min(1.08, v * 0.975));
    }
  }

  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = start + j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
}

/** Small dark centre: a tight swirl dome hidden between the inner petals. */
function addRoseCore(acc, spec) {
  const { pos, col, idx } = acc;
  const seg = spec.coreSeg;
  const apex = spec.coreApex;
  const rows = [
    { y: spec.coreHeight - 0.05, r: 0.052 },
    { y: spec.coreHeight - 0.11, r: 0.088 },
  ];
  const ringStart = [];
  for (const row of rows) {
    ringStart.push(pos.length / 3);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * TAU;
      pos.push(Math.cos(a) * row.r, row.y, Math.sin(a) * row.r);
      const v = 0.44 + (row.y - rows[0].y) * 0.8;
      col.push(clamp(v, 0.3, 0.62) * 1.02, clamp(v, 0.3, 0.62) * 0.9, clamp(v, 0.3, 0.62) * 0.9);
    }
  }
  const apexIdx = pos.length / 3;
  pos.push(0, apex, 0);
  col.push(0.52, 0.40, 0.40);
  for (let i = 0; i < seg; i++) {
    const i2 = (i + 1) % seg;
    idx.push(apexIdx, ringStart[0] + i, ringStart[0] + i2);
    idx.push(ringStart[0] + i, ringStart[1] + i, ringStart[0] + i2, ringStart[0] + i2, ringStart[1] + i, ringStart[1] + i2);
  }
}

/** Ring definitions per LOD tier: 8-13 petals over 2-3 rings. */
const ROSE_TIERS = {
  // 13 petals, 3 rings + centre - close-up hero geometry (hub rosette)
  hero: {
    coreSeg: 8,
    coreApex: 0.395,
    coreHeight: 0.240,
    rings: [
      { count: 5, az: 0.00, segU: 5, segV: 7, baseRadius: 0.075, baseHeight: 0.055, tilt: 1.08, bend: 1.10, length: 0.40, width: 0.66, cup: 1.15, reflex: 0.25, shade: 1.00, twist: 0.10 },
      { count: 4, az: 0.62, segU: 4, segV: 5, baseRadius: 0.055, baseHeight: 0.105, tilt: 0.62, bend: 0.85, length: 0.29, width: 0.51, cup: 1.35, reflex: 0.15, shade: 0.90, twist: 0.08 },
      { count: 4, az: 1.25, segU: 3, segV: 4, baseRadius: 0.030, baseHeight: 0.155, tilt: 0.28, bend: 0.72, length: 0.22, width: 0.36, cup: 2.00, reflex: 0.00, shade: 0.82, twist: 0.15 },
    ],
  },
  // 9 petals, 2 rings + centre - the visible garland / cascade blooms
  mid: {
    coreSeg: 6,
    coreApex: 0.375,
    coreHeight: 0.225,
    rings: [
      { count: 5, az: 0.00, segU: 4, segV: 4, baseRadius: 0.065, baseHeight: 0.050, tilt: 1.05, bend: 1.02, length: 0.37, width: 0.62, cup: 1.20, reflex: 0.18, shade: 0.99, twist: 0.08 },
      { count: 4, az: 0.62, segU: 3, segV: 3, baseRadius: 0.030, baseHeight: 0.135, tilt: 0.34, bend: 0.82, length: 0.24, width: 0.38, cup: 1.85, reflex: 0.00, shade: 0.84, twist: 0.12 },
    ],
  },
  // 8 petals, 2 rings + centre - distant garland / garden mass
  low: {
    coreSeg: 5,
    coreApex: 0.365,
    coreHeight: 0.215,
    rings: [
      { count: 5, az: 0.00, segU: 3, segV: 3, baseRadius: 0.065, baseHeight: 0.050, tilt: 1.05, bend: 1.02, length: 0.36, width: 0.61, cup: 1.20, reflex: 0.16, shade: 0.98, twist: 0.05 },
      { count: 3, az: 0.62, segU: 3, segV: 3, baseRadius: 0.030, baseHeight: 0.135, tilt: 0.36, bend: 0.85, length: 0.22, width: 0.36, cup: 1.75, reflex: 0.00, shade: 0.85, twist: 0.10 },
    ],
  },
};

function buildRoseGeometry(tier, seed) {
  const rng = makePRNG(seed >>> 0);
  const acc = { pos: [], col: [], idx: [] };
  for (const ring of tier.rings) {
    for (let k = 0; k < ring.count; k++) {
      addPetal(acc, {
        phi: ring.az + (k / ring.count) * TAU + rr(rng, -0.06, 0.06),
        segU: ring.segU,
        segV: ring.segV,
        baseRadius: ring.baseRadius * rr(rng, 0.9, 1.12),
        baseHeight: ring.baseHeight + rr(rng, -0.010, 0.010),
        tilt: ring.tilt + rr(rng, -0.06, 0.06),
        bend: ring.bend * rr(rng, 0.90, 1.08),
        length: ring.length * rr(rng, 0.92, 1.08),
        width: ring.width * rr(rng, 0.92, 1.06),
        cup: ring.cup * rr(rng, 0.88, 1.12),
        reflex: ring.reflex,
        shade: ring.shade,
        twist: ring.twist,
        tone: rr(rng, 0.96, 1.04),
      });
    }
  }
  addRoseCore(acc, tier);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(acc.col, 3));
  geo.setIndex(acc.idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ================================================================== *
 *  LEAF / FOLIAGE / BUD / PETAL-PARTICLE GEOMETRY
 * ================================================================== */

/** Pointed, curved, vertex-coloured leaf blade grown along +Y. */
function buildLeafGeometry({ segU = 2, segV = 3, length = 0.5, width = 0.17, curve = 0.55, fold = 0.34 } = {}, seed = 1) {
  const rng = makePRNG(seed >>> 0);
  const pos = [];
  const col = [];
  const idx = [];
  const cols = segU + 1;
  const tilt = rr(rng, -0.08, 0.08);
  for (let j = 0; j <= segV; j++) {
    const t = j / segV;
    const shape = Math.pow(Math.sin(Math.PI * clamp(0.07 + 0.91 * t, 0, 1)), 0.72);
    const halfW = 0.5 * width * shape;
    const y = length * t;
    const z = curve * length * t * t + fold * width * (0.4 + 0.6 * t);
    const shade = (0.74 + 0.26 * Math.sin(Math.PI * Math.min(1, t * 0.84)) + 0.05)
      * (0.88 + 0.12 * Math.min(1, t * 3.2));
    for (let i = 0; i <= segU; i++) {
      const u = (i / segU) * 2 - 1;
      pos.push(
        u * halfW + tilt * t * t * width,
        y,
        z * (1 - 0.55 * u * u) + fold * width * 0.5 * Math.abs(u) * (0.5 + 0.5 * t)
      );
      const v = shade * (1 + 0.06 * u * u);
      col.push(clamp(v * 1.03, 0, 1.12), clamp(v * 1.01, 0, 1.12), clamp(v * 0.92, 0, 1.12));
    }
  }
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** A leafy clump: several small leaves radiating from a point. */
function buildFoliageClusterGeometry(seed, leafGeo, leafCount = 4) {
  const rng = makePRNG(seed >>> 0);
  const gb = new GeoBuilder();
  const rollQ = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  for (let i = 0; i < leafCount; i++) {
    const az = (i / leafCount) * TAU + rr(rng, -0.4, 0.4);
    const tilt = rr(rng, 0.5, 1.25);
    const dir = new THREE.Vector3(
      Math.cos(az) * Math.sin(tilt),
      Math.cos(tilt),
      Math.sin(az) * Math.sin(tilt)
    ).normalize();
    q.setFromUnitVectors(UP, dir);
    rollQ.setFromAxisAngle(UP, rr(rng, 0, TAU));
    q.multiply(rollQ);
    const s = rr(rng, 0.55, 0.95);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(rr(rng, -0.03, 0.03), rr(rng, -0.03, 0.03), rr(rng, -0.03, 0.03)),
      q.clone(),
      new THREE.Vector3(s, s * rr(rng, 0.9, 1.2), s)
    );
    gb.add(leafGeo, m, WHITE);
  }
  return gb.build();
}

/** Closed rose bud (lathe-like teardrop), per-instance coloured. */
function buildBudGeometry(seed) {
  const rng = makePRNG(seed >>> 0);
  const seg = 6;
  const profile = [
    [0.012, 0.0],
    [0.085, 0.055],
    [0.105, 0.14],
    [0.075, 0.225],
    [0.0, 0.29],
  ];
  const pos = [];
  const col = [];
  const idx = [];
  const rows = [];
  for (let k = 0; k < profile.length; k++) {
    const r0 = profile[k][0];
    const y = profile[k][1];
    const r = r0 * (1 + rr(rng, -0.06, 0.06));
    if (r < 0.005) {
      rows.push([pos.length / 3]);
      pos.push(0, y, 0);
      col.push(0.98, 0.96, 0.93);
      continue;
    }
    const startRow = pos.length / 3;
    const ids = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * TAU + k * 0.35;
      const wob = 1 + 0.10 * Math.sin(a * 2.0 + k);
      pos.push(Math.cos(a) * r * wob, y + rr(rng, -0.004, 0.004), Math.sin(a) * r * wob);
      const shade = 0.68 + 0.32 * (y / 0.29);
      col.push(clamp(shade * 1.01, 0, 1.1), clamp(shade * 0.99, 0, 1.1), clamp(shade * 0.96, 0, 1.1));
      ids.push(startRow + i);
    }
    rows.push(ids);
  }
  for (let k = 0; k < rows.length - 1; k++) {
    const A = rows[k];
    const B = rows[k + 1];
    if (A.length === 1 && B.length === 1) continue;
    if (A.length === 1) {
      for (let i = 0; i < seg; i++) idx.push(A[0], B[(i + 1) % seg], B[i]);
    } else if (B.length === 1) {
      for (let i = 0; i < seg; i++) idx.push(A[i], A[(i + 1) % seg], B[0]);
    } else {
      for (let i = 0; i < seg; i++) {
        const i2 = (i + 1) % seg;
        idx.push(A[i], B[i], A[i2], A[i2], B[i], B[i2]);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** A single loose petal lying on the ground. */
function buildPetalParticleGeometry(seed) {
  const rng = makePRNG(seed >>> 0);
  const pos = [];
  const col = [];
  const idx = [];
  const segU = 3;
  const segV = 3;
  const cols = segU + 1;
  for (let j = 0; j <= segV; j++) {
    const t = j / segV;
    const shape = Math.pow(Math.sin(Math.PI * clamp(0.06 + 0.92 * t, 0, 1)), 0.6);
    const halfW = 0.16 * shape;
    for (let i = 0; i <= segU; i++) {
      const u = (i / segU) * 2 - 1;
      const cup = 0.10 * u * u * (0.4 + 0.6 * t);
      pos.push(u * halfW, 0.012 * Math.sin(u * 2.5 + t * 2.0) + 0.010 * t + rr(rng, -0.002, 0.002), 0.26 * t - cup);
      const v = 0.80 + 0.24 * t + 0.05 * u * u;
      col.push(clamp(v, 0, 1.08), clamp(v * 0.99, 0, 1.08), clamp(v * 0.965, 0, 1.08));
    }
  }
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ================================================================== *
 *  SUBSTRATE (thin hidden vine cord + compact dark rosette cushion)
 *  Deliberately small and dark: it must never read as a green pipe.
 * ================================================================== */

const VINE_DARK = new THREE.Color('#2b3524');
const VINE_MID = new THREE.Color('#3d4a30');
const STEM_BROWN = new THREE.Color('#4a3b29');
const SOIL_DARK = new THREE.Color('#3a2e23');
const SOIL_MID = new THREE.Color('#4f3f2e');
const SOIL_LIGHT = new THREE.Color('#67533f');

function buildSubstrateGeometry(seed) {
  const rng = makePRNG(seed >>> 0);
  const segsAround = 200;
  const segsCross = 6;
  const pos = [];
  const col = [];
  const idx = [];
  const tmp = new THREE.Color();
  const lumpA = rr(rng, 0, TAU);
  const lumpB = rr(rng, 0, TAU);
  for (let i = 0; i < segsAround; i++) {
    const theta = (i / segsAround) * TAU;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const lump = 1 + 0.18 * Math.sin(3 * theta + lumpA) + 0.10 * Math.sin(7 * theta + lumpB);
    const hr = 0.24 * lump;          // slim: stays inside the flowers
    const hz = 0.38 * (1 + 0.12 * Math.sin(5 * theta + lumpB));
    for (let k = 0; k < segsCross; k++) {
      const p = (k / segsCross) * TAU;
      const cp = Math.cos(p);
      const sp = Math.sin(p);
      const noise = 0.04 * Math.sin(17 * theta + 5 * p) + 0.03 * Math.sin(11 * theta - 7 * p + 1.7);
      const rad = R + hr * cp + noise;
      const zz = hz * sp + noise * 0.6;
      pos.push(rad * ct, rad * st, zz);
      const n = 0.5 + 0.5 * Math.sin(theta * 9.0 + p * 3.0 + lumpA);
      tmp.copy(VINE_DARK).lerp(VINE_MID, n * 0.8);
      if (n > 0.88) tmp.lerp(STEM_BROWN, 0.45);
      col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  for (let i = 0; i < segsAround; i++) {
    const i2 = (i + 1) % segsAround;
    for (let k = 0; k < segsCross; k++) {
      const k2 = (k + 1) % segsCross;
      const a = i * segsCross + k;
      const b = i2 * segsCross + k;
      const c = i * segsCross + k2;
      const d = i2 * segsCross + k2;
      idx.push(a, b, c, b, d, c);
    }
  }
  const vine = new THREE.BufferGeometry();
  vine.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  vine.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  vine.setIndex(idx);
  vine.computeVertexNormals();

  const gb = new GeoBuilder();
  gb.add(vine, null, WHITE);
  vine.dispose();

  // compact dark foliage cushion behind the hub bouquet (flat disc in XY,
  // fully hidden by the blooms, so it cannot poke out as a green strip).
  const cushion = new THREE.SphereGeometry(1, 18, 8);
  const cp = cushion.attributes.position;
  const ccol = [];
  for (let i = 0; i < cp.count; i++) {
    const n = 0.5 + 0.5 * Math.sin(cp.getX(i) * 7.1 + cp.getZ(i) * 5.3 + i * 0.7);
    tmp.copy(VINE_DARK).lerp(STEM_BROWN, n * 0.55);
    ccol.push(tmp.r, tmp.g, tmp.b);
  }
  cushion.setAttribute('color', new THREE.Float32BufferAttribute(ccol, 3));
  cushion.computeVertexNormals();
  const cm = new THREE.Matrix4().compose(
    new THREE.Vector3(0, 0, 1.00),
    new THREE.Quaternion(),
    new THREE.Vector3(1.95, 1.95, 0.40)
  );
  gb.add(cushion, cm, WHITE);
  cushion.dispose();
  return gb.build();
}

function buildGardenSoilGeometry(seed, clumps) {
  const rng = makePRNG(seed >>> 0);
  const sphere = new THREE.SphereGeometry(1, 8, 3);
  const sp = sphere.attributes.position;
  const scol = [];
  for (let i = 0; i < sp.count; i++) {
    const y = sp.getY(i);
    const n = 0.5 + 0.5 * Math.sin(sp.getX(i) * 8.1 + sp.getZ(i) * 6.7 + i * 0.7);
    const v = clamp(0.55 + 0.30 * (y * 0.5 + 0.5) + 0.16 * n, 0.28, 1.12);
    scol.push(v, v * 0.97, v * 0.93);
  }
  sphere.setAttribute('color', new THREE.Float32BufferAttribute(scol, 3));
  sphere.computeVertexNormals();

  const gb = new GeoBuilder();
  const tint = new THREE.Color();
  for (const c of clumps) {
    const rx = c.radius * rr(rng, 1.0, 1.6);
    const rz = c.radius * rr(rng, 0.75, 1.2);
    const ry = rr(rng, 0.14, 0.24);
    tint.copy(SOIL_MID).lerp(rng() < 0.5 ? SOIL_DARK : SOIL_LIGHT, rr(rng, 0.2, 0.8));
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(c.x + rr(rng, -0.2, 0.2), 0.05, c.z + rr(rng, -0.2, 0.2)),
      new THREE.Quaternion().setFromAxisAngle(UP, rr(rng, 0, TAU)),
      new THREE.Vector3(rx, ry, rz)
    );
    gb.add(sphere, m, tint);
  }
  // continuous low berm along the front border
  for (let x = -20; x <= 20; x += 2.2) {
    tint.copy(SOIL_MID).lerp(SOIL_DARK, 0.35);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x + rr(rng, -0.3, 0.3), 0.04, 3.45 + rr(rng, -0.25, 0.25)),
      new THREE.Quaternion(),
      new THREE.Vector3(rr(rng, 1.3, 2.0), rr(rng, 0.16, 0.22), rr(rng, 1.1, 1.6))
    );
    gb.add(sphere, m, tint);
  }
  sphere.dispose();
  return gb.build();
}

/* ================================================================== *
 *  PLACEMENT GENERATORS
 * ================================================================== */

/**
 * Continuous garland hugging the rim. Crown-heavy density. Blooms are layered
 * in a narrow band (centre r ~= 19.6, radial +-0.6, axial +-0.6) so both rim
 * planes (z = +-0.62) are buried while the white wheel steel still reads
 * between the flowers, and cabin clearance is preserved.
 */
function generateWreath(rng, count) {
  const items = [];
  let guard = 0;
  while (items.length < count && guard++ < count * 26) {
    const theta = rng() * TAU;
    const crown = 0.5 + 0.5 * Math.sin(theta); // 0 bottom, 1 crown
    // even, lush coverage all the way around: the wreath must bloom on the lower arc too
    const density = 0.90 + 0.22 * Math.pow(crown, 1.2);
    if (rng() > density / 1.12) continue;
    const radial = new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0);
    const k = rng();
    let rad;
    let z;
    let dir;
    if (k < 0.52) {
      // face toward the camera (+Z) - the visible mass
      rad = R + rr(rng, -0.50, 0.28);
      z = rr(rng, 0.24, 0.52);
      dir = radial.clone().multiplyScalar(rr(rng, -0.30, 0.42)).addScaledVector(Z_AXIS, rr(rng, 0.9, 1.2)).normalize();
    } else if (k < 0.74) {
      // outer edge, hugging the rim
      rad = R + rr(rng, 0.02, 0.46);
      z = rr(rng, -0.52, 0.52);
      dir = radial.clone().multiplyScalar(rr(rng, 0.85, 1.15)).addScaledVector(Z_AXIS, rr(rng, -0.1, 0.75)).normalize();
    } else if (k < 0.92) {
      // second layer between the vine and the camera face
      rad = R + rr(rng, -0.46, 0.24);
      z = rr(rng, -0.28, 0.30);
      dir = radial.clone().multiplyScalar(rr(rng, -0.25, 0.45)).addScaledVector(Z_AXIS, rr(rng, 0.6, 1.0)).normalize();
    } else {
      // back fill (seen when orbiting) - never protrudes inward toward cabins
      rad = R + rr(rng, -0.42, 0.40);
      z = rr(rng, -0.80, -0.34);
      dir = radial.clone().multiplyScalar(rr(rng, -0.2, 0.35)).addScaledVector(Z_AXIS, -1).normalize();
    }
    dir = jitterDir(rng, dir, 0.40);
    const baseScale = rr(rng, 1.00, 1.30) * (1.0 + 0.06 * crown) * (rng() < 0.08 ? 1.18 : 1.0);
    // occasional bouquet lump: 2-3 tightly grouped blossoms of one colour family
    const lumpCount = rng() < 0.13 ? 2 + Math.floor(rng() * 2) : 1;
    for (let j = 0; j < lumpCount && items.length < count; j++) {
      let px = rad;
      let pz = z;
      if (j > 0) {
        px += rr(rng, -0.34, 0.34);
        pz += rr(rng, -0.26, 0.26);
      }
      const pos = radial.clone().multiplyScalar(px)
        .addScaledVector(Z_AXIS, pz)
        .addScaledVector(dir, -0.08);
      items.push({
        theta: theta + (j > 0 ? rr(rng, -0.01, 0.01) : 0),
        pos,
        dir: j > 0 ? jitterDir(rng, dir, 0.25) : dir,
        scale: baseScale * (j > 0 ? rr(rng, 0.85, 1.05) : 1),
        sy: rr(rng, 0.86, 1.12),
        roll: rr(rng, 0, TAU),
      });
    }
  }
  return items;
}

/** Foliage / leaf blades / buds filling the garland volume (kept inside the band). */
function generateGarlandGreen(rng, foliageCount, bladeCount, budCount, foliageItems, bladeItems, budItems) {
  for (let i = 0; i < foliageCount; i++) {
    const theta = rng() * TAU;
    const crown = 0.5 + 0.5 * Math.sin(theta);
    const radial = new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0);
    const tangent = new THREE.Vector3(-Math.sin(theta), Math.cos(theta), 0);
    const rad = R + rr(rng, -0.72, 0.62);
    const z = rr(rng, -0.72, 0.68);
    const dir = radial.clone().multiplyScalar(rr(rng, 0.1, 0.75))
      .addScaledVector(Z_AXIS, rr(rng, -0.25, 0.85))
      .addScaledVector(tangent, rr(rng, -0.45, 0.45))
      .addScaledVector(UP, rr(rng, -0.25, 0.15))
      .normalize();
    const pos = radial.clone().multiplyScalar(rad).addScaledVector(Z_AXIS, z);
    const s = rr(rng, 0.55, 0.95) * (0.95 + 0.15 * crown);
    foliageItems.push({
      matrix: poseMatrix(pos, jitterDir(rng, dir, 0.85), rr(rng, 0, TAU), s, s * rr(rng, 0.85, 1.15)),
      color: leafColor(rng),
    });
  }
  for (let i = 0; i < bladeCount; i++) {
    const theta = rng() * TAU;
    const radial = new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0);
    const tangent = new THREE.Vector3(-Math.sin(theta), Math.cos(theta), 0);
    const rad = R + rr(rng, -0.70, 0.55);
    const z = rr(rng, -0.65, 0.65);
    // short leaves lying along the garland, never spiking out of the silhouette
    const dir = tangent.clone().multiplyScalar(rng() < 0.5 ? -1 : 1)
      .addScaledVector(radial, rr(rng, -0.15, 0.40))
      .addScaledVector(Z_AXIS, rr(rng, -0.35, 0.55))
      .addScaledVector(UP, rr(rng, -0.45, 0.1))
      .normalize();
    const pos = radial.clone().multiplyScalar(rad).addScaledVector(Z_AXIS, z);
    const s = rr(rng, 0.45, 0.78);
    bladeItems.push({
      matrix: poseMatrix(pos, jitterDir(rng, dir, 0.55), rr(rng, 0, TAU), s * rr(rng, 0.8, 1.0), s),
      color: leafColor(rng),
    });
  }
  for (let i = 0; i < budCount; i++) {
    const theta = rng() * TAU;
    const radial = new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0);
    const rad = R + rr(rng, -0.35, 0.55);
    const z = rr(rng, -0.6, 0.65);
    const dir = radial.clone().multiplyScalar(rr(rng, -0.15, 0.7)).addScaledVector(Z_AXIS, rr(rng, 0.45, 1.0)).normalize();
    const pos = radial.clone().multiplyScalar(rad).addScaledVector(Z_AXIS, z).addScaledVector(dir, -0.04);
    const s = rr(rng, 0.6, 0.92);
    budItems.push({
      matrix: poseMatrix(pos, jitterDir(rng, dir, 0.45), rr(rng, 0, TAU), s, s * rr(rng, 1.0, 1.35)),
      color: roseColor(rng),
    });
  }
}

/** Dense bouquet covering the hub face, biased toward +Z (camera). */
function generateRosette(rng, bloomCount, foliageCount, bladeCount, budCount, lists, foliageItems, bladeItems, budItems) {
  const used = { hero: 0, mid: 0 };
  const maxR = 3.15;
  for (let i = 0; i < bloomCount; i++) {
    const rr0 = maxR * Math.sqrt(rng());
    const a = rng() * TAU;
    const radial = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
    // dome: centre sits proud toward the camera so the rosette reads as a bouquet
    const z = 1.22 + 0.80 * (1 - Math.pow(rr0 / maxR, 1.7)) + rr(rng, -0.10, 0.20);
    const pos = radial.clone().multiplyScalar(rr0).addScaledVector(Z_AXIS, z);
    let dir = radial.clone()
      .multiplyScalar(0.08 + 0.55 * (rr0 / maxR))
      .addScaledVector(Z_AXIS, 1)
      .normalize();
    dir = jitterDir(rng, dir, 0.26);
    const scale = rr(rng, 1.06, 1.46);
    const item = {
      matrix: poseMatrix(pos, dir, rr(rng, 0, TAU), scale, scale * rr(rng, 0.9, 1.1)),
      color: roseColor(rng),
    };
    if (rng() < 0.30) { lists.hero.push(item); used.hero++; } else { lists.mid.push(item); used.mid++; }
  }
  for (let i = 0; i < foliageCount; i++) {
    const rr0 = (0.4 + 3.3 * Math.sqrt(rng()));
    const a = rng() * TAU;
    const radial = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
    const pos = radial.clone().multiplyScalar(rr0)
      .addScaledVector(Z_AXIS, 1.0 + 0.55 * (1 - rr0 / 3.8) + rr(rng, -0.12, 0.12));
    const dir = radial.clone().multiplyScalar(0.65).addScaledVector(Z_AXIS, 0.9).normalize();
    const s = rr(rng, 0.55, 0.95);
    foliageItems.push({
      matrix: poseMatrix(pos, jitterDir(rng, dir, 0.8), rr(rng, 0, TAU), s, s * rr(rng, 0.85, 1.1)),
      color: leafColor(rng),
    });
  }
  for (let i = 0; i < bladeCount; i++) {
    const rr0 = 1.6 + 2.4 * rng();
    const a = rng() * TAU;
    const radial = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
    const tangent = new THREE.Vector3(-Math.sin(a), Math.cos(a), 0);
    const pos = radial.clone().multiplyScalar(rr0).addScaledVector(Z_AXIS, 1.2 + rr(rng, 0, 0.5));
    const dir = tangent.clone().multiplyScalar(rng() < 0.5 ? -1 : 1)
      .addScaledVector(radial, rr(rng, 0.1, 0.5))
      .addScaledVector(Z_AXIS, rr(rng, 0.1, 0.6)).normalize();
    const s = rr(rng, 0.55, 0.9);
    bladeItems.push({
      matrix: poseMatrix(pos, jitterDir(rng, dir, 0.5), rr(rng, 0, TAU), s * rr(rng, 0.8, 1.0), s),
      color: leafColor(rng),
    });
  }
  for (let i = 0; i < budCount; i++) {
    const rr0 = maxR * Math.sqrt(rng());
    const a = rng() * TAU;
    const radial = new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
    const pos = radial.clone().multiplyScalar(rr0).addScaledVector(Z_AXIS, 1.7 + rr(rng, -0.1, 0.3));
    const dir = radial.clone().multiplyScalar(0.4).addScaledVector(Z_AXIS, 0.9).normalize();
    const s = rr(rng, 0.7, 1.0);
    budItems.push({
      matrix: poseMatrix(pos, jitterDir(rng, dir, 0.45), rr(rng, 0, TAU), s, s * rr(rng, 1.0, 1.3)),
      color: roseColor(rng),
    });
  }
  return used;
}

/**
 * Hanging floral cascades on the lower arc: rich, root-heavy falling bands of
 * roses. Each is a Group whose geometry lies along local -Y; update() sets
 * rotation.z = -wheelAngle so it keeps hanging world-down while orbiting.
 */
function buildCascades(rng, count, bloomsPer, geos, leafGeo, foliageGeo) {
  const cascades = [];
  const startDeg = 199;
  const endDeg = 261;
  const roseGeo = geos.mid;
  const lowGeo = geos.low;
  for (let i = 0; i < count; i++) {
    const f = count > 1 ? i / (count - 1) : 0.5;
    const theta = (startDeg + (endDeg - startDeg) * f + rr(rng, -2.2, 2.2)) * DEG;
    const radial = new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0);
    const group = new THREE.Group();
    group.rotation.order = 'ZXY';
    group.position.copy(radial).multiplyScalar(R + rr(rng, -0.2, 0.3));
    group.position.z = rr(rng, -0.35, 0.35);

    const length = rr(rng, 3.6, 4.9);
    const p0 = new THREE.Vector3(0, 0, 0);
    const p1 = new THREE.Vector3(rr(rng, -0.5, 0.5), -length * 0.34, rr(rng, -0.35, 0.35));
    const p2 = new THREE.Vector3(rr(rng, -0.8, 0.8), -length * 0.68, rr(rng, -0.5, 0.5));
    const p3 = new THREE.Vector3(rr(rng, -0.5, 0.5), -length, rr(rng, -0.4, 0.4));
    const curve = new THREE.CatmullRomCurve3([p0, p1, p2, p3]);

    const gb = new GeoBuilder();
    const baseColor = roseColor(rng);
    const secondColor = rng() < 0.55 ? baseColor : roseColor(rng);

    // vines (thin, mostly hidden by the blooms)
    for (let v = 0; v < 3; v++) {
      const tube = new THREE.TubeGeometry(curve, 12, v === 0 ? 0.045 : rr(rng, 0.018, 0.03), 3, false);
      gb.add(tube, null, new THREE.Color('#3c4a2f').offsetHSL(0, 0, rr(rng, -0.05, 0.05)));
      tube.dispose();
    }

    // root-heavy bloom distribution: dense falling rose garland, tapering to the tip
    let placed = 0;
    for (let k = 0; k < bloomsPer; k++) {
      const u = k / Math.max(1, bloomsPer - 1);
      const t = 1 - Math.pow(1 - u, 1.75);           // cluster near the root
      if (t > 0.5 && rng() < 0.7 * (t - 0.5) / 0.5) continue; // sparse at the tip
      const stem = curve.getPoint(Math.min(0.985, t));
      const ang = rng() * TAU;
      const spread = (1.05 - 0.88 * t) * (0.45 + 0.55 * rng());  // wide at root -> single at tip
      const pos = stem.clone().add(new THREE.Vector3(Math.cos(ang) * spread, rr(rng, -0.24, 0.16), Math.sin(ang) * spread));
      let dir = new THREE.Vector3(
        Math.cos(ang) * rr(rng, 0.6, 1.0),
        rr(rng, -0.35, 0.35),
        Math.sin(ang) * rr(rng, 0.6, 1.0)
      ).normalize();
      dir = jitterDir(rng, dir, 0.35);
      const scale = rr(rng, 1.12, 1.42) * (1 - 0.50 * t);
      const r = rng();
      const col = r < 0.62 ? baseColor : r < 0.86 ? secondColor : roseColor(rng);
      const tint = new THREE.Color(col).offsetHSL(rr(rng, -0.006, 0.006), rr(rng, -0.03, 0.03), rr(rng, -0.02, 0.04));
      gb.add(rng() < 0.28 ? roseGeo : lowGeo, poseMatrix(pos, dir, rr(rng, 0, TAU), scale, scale * rr(rng, 0.9, 1.1)), tint);
      placed++;
    }

    // short leaves + small foliage clumps (no long weed spikes)
    for (let k = 0; k < 8; k++) {
      const t = rng() * 0.9;
      const stem = curve.getPoint(t);
      const ang = rng() * TAU;
      const off = rr(rng, 0.2, 0.5);
      const pos = stem.clone().add(new THREE.Vector3(Math.cos(ang) * off, rr(rng, -0.25, 0.1), Math.sin(ang) * off));
      const dir = new THREE.Vector3(Math.cos(ang) * rr(rng, 0.5, 0.9), rr(rng, -0.9, -0.25), Math.sin(ang) * rr(rng, 0.5, 0.9)).normalize();
      gb.add(leafGeo, poseMatrix(pos, jitterDir(rng, dir, 0.4), rr(rng, 0, TAU), rr(rng, 0.7, 1.0), rr(rng, 0.9, 1.3)), leafColor(rng));
    }
    for (let k = 0; k < 8; k++) {
      const t = rng() * 0.9;
      const stem = curve.getPoint(t);
      const ang = rng() * TAU;
      const off = rr(rng, 0.25, 0.7);
      const pos = stem.clone().add(new THREE.Vector3(Math.cos(ang) * off, rr(rng, -0.2, 0.15), Math.sin(ang) * off));
      const dir = new THREE.Vector3(Math.cos(ang), rr(rng, -0.7, 0.2), Math.sin(ang)).normalize();
      const s = rr(rng, 0.55, 0.9);
      gb.add(foliageGeo, poseMatrix(pos, jitterDir(rng, dir, 0.6), rr(rng, 0, TAU), s, s), leafColor(rng));
    }

    const mesh = new THREE.Mesh(gb.build(), ROSE_MAT);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    group.add(mesh);
    cascades.push({ group, phase: rr(rng, 0, TAU), amp: rr(rng, 0.012, 0.028), blooms: placed });
  }
  return cascades;
}

/* ================================================================== *
 *  GARDEN (static, world space)
 * ================================================================== */

/**
 * Rose beds spilling around the base plinth footprint (38 x 5.4 centred at
 * origin, top y = 0.55). Front border is the densest; blooms are larger and
 * clustered with foliage so the bed reads as shrubbery, not confetti.
 */
function buildGarden(rng, bloomCount, foliageCount, petalCount, lists, foliageItems, petals, clumps) {
  const mkClump = (x, z, radius, front) => ({
    x, z, radius, front, blooms: 0,
    color: roseColor(rng),
    color2: roseColor(rng),
  });
  const all = [];
  // front border: a continuous bed hugging the plinth front edge
  const frontN = Math.round(bloomCount * 0.68);
  const frontClumps = [];
  const fCount = 44;
  for (let i = 0; i < fCount; i++) {
    const x = -20.4 + (40.8 * i) / (fCount - 1) + rr(rng, -0.35, 0.35);
    const z = rr(rng, 2.75, 4.55);
    frontClumps.push(mkClump(x, z, rr(rng, 1.0, 1.7), true));
  }
  // side beds
  const sideClumps = [];
  const sPerSide = 7;
  for (let i = 0; i < sPerSide * 2; i++) {
    const sgn = i < sPerSide ? -1 : 1;
    const x = sgn * rr(rng, 19.6, 21.6);
    const z = -2.2 + (7.0 * (i % sPerSide)) / (sPerSide - 1) + rr(rng, -0.3, 0.3);
    sideClumps.push(mkClump(x, z, rr(rng, 0.9, 1.4), false));
  }
  // sparse back beds
  const backClumps = [];
  for (let i = 0; i < 7; i++) {
    backClumps.push(mkClump(rr(rng, -16, 16), rr(rng, -5.8, -3.1), rr(rng, 0.8, 1.3), false));
  }
  const perFront = Math.max(6, Math.round(frontN / frontClumps.length));
  const sideShare = Math.max(4, Math.round(bloomCount * 0.20 / sideClumps.length));
  const backShare = Math.max(4, Math.round(bloomCount * 0.10 / backClumps.length));
  for (const c of frontClumps) c.blooms = perFront;
  for (const c of sideClumps) c.blooms = sideShare;
  for (const c of backClumps) c.blooms = backShare;
  all.push(...frontClumps, ...sideClumps, ...backClumps);
  clumps.push(...all);

  for (const c of all) {
    for (let k = 0; k < c.blooms; k++) {
      const a = rng() * TAU;
      const d = c.radius * Math.sqrt(rng());
      const h = 1 - Math.pow(d / c.radius, 2);
      const x = c.x + Math.cos(a) * d;
      const z = c.z + Math.sin(a) * d;
      const y = 0.30 + 0.62 * h + rr(rng, -0.10, 0.12);
      let dir = new THREE.Vector3(
        Math.cos(a) * rr(rng, 0.05, 0.55),
        rr(rng, 0.9, 1.3),
        Math.sin(a) * rr(rng, 0.05, 0.55)
      ).normalize();
      dir = jitterDir(rng, dir, 0.32);
      const scale = rr(rng, 0.98, 1.36) * (0.95 + 0.12 * h);
      const r = rng();
      const col = r < 0.72 ? c.color : r < 0.9 ? c.color2 : roseColor(rng);
      const tint = new THREE.Color(col).offsetHSL(rr(rng, -0.008, 0.008), rr(rng, -0.04, 0.03), rr(rng, -0.02, 0.05));
      lists.low.push({
        matrix: poseMatrix(new THREE.Vector3(x, y, z), dir, rr(rng, 0, TAU), scale, scale * rr(rng, 0.9, 1.12)),
        color: tint,
      });
    }
    // lush foliage under + around the blooms
    const fn = c.front ? 4 : 3;
    for (let k = 0; k < fn; k++) {
      const a = rng() * TAU;
      const d = c.radius * rr(rng, 0.1, 1.18);
      const x = c.x + Math.cos(a) * d;
      const z = c.z + Math.sin(a) * d;
      const y = rr(rng, 0.10, 0.40);
      let dir = new THREE.Vector3(Math.cos(a) * rr(rng, 0.1, 0.65), rr(rng, 0.8, 1.2), Math.sin(a) * rr(rng, 0.1, 0.65)).normalize();
      dir = jitterDir(rng, dir, 0.7);
      const s = rr(rng, 0.65, 1.1);
      foliageItems.push({
        matrix: poseMatrix(new THREE.Vector3(x, y, z), dir, rr(rng, 0, TAU), s, s * rr(rng, 0.85, 1.12)),
        color: leafColor(rng),
      });
    }
  }
  // extra foliage tufts scattered along the front paving
  for (let i = 0; i < Math.round(foliageCount * 0.18); i++) {
    const x = rr(rng, -21, 21);
    const z = rr(rng, 2.6, 5.6);
    const y = rr(rng, 0.08, 0.3);
    const dir = new THREE.Vector3(rr(rng, -0.4, 0.4), 1, rr(rng, -0.4, 0.4)).normalize();
    const s = rr(rng, 0.5, 0.9);
    foliageItems.push({
      matrix: poseMatrix(new THREE.Vector3(x, y, z), jitterDir(rng, dir, 0.6), rr(rng, 0, TAU), s, s),
      color: leafColor(rng),
    });
  }

  // loose petals on the ground / paving
  for (let i = 0; i < petalCount; i++) {
    let x;
    let z;
    if (rng() < 0.75) {
      x = rr(rng, -21, 21);
      z = rr(rng, 2.3, 6.6);
    } else {
      x = rr(rng, -23, 23);
      z = rr(rng, -1.2, 2.4);
    }
    if (Math.abs(x) < 19 && Math.abs(z) < 2.75) z = 2.9 + Math.abs(z) * 0.4;
    const c = new THREE.Color(weightedPick(rng, ROSE_WEIGHTS));
    c.offsetHSL(0, rr(rng, -0.03, 0.03), rr(rng, 0.03, 0.10));
    const s = rr(rng, 0.7, 1.3);
    petals.push({
      matrix: poseMatrix(
        new THREE.Vector3(x, 0.016 + rng() * 0.03, z),
        new THREE.Vector3(rr(rng, -0.16, 0.16), 1, rr(rng, -0.16, 0.16)).normalize(),
        rr(rng, 0, TAU),
        s,
        s
      ),
      color: c,
    });
  }
}

/* ================================================================== *
 *  PUBLIC API
 * ================================================================== */

/**
 * @param {{seed?: number, quality?: 'high'|'low'}} [opts]
 * @returns {{rotating: THREE.Group, static: THREE.Group, update: Function, stats: object}}
 */
export function buildRoses({ seed = 20261030, quality = 'high' } = {}) {
  const rng = makePRNG(seed >>> 0);
  const lowQ = quality === 'low';
  const q = lowQ ? 0.55 : 1.0;

  const counts = {
    wreath: Math.round(1450 * q),
    rosette: Math.round(132 * q),
    cascadeCount: lowQ ? 6 : 8,
    cascadeBlooms: Math.round(42 * q),
    garden: Math.round(1200 * q),
    gardenFoliage: Math.round(300 * q),
    garlandFoliage: Math.round(680 * q),
    garlandBlades: Math.round(190 * q),
    rosetteFoliage: Math.round(85 * q),
    rosetteBlades: Math.round(30 * q),
    buds: Math.round(210 * q),
    groundPetals: Math.round(140 * q),
    fill: Math.round(220 * q),
  };

  /* ---- shared geometry (built once) -------------------------------- */
  const geos = {
    hero: buildRoseGeometry(ROSE_TIERS.hero, (seed ^ 0x11111111) >>> 0),
    mid: buildRoseGeometry(ROSE_TIERS.mid, (seed ^ 0x22222222) >>> 0),
    low: buildRoseGeometry(ROSE_TIERS.low, (seed ^ 0x33333333) >>> 0),
  };
  const leafGeo = buildLeafGeometry({ segU: 2, segV: 3, length: 0.33, width: 0.15, curve: 0.55 }, (seed ^ 0x44444444) >>> 0);
  const clusterLeafGeo = buildLeafGeometry({ segU: 2, segV: 2, length: 0.27, width: 0.14, curve: 0.5 }, (seed ^ 0x55555555) >>> 0);
  const foliageGeo = buildFoliageClusterGeometry((seed ^ 0x66666666) >>> 0, clusterLeafGeo, 4);
  const budGeo = buildBudGeometry((seed ^ 0x77777777) >>> 0);
  const petalGeo = buildPetalParticleGeometry((seed ^ 0x88888888) >>> 0);
  clusterLeafGeo.dispose();

  /* ---- rotating group (hub-local coords) --------------------------- */
  const rotating = new THREE.Group();
  rotating.name = 'roses-rotating';

  const lists = { hero: [], mid: [], low: [] };
  const garlandFoliage = [];
  const garlandBlades = [];
  const garlandBuds = [];

  // 1) garland - sorted by angle so colours clump like real bouquets
  const wreath = generateWreath(rng, counts.wreath);
  wreath.sort((a, b) => a.theta - b.theta);
  let clusterLeft = 0;
  let clusterCol = null;
  for (const item of wreath) {
    if (clusterLeft <= 0) {
      clusterLeft = Math.round(rr(rng, 2, 6));
      clusterCol = roseColor(rng);
    }
    clusterLeft--;
    const r = rng();
    const base = r < 0.8 && clusterCol ? clusterCol : roseColor(rng);
    const col = new THREE.Color(base).offsetHSL(rr(rng, -0.008, 0.008), rr(rng, -0.03, 0.03), rr(rng, -0.02, 0.04));
    const target = item.dir.z > 0.35 ? lists.mid : lists.low;
    if (item.scale > 1.12 && item.dir.z > 0.55 && rng() < 0.55) {
      lists.hero.push({
        matrix: poseMatrix(item.pos, item.dir, item.roll, item.scale, item.scale * item.sy),
        color: col,
      });
      continue;
    }
    target.push({
      matrix: poseMatrix(item.pos, item.dir, item.roll, item.scale, item.scale * item.sy),
      color: col,
    });
  }

  // 1b) extra low-tier density fill so the wreath reads as a continuous mass
  //     (cheap silhouette layer; keeps the blossom count in the 1800-3200 target)
  const fillItems = generateWreath(rng, counts.fill);
  for (const item of fillItems) {
    lists.low.push({
      matrix: poseMatrix(item.pos, item.dir, item.roll, item.scale * 0.92, item.scale * 0.92 * item.sy),
      color: roseColor(rng),
    });
  }

  // 2) garland greenery / buds
  generateGarlandGreen(rng, counts.garlandFoliage, counts.garlandBlades, counts.buds, garlandFoliage, garlandBlades, garlandBuds);

  // 3) hub rosette
  const rosetteUsed = generateRosette(
    rng, counts.rosette, counts.rosetteFoliage, counts.rosetteBlades, Math.round(counts.buds * 0.12),
    lists, garlandFoliage, garlandBlades, garlandBuds
  );

  // 4) rotating meshes
  const heroMesh = createInstancedMesh(geos.hero, ROSE_MAT, lists.hero, { castShadow: true });
  const midMesh = createInstancedMesh(geos.mid, ROSE_MAT, lists.mid, { castShadow: true });
  const lowMesh = createInstancedMesh(geos.low, ROSE_MAT, lists.low, { castShadow: true });
  const foliageMesh = createInstancedMesh(foliageGeo, LEAF_MAT, garlandFoliage, { castShadow: true });
  const bladeMesh = createInstancedMesh(leafGeo, LEAF_MAT, garlandBlades, { castShadow: true });
  const budMesh = createInstancedMesh(budGeo, ROSE_MAT, garlandBuds, { castShadow: true });
  const substrate = new THREE.Mesh(buildSubstrateGeometry((seed ^ 0x99999999) >>> 0), LEAF_MAT);
  substrate.name = 'roses-vine';
  substrate.castShadow = true;
  substrate.receiveShadow = false;

  for (const m of [heroMesh, midMesh, lowMesh, foliageMesh, bladeMesh, budMesh]) {
    if (m) rotating.add(m);
  }
  rotating.add(substrate);

  // 5) cascades (children of rotating, compensated in update())
  const cascades = buildCascades(rng, counts.cascadeCount, counts.cascadeBlooms, geos, leafGeo, foliageGeo);
  for (const c of cascades) rotating.add(c.group);

  /* ---- static garden group (world coords) -------------------------- */
  const staticGroup = new THREE.Group();
  staticGroup.name = 'roses-static';
  const gardenLists = { low: [], mid: [] };
  const gardenFoliage = [];
  const groundPetals = [];
  const clumps = [];
  buildGarden(rng, counts.garden, counts.gardenFoliage, counts.groundPetals, gardenLists, gardenFoliage, groundPetals, clumps);
  const gardenLowMesh = createInstancedMesh(geos.low, ROSE_MAT, gardenLists.low, { castShadow: true });
  const gardenFoliageMesh = createInstancedMesh(foliageGeo, LEAF_MAT, gardenFoliage, { castShadow: true });
  const petalMesh = createInstancedMesh(petalGeo, ROSE_MAT, groundPetals, { castShadow: false, receiveShadow: true });
  const soil = new THREE.Mesh(buildGardenSoilGeometry((seed ^ 0xaaaaaaa) >>> 0, clumps), LEAF_MAT);
  soil.name = 'roses-soil';
  soil.castShadow = false;
  soil.receiveShadow = true;
  for (const m of [gardenLowMesh, gardenFoliageMesh, petalMesh]) {
    if (m) staticGroup.add(m);
  }
  staticGroup.add(soil);

  /* ---- update ------------------------------------------------------ */
  let time = 0;
  const update = (wheelAngle = 0, dt = 0.016) => {
    time += dt;
    for (let i = 0; i < cascades.length; i++) {
      const c = cascades[i];
      c.group.rotation.z = -wheelAngle;
      c.group.rotation.x = Math.sin(time * 0.8 + c.phase) * c.amp;
    }
  };

  /* ---- stats ------------------------------------------------------- */
  let triangles = 0;
  let instancedCount = 0;
  const meshes = [];
  rotating.traverse((o) => { if (o.isMesh) meshes.push(o); });
  staticGroup.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const m of meshes) {
    const t = triCountOf(m.geometry);
    triangles += m.isInstancedMesh ? t * m.count : t;
    if (m.isInstancedMesh) instancedCount += m.count;
  }
  const cascadeBloomTotal = cascades.reduce((s, c) => s + c.blooms, 0);
  const wreathTotal = wreath.length + fillItems.length;
  const rosetteTotal = rosetteUsed.hero + rosetteUsed.mid;
  const gardenBlooms = gardenLists.low.length + gardenLists.mid.length;

  const stats = {
    instances: instancedCount,
    triangles: Math.round(triangles),
    draws: meshes.length,
    blossoms: wreathTotal + rosetteTotal + cascadeBloomTotal,
    wreath: wreathTotal,
    rosette: rosetteTotal,
    cascades: cascades.length,
    cascadeBlooms: cascadeBloomTotal,
    gardenBlooms,
    foliage: garlandFoliage.length + gardenFoliage.length,
    leafBlades: garlandBlades.length,
    buds: garlandBuds.length,
    groundPetals: groundPetals.length,
    tierCounts: { hero: lists.hero.length, mid: lists.mid.length, low: lists.low.length },
    rosesGeo: {
      hero: Math.round(triCountOf(geos.hero)),
      mid: Math.round(triCountOf(geos.mid)),
      low: Math.round(triCountOf(geos.low)),
    },
  };
  console.info(
    `[roses] ${stats.blossoms} blossoms / ${stats.foliage} foliage / ${stats.leafBlades} blades / ` +
    `${stats.buds} buds / ${stats.triangles.toLocaleString()} tris / ${stats.draws} draws` +
    `${lowQ ? ' (low quality)' : ''}`
  );

  return { rotating, static: staticGroup, update, stats, debug: { geos, leafGeo, foliageGeo, budGeo, petalGeo } };
}

export default buildRoses;
