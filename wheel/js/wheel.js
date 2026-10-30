/**
 * Dream Wheel 鈥?the Ferris wheel body.
 * Neo-Victorian white steel wheel: dual lattice rims, dense spoke array with tie rings,
 * ornate hub, two box-lattice A-frames, stone plinth and 24 glazed capsule cabins that
 * stay perfectly upright while the wheel turns.
 *
 * Origin of `root` is at ground centre. The wheel spins about Z inside `wheelGroup`,
 * which sits at y = HUB_Y.
 */
import * as THREE from 'three';
import {
  TAU, R, HUB_Y, RIM_Z, TOWER_Z, CABIN_COUNT, BASE_H,
  PALETTE, MATS, makePRNG, rr, memberBox, memberCyl, mergeAll, lathe, stoneSlab, shadows,
} from './design.js';

const UP = new THREE.Vector3(0, 1, 0);

function mergedMesh(geometries, material, name, cast = true, receive = true) {
  const geo = mergeAll(geometries);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

function v3(x, y, z) { return new THREE.Vector3(x, y, z); }

/* ======================================================================
 *  STONE PLINTH + STEPS
 * ====================================================================== */
function buildBase(root, rng) {
  const group = new THREE.Group();
  group.name = 'basePlatform';

  const baseW = 1.98 * R;   // 39.6
  const baseD = 6.6;
  const slab = new THREE.Mesh(stoneSlab(baseW, baseD, BASE_H, 0.55), MATS.stone);
  slab.name = 'baseSlab';
  slab.castShadow = true;
  slab.receiveShadow = true;
  group.add(slab);

  // warm stone border strip + brass piping along the top edge
  const trim = [];
  const hw = baseW / 2 - 0.06, hd = baseD / 2 - 0.06, ty = BASE_H + 0.015;
  trim.push(memberCyl(v3(-hw, ty, hd), v3(hw, ty, hd), 0.045, 8));
  trim.push(memberCyl(v3(-hw, ty, -hd), v3(hw, ty, -hd), 0.045, 8));
  trim.push(memberCyl(v3(hw, ty, -hd), v3(hw, ty, hd), 0.045, 8));
  trim.push(memberCyl(v3(-hw, ty, -hd), v3(-hw, ty, hd), 0.045, 8));
  group.add(mergedMesh(trim, MATS.gold, 'baseTrim', false, false));

  // front steps
  const stepGeo = [];
  for (let i = 0; i < 3; i++) {
    const top = BASE_H - 0.14 - i * 0.13;
    const w = 13.5 + i * 1.6;
    const d = 1.05;
    const g = stoneSlab(w, d, top, 0.12);
    g.translate(0, 0, baseD / 2 + 0.62 + i * 0.88);
    stepGeo.push(g);
  }
  const steps = mergedMesh(stepGeo, MATS.stone, 'baseSteps', true, true);
  group.add(steps);

  // tower pedestals + brass anchor plates
  const pedestals = [];
  const anchors = [];
  const footX = 0.66 * R;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = sx * footX, pz = sz * TOWER_Z;
    const ped = new THREE.BoxGeometry(2.6, 0.26, 2.6);
    ped.translate(px, BASE_H + 0.13, pz);
    pedestals.push(ped);

    const plate = new THREE.CylinderGeometry(0.85, 0.92, 0.10, 24);
    plate.translate(px, BASE_H + 0.31, pz);
    anchors.push(plate);
    const ring = new THREE.TorusGeometry(0.9, 0.05, 6, 28);
    ring.rotateX(Math.PI / 2);
    ring.translate(px, BASE_H + 0.36, pz);
    anchors.push(ring);
  }
  group.add(mergedMesh(pedestals, MATS.stoneDark, 'towerPedestals', true, true));
  group.add(mergedMesh(anchors, MATS.gold, 'towerAnchors', true, false));

  // small brass medallions across the front face of the plinth
  const medallions = [];
  for (let i = -4; i <= 4; i++) {
    const disc = new THREE.CylinderGeometry(0.22, 0.22, 0.07, 18);
    disc.rotateX(Math.PI / 2);
    disc.translate(i * 3.0, BASE_H - 0.16, baseD / 2 + 0.02);
    medallions.push(disc);
  }
  group.add(mergedMesh(medallions, MATS.goldDeep, 'baseMedallions', false, false));

  // warm garden lanterns flanking the entrance
  const stonePosts = [];
  const goldParts = [];
  const lampParts = [];
  const lanternPos = [
    [-8.4, baseD / 2 + 2.35], [8.4, baseD / 2 + 2.35],
    [-15.6, baseD / 2 - 0.1], [15.6, baseD / 2 - 0.1],
  ];
  for (const [px, pz] of lanternPos) {
    const base = new THREE.BoxGeometry(0.72, 0.30, 0.72);
    base.translate(px, 0.15, pz);
    stonePosts.push(base);
    const shaft = new THREE.CylinderGeometry(0.13, 0.17, 1.55, 12);
    shaft.translate(px, 1.05, pz);
    stonePosts.push(shaft);
    const plinth = new THREE.BoxGeometry(0.46, 0.12, 0.46);
    plinth.translate(px, 1.88, pz);
    goldParts.push(plinth);
    const collar = new THREE.TorusGeometry(0.20, 0.032, 6, 18);
    collar.rotateX(Math.PI / 2);
    collar.translate(px, 1.96, pz);
    goldParts.push(collar);
    const cage = new THREE.BoxGeometry(0.34, 0.42, 0.34);
    cage.translate(px, 2.20, pz);
    lampParts.push(cage);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const post = new THREE.BoxGeometry(0.035, 0.42, 0.035);
      post.translate(px + sx * 0.19, 2.20, pz + sz * 0.19);
      goldParts.push(post);
    }
    const roof = new THREE.ConeGeometry(0.34, 0.28, 4);
    roof.rotateY(Math.PI / 4);
    roof.translate(px, 2.55, pz);
    goldParts.push(roof);
    const orb = new THREE.SphereGeometry(0.07, 8, 6);
    orb.translate(px, 2.73, pz);
    goldParts.push(orb);
  }
  group.add(mergedMesh(stonePosts, MATS.stoneDark, 'lanternPosts', true, true));
  group.add(mergedMesh(goldParts, MATS.gold, 'lanternBrass', true, false));
  const lampMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  lampMat.color.setRGB(2.6, 1.75, 0.95);
  group.add(mergedMesh(lampParts, lampMat, 'lanternGlow', false, false));

  root.add(group);
  return group;
}

/* ======================================================================
 *  A-FRAME LATTICE TOWERS
 * ====================================================================== */
function addLatticeLeg(steel, dark, foot, hub) {
  const dir = v3(0, 0, 0).subVectors(hub, foot);
  const len = dir.length();
  const perp = v3(-dir.y, dir.x, 0).normalize();
  const off = 0.24;

  steel.push(memberBox(foot, hub, 0.38, 0.38));
  const a0 = foot.clone().addScaledVector(perp, off);
  const a1 = hub.clone().addScaledVector(perp, off);
  const b0 = foot.clone().addScaledVector(perp, -off);
  const b1 = hub.clone().addScaledVector(perp, -off);
  steel.push(memberBox(a0, a1, 0.13, 0.13));
  steel.push(memberBox(b0, b1, 0.13, 0.13));

  const n = Math.max(9, Math.round(len / 1.55));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const p = new THREE.Vector3().lerpVectors(a0, a1, t);
    const q = new THREE.Vector3().lerpVectors(b0, b1, t);
    dark.push(memberBox(p, q, 0.075, 0.075));
  }
  // small zig-zag lacing on the faces
  for (let i = 0; i < n - 1; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const pa = new THREE.Vector3().lerpVectors(a0, a1, t0);
    const pb = new THREE.Vector3().lerpVectors(b0, b1, t0);
    const pa2 = new THREE.Vector3().lerpVectors(a0, a1, t1);
    steel.push(memberCyl(pa, pb.clone().lerp(a1, 0.5), 0.032, 4));
    steel.push(memberCyl(pb, pa2, 0.032, 4));
  }
}

function buildTowers(root) {
  const steel = [];
  const dark = [];
  const gold = [];
  const footX = 0.66 * R;
  const baseY = BASE_H + 0.36;
  const legFoot = (sx, z) => v3(sx * footX, baseY, z);

  for (const sz of [-1, 1]) {
    const z = sz * TOWER_Z;
    const hubP = v3(0, HUB_Y, z);
    const lf = legFoot(-1, z);
    const rf = legFoot(1, z);

    addLatticeLeg(steel, dark, lf, hubP);
    addLatticeLeg(steel, dark, rf, hubP);

    // X bracing between the two legs of this A-frame
    for (let i = 0; i < 8; i++) {
      const t0 = 0.08 + i * 0.113;
      const t1 = t0 + 0.113;
      const l0 = new THREE.Vector3().lerpVectors(lf, hubP, t0);
      const l1 = new THREE.Vector3().lerpVectors(lf, hubP, t1);
      const r0 = new THREE.Vector3().lerpVectors(rf, hubP, t0);
      const r1 = new THREE.Vector3().lerpVectors(rf, hubP, t1);
      steel.push(memberBox(l0, r1, 0.085, 0.085));
      steel.push(memberBox(r0, l1, 0.085, 0.085));
    }

    // gold medallions on the out-facing sides of the legs
    for (const foot of [lf, rf]) {
      for (const t of [0.28, 0.48, 0.68]) {
        const p = new THREE.Vector3().lerpVectors(foot, hubP, t);
        const cz = z + 0.20;
        const disc = new THREE.CylinderGeometry(0.27, 0.27, 0.07, 22);
        disc.rotateX(Math.PI / 2);
        disc.translate(p.x, p.y, cz);
        gold.push(disc);
        const ring = new THREE.TorusGeometry(0.29, 0.035, 6, 26);
        ring.translate(p.x, p.y, cz + 0.02);
        gold.push(ring);
        const boss = new THREE.SphereGeometry(0.075, 10, 8);
        boss.translate(p.x, p.y, cz + 0.07);
        gold.push(boss);
      }
    }

    // brass shoe at each foot
    for (const foot of [lf, rf]) {
      const shoe = new THREE.BoxGeometry(0.72, 0.16, 0.72);
      shoe.translate(foot.x, baseY + 0.04, z);
      gold.push(shoe);
    }

    // bearing housing at the hub
    const housing = new THREE.CylinderGeometry(0.92, 0.92, 0.58, 32);
    housing.rotateX(Math.PI / 2);
    housing.translate(0, HUB_Y, z);
    steel.push(housing);
    for (const s of [-1, 1]) {
      const collar = new THREE.TorusGeometry(0.94, 0.075, 8, 44);
      collar.translate(0, HUB_Y, z + s * 0.30);
      gold.push(collar);
    }

    // scroll brackets sweeping from the legs into the bearing
    for (const sx of [-1, 1]) {
      const pts = [
        v3(sx * 5.9, HUB_Y - 4.1, z),
        v3(sx * 4.4, HUB_Y - 2.9, z),
        v3(sx * 2.8, HUB_Y - 1.9, z),
        v3(sx * 1.35, HUB_Y - 1.25, z),
      ];
      for (let i = 0; i < pts.length - 1; i++) steel.push(memberCyl(pts[i], pts[i + 1], 0.085, 6));
    }

    // gold spire finial above the bearing
    const spire = new THREE.CylinderGeometry(0.06, 0.18, 1.1, 10);
    spire.translate(0, HUB_Y + 1.35, z);
    gold.push(spire);
    const spireBall = new THREE.SphereGeometry(0.16, 12, 10);
    spireBall.translate(0, HUB_Y + 1.95, z);
    gold.push(spireBall);
    const spireRing = new THREE.TorusGeometry(0.30, 0.05, 6, 24);
    spireRing.rotateX(Math.PI / 2);
    spireRing.translate(0, HUB_Y + 0.94, z);
    gold.push(spireRing);
  }

  // horizontal tie beams + planar diagonals between the front and rear towers
  const levels = [7.0, 11.0, 15.0, 19.0, 22.5];
  const xAt = (y) => footX * (1 - (y - baseY) / (HUB_Y - baseY));
  for (let li = 0; li < levels.length; li++) {
    const y = levels[li];
    const x = xAt(y);
    for (const sx of [-1, 1]) {
      steel.push(memberBox(v3(sx * x, y, -TOWER_Z), v3(sx * x, y, TOWER_Z), 0.16, 0.16));
    }
    if (li < levels.length - 1) {
      const y1 = levels[li + 1], x1 = xAt(y1);
      for (const sx of [-1, 1]) {
        steel.push(memberCyl(v3(sx * x, y, -TOWER_Z), v3(sx * x1, y1, TOWER_Z), 0.07, 5));
        steel.push(memberCyl(v3(sx * x, y, TOWER_Z), v3(sx * x1, y1, -TOWER_Z), 0.07, 5));
      }
    }
  }

  // crown beam just below the axle
  steel.push(memberBox(v3(-3.4, HUB_Y - 2.6, -TOWER_Z), v3(3.4, HUB_Y - 2.6, TOWER_Z), 0.20, 0.20));

  const group = new THREE.Group();
  group.name = 'supportAssembly';
  group.add(mergedMesh(steel, MATS.steel, 'towerSteel', true, true));
  group.add(mergedMesh(dark, MATS.steelSecondary, 'towerTies', true, true));
  group.add(mergedMesh(gold, MATS.gold, 'towerBrass', true, false));
  root.add(group);
  return group;
}

/* ======================================================================
 *  STATIC AXLE / DRIVE
 * ====================================================================== */
function buildAxle(root) {
  const group = new THREE.Group();
  group.name = 'axleAssembly';
  const axleLen = TOWER_Z * 2 + 1.0;
  const axle = new THREE.CylinderGeometry(0.42, 0.42, axleLen, 32);
  axle.rotateX(Math.PI / 2);
  axle.translate(0, HUB_Y, 0);
  const axleMesh = new THREE.Mesh(axle, MATS.steelSecondary);
  axleMesh.castShadow = true;
  group.add(axleMesh);

  const gear = new THREE.CylinderGeometry(0.95, 0.95, 0.16, 40);
  gear.rotateX(Math.PI / 2);
  gear.translate(0, HUB_Y, -TOWER_Z - 0.62);
  const gearMesh = new THREE.Mesh(gear, MATS.goldDeep);
  gearMesh.castShadow = true;
  group.add(gearMesh);

  // drive housing behind the rear tower
  const boxes = [];
  const housing = new THREE.BoxGeometry(1.5, 1.2, 1.1);
  housing.translate(0, HUB_Y - 1.4, -TOWER_Z - 1.25);
  boxes.push(housing);
  const cap = new THREE.BoxGeometry(1.7, 0.14, 1.3);
  cap.translate(0, HUB_Y - 0.75, -TOWER_Z - 1.25);
  boxes.push(cap);
  group.add(mergedMesh(boxes, MATS.steelShadow, 'driveHousing', true, true));

  // small brass vents
  const vents = [];
  for (let i = 0; i < 3; i++) {
    const vt = new THREE.BoxGeometry(0.9, 0.06, 0.08);
    vt.translate(0, HUB_Y - 1.75 + i * 0.22, -TOWER_Z - 1.81);
    vents.push(vt);
  }
  group.add(mergedMesh(vents, MATS.gold, 'driveVents', false, false));

  root.add(group);
  return group;
}

/* ======================================================================
 *  RIMS (each: outer/inner chord + X lattice + radial ribs)
 * ====================================================================== */
function buildRim(side) {
  const z = side * RIM_Z;
  const rIn = R - 1.0;
  const geos = [];

  const outer = new THREE.TorusGeometry(R, 0.145, 8, 256);
  outer.translate(0, 0, z);
  geos.push(outer);
  const inner = new THREE.TorusGeometry(rIn, 0.105, 8, 256);
  inner.translate(0, 0, z);
  geos.push(inner);
  const mid = new THREE.TorusGeometry(rIn + 0.50, 0.070, 8, 256);
  mid.translate(0, 0, z);
  geos.push(mid);

  const SEG = 128;
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * TAU;
    const a1 = ((i + 0.5) / SEG) * TAU;
    const a2 = ((i + 1) / SEG) * TAU;
    const p0 = v3(Math.cos(a0) * R, Math.sin(a0) * R, z);
    const p1 = v3(Math.cos(a1) * rIn, Math.sin(a1) * rIn, z);
    const p2 = v3(Math.cos(a2) * R, Math.sin(a2) * R, z);
    const p3 = v3(Math.cos(a1) * R, Math.sin(a1) * R, z);
    const p4 = v3(Math.cos(a0) * rIn, Math.sin(a0) * rIn, z);
    geos.push(memberCyl(p0, p1, 0.042, 4));
    geos.push(memberCyl(p1, p2, 0.042, 4));
    geos.push(memberCyl(p3, p4, 0.042, 4));
  }

  // radial ribs across the lattice band
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * TAU;
    const p0 = v3(Math.cos(a) * (rIn - 0.10), Math.sin(a) * (rIn - 0.10), z);
    const p1 = v3(Math.cos(a) * (R + 0.02), Math.sin(a) * (R + 0.02), z);
    geos.push(memberCyl(p0, p1, 0.055, 5));
  }

  // rivet / bolt heads along the three chords (relief from every angle)
  for (const [rad, count, size] of [[R, 120, 0.058], [rIn, 84, 0.052], [rIn + 0.50, 64, 0.046]]) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU;
      const b = new THREE.CylinderGeometry(size, size, 0.06, 6);
      b.rotateX(Math.PI / 2);
      b.translate(Math.cos(a) * rad, Math.sin(a) * rad, z + side * 0.16);
      geos.push(b);
    }
  }
  // rivet heads on the radial ribs
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * TAU;
    const b = new THREE.SphereGeometry(0.055, 6, 5);
    b.translate(Math.cos(a) * (R - 0.50), Math.sin(a) * (R - 0.50), z + side * 0.10);
    geos.push(b);
  }

  const group = new THREE.Group();
  group.name = side > 0 ? 'rimFront' : 'rimBack';
  group.add(mergedMesh(geos, MATS.steel, 'rimLattice' + (side > 0 ? 'Front' : 'Back'), true, true));

  // cast gusset plates at every 15° give the band real thickness and shadow relief
  const gussets = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    const g = new THREE.BoxGeometry(0.55, 0.095, 0.055);
    g.rotateZ(a);
    g.translate(Math.cos(a) * (R - 0.50), Math.sin(a) * (R - 0.50), z + side * 0.115);
    gussets.push(g);
    const bolt = new THREE.CylinderGeometry(0.045, 0.045, 0.05, 6);
    bolt.rotateX(Math.PI / 2);
    bolt.translate(Math.cos(a) * (R - 0.50), Math.sin(a) * (R - 0.50), z + side * 0.155);
    gussets.push(bolt);
  }
  group.add(mergedMesh(gussets, MATS.steelShadow, 'rimGussets' + (side > 0 ? 'Front' : 'Back'), true, true));

  // brass studs on the inner band
  const studs = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU + Math.PI / 24;
    const px = Math.cos(a) * (R - 0.72), py = Math.sin(a) * (R - 0.72);
    const disc = new THREE.CylinderGeometry(0.105, 0.105, 0.05, 10);
    disc.rotateX(Math.PI / 2);
    disc.translate(px, py, z + side * 0.12);
    studs.push(disc);
  }
  group.add(mergedMesh(studs, MATS.gold, 'rimStuds' + (side > 0 ? 'Front' : 'Back'), true, false));
  return group;
}

/* ======================================================================
 *  ORNAMENTAL "LACE" BAND just inside the wreath (visible below the flowers)
 * ====================================================================== */
function buildLaceBand(side) {
  const z = side * RIM_Z;
  const rIn = 0.90 * R;
  const rOut = 0.985 * R;
  const rMid = (rIn + rOut) / 2;
  const geos = [];
  const N = 96;

  const hoopIn = new THREE.TorusGeometry(rIn, 0.032, 6, 200);
  hoopIn.translate(0, 0, z);
  geos.push(hoopIn);
  const hoopOut = new THREE.TorusGeometry(rOut, 0.028, 6, 200);
  hoopOut.translate(0, 0, z);
  geos.push(hoopOut);

  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU;
    const p0 = v3(Math.cos(a) * rIn, Math.sin(a) * rIn, z);
    const p1 = v3(Math.cos(a) * rOut, Math.sin(a) * rOut, z);
    geos.push(memberCyl(p0, p1, 0.022, 4));
    // small cast-iron ring motif
    const rp = v3(Math.cos(a) * rMid, Math.sin(a) * rMid, z);
    const ring = new THREE.TorusGeometry(0.115, 0.02, 4, 12);
    ring.translate(rp.x, rp.y, rp.z);
    geos.push(ring);
    const bead = new THREE.SphereGeometry(0.035, 6, 5);
    bead.translate(rp.x, rp.y, rp.z + 0.02);
    geos.push(bead);
  }

  const group = new THREE.Group();
  group.name = 'laceBand' + (side > 0 ? 'Front' : 'Back');
  const mesh = mergedMesh(geos, MATS.steelSecondary, 'lace' + (side > 0 ? 'Front' : 'Back'), true, true);
  group.add(mesh);

  // brass rosettes between the lace motifs (visible where the garland opens up)
  const brass = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU + Math.PI / 24;
    const px = Math.cos(a) * (0.945 * R), py = Math.sin(a) * (0.945 * R);
    const disc = new THREE.CylinderGeometry(0.16, 0.16, 0.05, 16);
    disc.rotateX(Math.PI / 2);
    disc.translate(px, py, z + 0.05);
    brass.push(disc);
    const ring = new THREE.TorusGeometry(0.17, 0.025, 5, 20);
    ring.translate(px, py, z + 0.07);
    brass.push(ring);
  }
  group.add(mergedMesh(brass, MATS.gold, 'laceBrass' + (side > 0 ? 'Front' : 'Back'), true, false));
  return group;
}

/* ======================================================================
 *  CROSS TIES between the two rims
 * ====================================================================== */
function buildRimCrossTies() {
  const geos = [];
  const N = 24;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * TAU;
    const rr = R - 0.48;
    const pF = v3(Math.cos(a) * rr, Math.sin(a) * rr, RIM_Z);
    const pB = v3(Math.cos(a) * rr, Math.sin(a) * rr, -RIM_Z);
    geos.push(memberCyl(pF, pB, 0.07, 6));
    // diagonal tie to the next bay, alternating direction
    const a2 = ((i + 0.5) / N) * TAU;
    const qF = v3(Math.cos(a2) * (R - 0.18), Math.sin(a2) * (R - 0.18), RIM_Z);
    geos.push(memberCyl(pF, qF, 0.035, 4));
    const pB2 = v3(Math.cos(a) * rr, Math.sin(a) * rr, -RIM_Z);
    const qB2 = v3(Math.cos(a2) * (R - 0.18), Math.sin(a2) * (R - 0.18), -RIM_Z);
    geos.push(memberCyl(pB2, qB2, 0.035, 4));
    // cabin hanger cross-shaft (12 of the 24 align to cabins, but a full ring reads well)
    const shaft = new THREE.CylinderGeometry(0.055, 0.055, RIM_Z * 2, 6);
    shaft.rotateX(Math.PI / 2);
    shaft.translate(Math.cos(a) * R, Math.sin(a) * R, 0);
    geos.push(shaft);
  }
  return mergedMesh(geos, MATS.steel, 'rimCrossTies', true, true);
}

/* ======================================================================
 *  SPOKE ARRAYS + TIE RINGS
 * ====================================================================== */
function buildSpokes(side) {
  const PER = 32;
  const z = side * RIM_Z;
  const group = new THREE.Group();
  group.name = side > 0 ? 'spokesFront' : 'spokesBack';

  const unit = new THREE.CylinderGeometry(1, 1, 1, 6);
  unit.translate(0, 0.5, 0);
  const inst = new THREE.InstancedMesh(unit, MATS.steel, PER);
  inst.name = 'spokeSet' + (side > 0 ? 'F' : 'B');
  inst.castShadow = true;
  inst.receiveShadow = true;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const len = 0.90 * R - 0.10 * R;
  for (let i = 0; i < PER; i++) {
    const a = (i / PER) * TAU + (side < 0 ? Math.PI / PER : 0);
    dir.set(Math.cos(a), Math.sin(a), 0);
    p.set(dir.x * 0.10 * R, dir.y * 0.10 * R, z);
    q.setFromUnitVectors(UP, dir);
    s.set(0.045, len, 0.045);
    m.compose(p, q, s);
    inst.setMatrixAt(i, m);
  }
  inst.instanceMatrix.needsUpdate = true;
  group.add(inst);

  // tie rings + diagonal stays
  const rings = [];
  const ring55 = new THREE.TorusGeometry(0.55 * R, 0.055, 8, 240);
  ring55.translate(0, 0, z);
  rings.push(ring55);
  const ring78 = new THREE.TorusGeometry(0.78 * R, 0.042, 8, 220);
  ring78.translate(0, 0, z);
  rings.push(ring78);
  for (let i = 0; i < PER; i++) {
    const a = (i / PER) * TAU + (side < 0 ? Math.PI / PER : 0);
    const a2 = a + Math.PI / PER;
    const p0 = v3(Math.cos(a) * 0.78 * R, Math.sin(a) * 0.78 * R, z);
    const p1 = v3(Math.cos(a2) * 0.55 * R, Math.sin(a2) * 0.55 * R, z);
    rings.push(memberCyl(p0, p1, 0.022, 4));
    const p2 = v3(Math.cos(a2) * 0.78 * R, Math.sin(a2) * 0.78 * R, z);
    const p3 = v3(Math.cos(a) * 0.55 * R, Math.sin(a) * 0.55 * R, z);
    rings.push(memberCyl(p2, p3, 0.022, 4));
  }
  group.add(mergedMesh(rings, MATS.steelSecondary, 'spokeRings' + (side > 0 ? 'F' : 'B'), true, true));

  // riveted collars where each spoke meets the hub, tie rings and rim
  const collars = [];
  for (let i = 0; i < PER; i++) {
    const a = (i / PER) * TAU + (side < 0 ? Math.PI / PER : 0);
    const dv = v3(Math.cos(a), Math.sin(a), 0);
    for (const rad of [0.16 * R, 0.55 * R, 0.78 * R, 0.88 * R]) {
      const c = v3(dv.x * rad, dv.y * rad, z);
      const collar = new THREE.CylinderGeometry(0.078, 0.078, 0.15, 8);
      const qc = new THREE.Quaternion().setFromUnitVectors(UP, dv);
      collar.applyMatrix4(new THREE.Matrix4().compose(c, qc, new THREE.Vector3(1, 1, 1)));
      collars.push(collar);
    }
  }
  group.add(mergedMesh(collars, MATS.steelShadow, 'spokeCollars' + (side > 0 ? 'F' : 'B'), true, true));
  return group;
}

/* ======================================================================
 *  HUB
 * ====================================================================== */
function buildHub() {
  const group = new THREE.Group();
  group.name = 'hubAssembly';
  const steel = [];
  const gold = [];

  const drum = new THREE.CylinderGeometry(1.30, 1.30, 1.35, 48);
  drum.rotateX(Math.PI / 2);
  steel.push(drum);
  for (const s of [-1, 1]) {
    const flange = new THREE.CylinderGeometry(1.62, 1.30, 0.20, 48);
    flange.rotateX(Math.PI / 2);
    flange.translate(0, 0, s * 0.72);
    steel.push(flange);
    const collar = new THREE.TorusGeometry(1.34, 0.075, 8, 60);
    collar.translate(0, 0, s * 0.82);
    gold.push(collar);
    // brass sunburst around the face
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      const rad = new THREE.BoxGeometry(0.10, 0.46, 0.07);
      rad.translate(0, 0.88, 0);
      rad.rotateZ(a);
      rad.translate(0, 0, s * 0.90);
      gold.push(rad);
    }
  }
  // bearing caps
  for (const s of [-1, 1]) {
    const cap = new THREE.CylinderGeometry(0.55, 0.55, 0.14, 28);
    cap.rotateX(Math.PI / 2);
    cap.translate(0, 0, s * 0.92);
    gold.push(cap);
  }
  // riveted ring + bolts around the hub face
  for (const s of [-1, 1]) {
    const ring = new THREE.TorusGeometry(1.12, 0.035, 6, 48);
    ring.translate(0, 0, s * 0.99);
    gold.push(ring);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU;
      const bolt = new THREE.SphereGeometry(0.052, 7, 5);
      bolt.translate(Math.cos(a) * 1.12, Math.sin(a) * 1.12, s * 1.01);
      gold.push(bolt);
    }
  }
  // ornamental brass centre medallion (behind the rose bouquet)
  {
    const med = new THREE.CylinderGeometry(0.58, 0.62, 0.10, 32);
    med.rotateX(Math.PI / 2);
    med.translate(0, 0, 0.99);
    gold.push(med);
    const medRing = new THREE.TorusGeometry(0.64, 0.045, 6, 40);
    medRing.translate(0, 0, 1.02);
    gold.push(medRing);
  }

  group.add(mergedMesh(steel, MATS.steel, 'hubDrum', true, true));
  group.add(mergedMesh(gold, MATS.gold, 'hubBrass', true, false));
  return group;
}

/* ======================================================================
 *  CABINS 鈥?one prototype, 24 instanced assemblies
 * ====================================================================== */
function buildCabinGeometries() {
  // hull profile (radius, y) from the rounded boat bottom up to the glazing sill
  const hullPts = [
    [0.00, -1.85], [0.22, -1.80], [0.45, -1.68], [0.65, -1.50],
    [0.82, -1.25], [0.93, -0.95], [0.99, -0.62], [1.00, -0.30], [1.00, -0.10],
  ];
  const hull = lathe(hullPts, 48);

  // elliptical dome cap above the glazing
  const domePts = [
    [0.99, 1.05], [0.975, 1.20], [0.92, 1.38], [0.81, 1.56],
    [0.62, 1.70], [0.34, 1.81], [0.00, 1.85],
  ];
  const dome = lathe(domePts, 48);
  const shell = mergeAll([hull, dome]);

  // big observation glazing band
  const glass = new THREE.CylinderGeometry(0.99, 1.0, 1.15, 48, 1, true);
  glass.translate(0, 0.475, 0);

  const gold = [];
  // 24 vertical mullions
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    const g = new THREE.BoxGeometry(0.032, 1.175, 0.065);
    g.translate(0, 0.475, 1.005);
    g.rotateY(a);
    gold.push(g);
  }
  // three horizontal belts: sill, mid-rail, head
  for (const y of [-0.105, 0.475, 1.055]) {
    const t = new THREE.TorusGeometry(1.012, y === 0.475 ? 0.030 : 0.042, 6, 64);
    t.rotateX(Math.PI / 2);
    t.translate(0, y, 0);
    gold.push(t);
  }
  // radial ribs running up the dome
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    const ca = Math.sin(a), sa = Math.cos(a);
    const profile = [[1.00, 1.06], [0.955, 1.24], [0.86, 1.44], [0.68, 1.65], [0.36, 1.80]];
    for (let k = 0; k < profile.length - 1; k++) {
      const p0 = v3(ca * profile[k][0], profile[k][1], sa * profile[k][0]);
      const p1 = v3(ca * profile[k + 1][0], profile[k + 1][1], sa * profile[k + 1][0]);
      gold.push(memberCyl(p0, p1, 0.019, 4));
    }
  }
  // hull seam hoops
  for (const [y, rad] of [[-0.50, 0.995], [-0.98, 0.925], [-1.42, 0.70]]) {
    const hoop = new THREE.TorusGeometry(rad, 0.020, 5, 40);
    hoop.rotateX(Math.PI / 2);
    hoop.translate(0, y, 0);
    gold.push(hoop);
  }
  // arched door frames on four sides of the hull
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + Math.PI / 4;
    const panel = new THREE.BoxGeometry(0.34, 1.02, 0.024);
    panel.translate(0, -0.80, 0.992);
    panel.rotateY(a);
    gold.push(panel);
    for (const sx of [-1, 1]) {
      const rail = new THREE.BoxGeometry(0.024, 1.08, 0.034);
      rail.translate(sx * 0.19, -0.80, 0.998);
      rail.rotateY(a);
      gold.push(rail);
    }
    const arch = new THREE.TorusGeometry(0.17, 0.018, 5, 14, Math.PI);
    arch.translate(0, -0.28, 0.998);
    arch.rotateY(a);
    gold.push(arch);
  }
  // bottom keel finial + brackets
  {
    const keel = new THREE.ConeGeometry(0.16, 0.36, 12);
    keel.rotateX(Math.PI);
    keel.translate(0, -1.98, 0);
    gold.push(keel);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      const br = new THREE.BoxGeometry(0.05, 0.16, 0.20);
      br.translate(Math.sin(a) * 0.30, -1.63, Math.cos(a) * 0.30);
      br.rotateY(a);
      gold.push(br);
    }
  }
  // panel seams / door frames on the hull
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + Math.PI / 8;
    const g = new THREE.BoxGeometry(0.032, 1.15, 0.042);
    g.translate(0, -0.72, 0.995);
    g.rotateY(a);
    gold.push(g);
  }
  // bottom ring
  const baseRing = new THREE.TorusGeometry(0.36, 0.038, 6, 40);
  baseRing.rotateX(Math.PI / 2);
  baseRing.translate(0, -1.70, 0);
  gold.push(baseRing);
  // crown collar + finial
  const crown = new THREE.TorusGeometry(0.30, 0.036, 6, 36);
  crown.rotateX(Math.PI / 2);
  crown.translate(0, 1.815, 0);
  gold.push(crown);
  const finial = new THREE.SphereGeometry(0.062, 12, 10);
  finial.translate(0, 1.885, 0);
  gold.push(finial);

  // hanger: clamp bar through both rims, stub, V-yoke touching the dome shoulders
  const clamp = new THREE.CylinderGeometry(0.055, 0.055, RIM_Z * 2 + 0.40, 8);
  clamp.rotateX(Math.PI / 2);
  clamp.translate(0, 2.35, 0);
  gold.push(clamp);
  const clampRing = new THREE.TorusGeometry(0.15, 0.032, 6, 20);
  clampRing.rotateX(Math.PI / 2);
  clampRing.translate(0, 2.35, 0);
  gold.push(clampRing);

  const stub = new THREE.CylinderGeometry(0.048, 0.052, 0.42, 8);
  stub.translate(0, 2.16, 0);
  gold.push(stub);

  const cross = new THREE.CylinderGeometry(0.042, 0.042, 1.16, 8);
  cross.rotateZ(Math.PI / 2);
  cross.translate(0, 1.95, 0);
  gold.push(cross);

  for (const sx of [-1, 1]) {
    const a = v3(sx * 0.52, 1.95, 0);
    const b = v3(sx * 0.80, 1.50, 0);
    gold.push(memberCyl(a, b, 0.040, 6));
    const boss = new THREE.SphereGeometry(0.058, 10, 8);
    boss.translate(b.x, b.y, b.z);
    gold.push(boss);
  }

  // interior: dark core that gives the glazing real depth
  const interior = [];
  const core = new THREE.CylinderGeometry(0.90, 0.90, 0.82, 40);
  core.translate(0, -0.26, 0);
  interior.push(core);
  const seatRing = new THREE.TorusGeometry(0.66, 0.13, 8, 32);
  seatRing.rotateX(Math.PI / 2);
  seatRing.translate(0, -0.35, 0);
  interior.push(seatRing);
  const ceiling = new THREE.CylinderGeometry(0.90, 0.90, 0.06, 40);
  ceiling.translate(0, 1.04, 0);
  interior.push(ceiling);

  return {
    shell,
    glass,
    gold: mergeAll(gold),
    interior: mergeAll(interior),
  };
}


function buildCabins(wheelGroup, rng) {
  const proto = buildCabinGeometries();

  // Nudge the whole gondola body up in size for presence, while keeping the hanger
  // clamp exactly on the rim plane (uniform scale about the cabin centre, then shift
  // so the clamp at local y=2.35 stays put).
  const CABIN_SCALE = 1.08;
  const yShift = -2.35 * (CABIN_SCALE - 1);
  const scaleM = new THREE.Matrix4().makeTranslation(0, yShift, 0)
    .multiply(new THREE.Matrix4().makeScale(CABIN_SCALE, CABIN_SCALE, CABIN_SCALE));
  for (const g of [proto.shell, proto.glass, proto.gold, proto.interior]) g.applyMatrix4(scaleM);

  const wood = new THREE.MeshStandardMaterial({
    color: '#3c2d24', roughness: 0.85, metalness: 0.0,
    emissive: new THREE.Color('#1a0d05'), emissiveIntensity: 0.4,
  });

  const shellInst = new THREE.InstancedMesh(proto.shell, MATS.shell, CABIN_COUNT);
  shellInst.name = 'cabinShells';
  shellInst.castShadow = true;
  shellInst.receiveShadow = false;

  const goldInst = new THREE.InstancedMesh(proto.gold, MATS.gold, CABIN_COUNT);
  goldInst.name = 'cabinBrass';
  goldInst.castShadow = true;
  goldInst.receiveShadow = false;

  const glassInst = new THREE.InstancedMesh(proto.glass, MATS.glass, CABIN_COUNT);
  glassInst.name = 'cabinGlazing';
  glassInst.castShadow = false;
  glassInst.receiveShadow = false;
  glassInst.renderOrder = 2;

  const interiorInst = new THREE.InstancedMesh(proto.interior, wood, CABIN_COUNT);
  interiorInst.name = 'cabinInteriors';
  interiorInst.castShadow = false;
  interiorInst.receiveShadow = false;

  // warm cabin lamps (tiny bright spheres seen through the glazing)
  const lampGeo = new THREE.SphereGeometry(0.075, 8, 6);
  lampGeo.translate(0, 0.92, 0);
  lampGeo.applyMatrix4(scaleM);
  const lampMat = new THREE.MeshBasicMaterial({ color: '#ffe1ac', toneMapped: false });
  const lampInst = new THREE.InstancedMesh(lampGeo, lampMat, CABIN_COUNT);
  lampInst.name = 'cabinLamps';
  lampInst.castShadow = false;
  lampInst.receiveShadow = false;

  const meshes = [shellInst, goldInst, glassInst, interiorInst, lampInst];
  for (const inst of meshes) {
    inst.frustumCulled = false;
    wheelGroup.add(inst);
  }

  const baseAngles = [];
  for (let i = 0; i < CABIN_COUNT; i++) baseAngles.push(-Math.PI / 2 + (i / CABIN_COUNT) * TAU);

  const DROP = 2.35;
  const m = new THREE.Matrix4();
  const cabinGroup = new THREE.Group();
  cabinGroup.name = 'gondolaRing';
  wheelGroup.add(cabinGroup);

  function update(angle, explode = 0) {
    const push = 1 + explode * 0.24;
    const drop = DROP + explode * 1.2;
    const cosA = Math.cos(-angle), sinA = Math.sin(-angle);
    // local rotation Rz(-angle) has: [cos, -sin; sin, cos] with cos(-a)=cos a, sin(-a)=-sin a
    const r00 = Math.cos(-angle), r01 = -Math.sin(-angle);
    const r10 = Math.sin(-angle), r11 = Math.cos(-angle);
    for (let i = 0; i < CABIN_COUNT; i++) {
      const a = baseAngles[i];
      const px = Math.cos(a) * R * push;
      const py = Math.sin(a) * R * push;
      const tx = px + (r01 * -drop);
      const ty = py + (r11 * -drop);
      m.set(
        r00, r01, 0, tx,
        r10, r11, 0, ty,
        0, 0, 1, 0,
        0, 0, 0, 1
      );
      shellInst.setMatrixAt(i, m);
      goldInst.setMatrixAt(i, m);
      glassInst.setMatrixAt(i, m);
      interiorInst.setMatrixAt(i, m);
      lampInst.setMatrixAt(i, m);
    }
    shellInst.instanceMatrix.needsUpdate = true;
    goldInst.instanceMatrix.needsUpdate = true;
    glassInst.instanceMatrix.needsUpdate = true;
    interiorInst.instanceMatrix.needsUpdate = true;
    lampInst.instanceMatrix.needsUpdate = true;
  }

  // unused-but-handy angle value for other modules
  const info = { baseAngles, count: CABIN_COUNT, drop: DROP, group: cabinGroup, update, meshes };
  return info;
}

/* ======================================================================
 *  PUBLIC BUILDER
 * ====================================================================== */
export function buildFerrisWheel({ seed = 20261030 } = {}) {
  const rng = makePRNG(seed);
  const root = new THREE.Group();
  root.name = 'ferrisWheel';

  buildBase(root, rng);
  buildTowers(root);
  buildAxle(root);

  const wheelGroup = new THREE.Group();
  wheelGroup.name = 'wheelPivot';
  wheelGroup.position.y = HUB_Y;
  root.add(wheelGroup);

  const rimFront = buildRim(1);
  const rimBack = buildRim(-1);
  const laceFront = buildLaceBand(1);
  const laceBack = buildLaceBand(-1);
  const crossTies = buildRimCrossTies();
  const spokesFront = buildSpokes(1);
  const spokesBack = buildSpokes(-1);
  const hub = buildHub();

  wheelGroup.add(rimFront, rimBack, laceFront, laceBack);
  wheelGroup.add(crossTies);
  wheelGroup.add(spokesFront, spokesBack);
  wheelGroup.add(hub);

  const cabins = buildCabins(wheelGroup, rng);

  let angle = 0;
  let explode = 0;

  function setAngle(a) {
    angle = a;
    wheelGroup.rotation.z = a;
    rimFront.position.z = explode * 2.7;
    rimBack.position.z = -explode * 2.7;
    laceFront.position.z = explode * 1.5;
    laceBack.position.z = -explode * 1.5;
    spokesFront.position.z = explode * 2.1;
    spokesBack.position.z = -explode * 2.1;
    cabins.update(a, explode);
  }

  function setExplode(v) {
    explode = Math.max(0, Math.min(1, v));
    setAngle(angle);
  }

  const stats = { rims: 2, spokes: 56, cabins: CABIN_COUNT, towerLegs: 4 };
  setAngle(0);

  return {
    root,
    wheelGroup,
    rimFront,
    rimBack,
    spokesFront,
    spokesBack,
    hub,
    cabins,
    setAngle,
    getAngle: () => angle,
    setExplode,
    getExplode: () => explode,
    stats,
  };
}


