/**
 * Dream Wheel — night mode.
 *
 * Adds a click-to-night experience on top of the day scene:
 *   • procedural indigo night-sky dome, 1,900 stars, a glowing moon with halo
 *   • moonlight + warm "fairy lights" on rims / spokes / hub / towers / plinth / cabins
 *   • smooth day→night crossfade of the whole light rig, IBL intensity, fog and exposure
 *   • hooks the fireworks module (js/fireworks.js) when present
 *
 * Public API:
 *   buildNight({ scene, camera, renderer, wheel, post, fireworks, quality }) ->
 *     { group, setProgress(p), getProgress(), update(dt, time), moonDir, stats }
 */
import * as THREE from 'three';
import {
  R, HUB_Y, RIM_Z, TOWER_Z, BASE_H, CABIN_COUNT, TAU, DEG,
  MATS, makePRNG, rr, canvasTexture,
} from './design.js';

/* ------------------------------------------------------------------ *
 *  Texture helpers
 * ------------------------------------------------------------------ */
function makeSoftGlowTexture() {
  return canvasTexture(128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const rg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    rg.addColorStop(0.0, 'rgba(255,255,255,1)');
    rg.addColorStop(0.18, 'rgba(255,246,225,0.95)');
    rg.addColorStop(0.45, 'rgba(255,225,180,0.35)');
    rg.addColorStop(1.0, 'rgba(255,210,150,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, w, h);
  });
}

function makeMoonTexture() {
  return canvasTexture(512, 512, (g, w, h) => {
    const rng = makePRNG(0x51ee7);
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, rad = w * 0.47;
    const rg = g.createRadialGradient(cx - rad * 0.22, cy - rad * 0.26, rad * 0.1, cx, cy, rad);
    rg.addColorStop(0, '#fdfdff');
    rg.addColorStop(0.55, '#eef1fb');
    rg.addColorStop(0.9, '#cfd6e8');
    rg.addColorStop(1, '#b8c0d8');
    g.fillStyle = rg;
    g.beginPath(); g.arc(cx, cy, rad, 0, TAU); g.fill();
    // maria (large soft darker patches)
    g.save();
    g.beginPath(); g.arc(cx, cy, rad, 0, TAU); g.clip();
    for (let i = 0; i < 16; i++) {
      const x = cx + rr(rng, -0.75, 0.75) * rad;
      const y = cy + rr(rng, -0.75, 0.75) * rad;
      const rr2 = rr(rng, 0.08, 0.30) * rad;
      const mg = g.createRadialGradient(x, y, 0, x, y, rr2);
      mg.addColorStop(0, `rgba(168,176,199,${rr(rng, 0.20, 0.38)})`);
      mg.addColorStop(1, 'rgba(168,176,199,0)');
      g.fillStyle = mg;
      g.beginPath(); g.arc(x, y, rr2, 0, TAU); g.fill();
    }
    // craters
    for (let i = 0; i < 70; i++) {
      const a = rng() * TAU, d = Math.sqrt(rng()) * 0.92 * rad;
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      const cr = rr(rng, 1.4, 7.5);
      g.strokeStyle = `rgba(150,160,186,${rr(rng, 0.18, 0.45)})`;
      g.lineWidth = rr(rng, 0.8, 2.0);
      g.beginPath(); g.arc(x, y, cr, 0, TAU); g.stroke();
      g.fillStyle = `rgba(255,255,255,${rr(rng, 0.05, 0.16)})`;
      g.beginPath(); g.arc(x - cr * 0.2, y - cr * 0.2, cr * 0.7, 0, TAU); g.fill();
    }
    g.restore();
  });
}

function makeMoonHaloTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    const rg = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w / 2);
    rg.addColorStop(0.0, 'rgba(220,232,255,0.85)');
    rg.addColorStop(0.28, 'rgba(190,210,255,0.34)');
    rg.addColorStop(0.6, 'rgba(150,180,255,0.11)');
    rg.addColorStop(1.0, 'rgba(120,150,255,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, w, h);
  });
}

/* ------------------------------------------------------------------ *
 *  Night sky dome shader
 * ------------------------------------------------------------------ */
function makeNightDome() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: false,
    uniforms: {
      uOpacity: { value: 0 },
      uZenith: { value: new THREE.Color('#050a1c') },
      uMid: { value: new THREE.Color('#0b1735') },
      uHorizon: { value: new THREE.Color('#1c2a4e') },
      uHaze: { value: new THREE.Color('#2a3358') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform float uOpacity;
      uniform vec3 uZenith; uniform vec3 uMid; uniform vec3 uHorizon; uniform vec3 uHaze;
      void main() {
        float h = clamp(vDir.y, -0.1, 1.0);
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.30, h));
        col = mix(col, uZenith, smoothstep(0.22, 0.85, h));
        // faint warm city-glow near the horizon
        col += uHaze * pow(1.0 - clamp(h, 0.0, 1.0), 6.0) * 0.55;
        gl_FragColor = vec4(col, uOpacity);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1450, 48, 24), material);
  mesh.renderOrder = -100;
  mesh.frustumCulled = false;
  mesh.name = 'nightDome';
  return mesh;
}

/* ------------------------------------------------------------------ *
 *  Fairy-light point sets
 * ------------------------------------------------------------------ */
function bulbPoints(positions, colors, size, map) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    map, size, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 6;
  return pts;
}

function pushBulb(pos, col, x, y, z, rng) {
  pos.push(x, y, z);
  const warm = 0.92 + rng() * 0.08;
  const pink = rng() < 0.18 ? 0.10 : 0.0;
  col.push(2.9 * warm + pink * 1.8, 1.95 * warm, 0.95 * warm + pink * 1.2);
}

function makeWheelBulbs(rng) {
  const pos = [], col = [];
  const ring = (rad, z, stepDeg, jitter = 0.35) => {
    const n = Math.max(24, Math.round(360 / stepDeg));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rr(rng, -0.004, 0.004);
      pushBulb(pos, col, Math.cos(a) * rad + rr(rng, -jitter, jitter), Math.sin(a) * rad + rr(rng, -jitter, jitter), z + rr(rng, -0.1, 0.1), rng);
    }
  };
  // wreath outline strings (just outside the flower band, front and back)
  ring(R + 1.18, 0, 1.45, 0.12);
  ring(R + 0.55, 1.18, 2.3, 0.10);
  ring(R + 0.55, -1.18, 2.3, 0.10);
  // inner rim strings
  ring(R - 1.15, 0.78, 2.4, 0.10);
  ring(R - 1.15, -0.78, 2.4, 0.10);
  // hub ring
  ring(2.15, 0.98, 9, 0.06);
  // bulbs along the spokes
  const PER = 32;
  for (const side of [-1, 1]) {
    for (let i = 0; i < PER; i++) {
      const a = (i / PER) * TAU + (side < 0 ? Math.PI / PER : 0);
      const n = 6;
      for (let k = 0; k < n; k++) {
        const t = 0.16 + (k / (n - 1)) * 0.68;
        const rad = t * R;
        pushBulb(pos, col, Math.cos(a) * rad, Math.sin(a) * rad, side * RIM_Z + rr(rng, -0.05, 0.05), rng);
      }
    }
  }
  return { pos, col };
}

function makeStaticBulbs(rng) {
  const pos = [], col = [];
  // tower leg strings (front faces, visible from the default camera)
  for (const sz of [-1, 1]) {
    const z = sz * (TOWER_Z + 0.24);
    for (const sx of [-1, 1]) {
      const foot = new THREE.Vector3(sx * 0.66 * R, BASE_H + 0.36, z);
      const hub = new THREE.Vector3(0, HUB_Y, z);
      const n = 18;
      for (let k = 0; k < n; k++) {
        const t = 0.05 + (k / (n - 1)) * 0.9;
        const p = foot.clone().lerp(hub, t);
        pushBulb(pos, col, p.x + rr(rng, -0.22, 0.22), p.y, p.z + (sz > 0 ? 0.30 : 0.16), rng);
      }
    }
  }
  // plinth edge string
  const pts = [];
  const halfW = 0.99 * R;
  const step = 1.6;
  for (let x = -halfW; x <= halfW; x += step) pts.push([x, BASE_H + 0.02, 3.32], [x, BASE_H + 0.02, 3.32]);
  const n = 96;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const x = Math.cos(a) * (0.99 * R);
    const z = Math.sin(a) * 3.05;
    pushBulb(pos, col, x, BASE_H + 0.03, z, rng);
  }
  return { pos, col };
}

/* ------------------------------------------------------------------ *
 *  Main builder
 * ------------------------------------------------------------------ */
export function buildNight({ scene, camera, renderer, wheel, env = null, post, fireworks, quality = 'high' } = {}) {
  const rng = makePRNG(0x0deadbe);
  const group = new THREE.Group();
  group.name = 'nightMode';
  scene.add(group);

  const glowTex = makeSoftGlowTexture();
  const moonTex = makeMoonTexture();
  const haloTex = makeMoonHaloTexture();

  /* ---------- sky dome ---------- */
  const dome = makeNightDome();
  group.add(dome);

  /* ---------- stars ---------- */
  const starCount = quality === 'low' ? 900 : 1900;
  const starPos = new Float32Array(starCount * 3);
  const starCol = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const u = rng() * TAU;
    const v = Math.acos(rr(rng, -0.08, 1.0));
    const rad = 1250;
    starPos[i * 3] = Math.sin(v) * Math.cos(u) * rad;
    starPos[i * 3 + 1] = Math.cos(v) * rad;
    starPos[i * 3 + 2] = Math.sin(v) * Math.sin(u) * rad;
    const b = rr(rng, 0.35, 1.0) * (rng() < 0.06 ? 2.2 : 1);
    const tint = rr(rng, 0.86, 1.0);
    starCol[i * 3] = b * tint;
    starCol[i * 3 + 1] = b * (0.92 + 0.08 * tint);
    starCol[i * 3 + 2] = b * 1.0;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
  const starMat = new THREE.PointsMaterial({
    size: 1.8, sizeAttenuation: false, vertexColors: true,
    transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = -90;
  stars.frustumCulled = false;
  group.add(stars);

  /* ---------- moon ---------- */
  const moonDir = new THREE.Vector3(0.60, 0.36, -0.72).normalize();
  const moonPos = moonDir.clone().multiplyScalar(1180);
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: moonTex, transparent: true, depthWrite: false, toneMapped: false,
    fog: false, opacity: 0,
  }));
  moon.position.copy(moonPos);
  moon.scale.setScalar(88);
  moon.renderOrder = -80;
  group.add(moon);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    toneMapped: false, fog: false, opacity: 0, color: 0xcfe0ff,
  }));
  halo.position.copy(moonPos);
  halo.scale.setScalar(430);
  halo.renderOrder = -85;
  group.add(halo);

  /* ---------- fairy lights ---------- */
  const wheelBulbsData = makeWheelBulbs(makePRNG(0xbee11));
  const wheelBulbs = bulbPoints(wheelBulbsData.pos, wheelBulbsData.col, 0.58, glowTex);
  wheel.wheelGroup.add(wheelBulbs);
  // a second, larger and dimmer additive layer gives every bulb a soft halo
  const wheelHalo = bulbPoints(wheelBulbsData.pos, wheelBulbsData.col, 1.85, glowTex);
  wheelHalo.material.opacity = 0;
  wheel.wheelGroup.add(wheelHalo);

  const staticBulbsData = makeStaticBulbs(makePRNG(0xb0a7));
  const staticBulbs = bulbPoints(staticBulbsData.pos, staticBulbsData.col, 0.52, glowTex);
  group.add(staticBulbs);
  const staticHalo = bulbPoints(staticBulbsData.pos, staticBulbsData.col, 1.6, glowTex);
  staticHalo.material.opacity = 0;
  group.add(staticHalo);

  // cabin window glow points (updated every frame to follow the gondolas)
  const cabCount = CABIN_COUNT;
  const cabPos = new Float32Array(cabCount * 3);
  const cabCol = new Float32Array(cabCount * 3);
  const cabBaseAngles = wheel.cabins.baseAngles;
  for (let i = 0; i < cabCount; i++) {
    cabCol[i * 3] = 2.5; cabCol[i * 3 + 1] = 1.85; cabCol[i * 3 + 2] = 1.0;
  }
  const cabGeo = new THREE.BufferGeometry();
  cabGeo.setAttribute('position', new THREE.BufferAttribute(cabPos, 3));
  cabGeo.setAttribute('color', new THREE.BufferAttribute(cabCol, 3));
  const cabMat = new THREE.PointsMaterial({
    map: glowTex, size: 2.1, sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false, fog: false,
  });
  const cabinGlows = new THREE.Points(cabGeo, cabMat);
  cabinGlows.frustumCulled = false;
  cabinGlows.renderOrder = 7;
  wheel.wheelGroup.add(cabinGlows);

  /* ---------- collect day lights + materials ---------- */
  const dayLights = [];
  scene.traverse((o) => {
    if (o.isLight) {
      dayLights.push({
        light: o,
        intensity: o.intensity,
        color: o.color ? o.color.clone() : null,
        ground: o.isHemisphereLight ? o.groundColor.clone() : null,
      });
    }
  });
  const sun = scene.getObjectByName('env-key-sun');
  const daySunIntensity = sun ? sun.intensity : 0;
  const daySunColor = sun ? sun.color.clone() : null;
  const sunGlow = scene.getObjectByName('env-sun-glow');

  const materialBases = new Map();
  scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (m && m.envMapIntensity !== undefined && !materialBases.has(m)) {
        materialBases.set(m, {
          env: m.envMapIntensity,
          emissive: m.emissive ? m.emissive.clone() : null,
          emissiveIntensity: m.emissiveIntensity,
        });
      }
    }
  });

  // environment scenery (lawn / plaza / treeline / park trees / contact shadow) needs a
  // much stronger day→night albedo drop than the lit hero assets.
  const sceneryBases = new Map();
  if (env && env._root) {
    env._root.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) {
        if (m && !sceneryBases.has(m) && m.color) {
          sceneryBases.set(m, {
            color: m.color.clone(),
            unlit: !!m.isMeshBasicMaterial,
            opacity: m.opacity,
          });
        }
      }
    });
  }

  const dayFogColor = scene.fog ? scene.fog.color.clone() : new THREE.Color('#efd9c8');
  const nightFogColor = new THREE.Color('#0a1226');
  const dayExposure = renderer.toneMappingExposure;
  const nightExposure = Math.max(0.9, dayExposure * 1.06);

  /* ---------- night-only lights ---------- */
  const nightLights = [];
  const moonLight = new THREE.DirectionalLight('#b9d0ff', 0);
  moonLight.name = 'night-moonlight';
  moonLight.position.copy(moonDir).multiplyScalar(260);
  moonLight.target.position.set(0, 20, 0);
  moonLight.castShadow = quality !== 'low';
  if (moonLight.castShadow) {
    moonLight.shadow.mapSize.set(2048, 2048);
    const sc = moonLight.shadow.camera;
    sc.left = -48; sc.right = 48; sc.top = 58; sc.bottom = -12; sc.near = 5; sc.far = 420;
    moonLight.shadow.bias = -0.0005;
    moonLight.shadow.normalBias = 0.04;
  }
  scene.add(moonLight, moonLight.target);
  nightLights.push(moonLight);

  const washWarm = new THREE.PointLight('#ffcf9a', 0, 90, 1.65);
  washWarm.position.set(-8, HUB_Y - 4, 26);
  scene.add(washWarm); nightLights.push(washWarm);

  const washPink = new THREE.PointLight('#ff9fb2', 0, 70, 1.7);
  washPink.position.set(18, 14, 22);
  scene.add(washPink); nightLights.push(washPink);

  const baseGlow = new THREE.PointLight('#ffb26e', 0, 46, 1.7);
  baseGlow.position.set(0, 5.5, 12);
  scene.add(baseGlow); nightLights.push(baseGlow);

  // extra warm/pink washes so the garland reads as flowers on every arc of the wheel
  const garlandWash = new THREE.PointLight('#ffd2b0', 0, 95, 1.65);
  garlandWash.position.set(0, 9, 26);
  scene.add(garlandWash); nightLights.push(garlandWash);

  const garlandPink = new THREE.PointLight('#ff9bb4', 0, 85, 1.7);
  garlandPink.position.set(-23, 15, 16);
  scene.add(garlandPink); nightLights.push(garlandPink);

  const rimCool = new THREE.DirectionalLight('#7f9cff', 0);
  rimCool.position.set(30, 34, -55);
  scene.add(rimCool); nightLights.push(rimCool);

  /* ---------- glass night emission ---------- */
  const glassBase = materialBases.get(MATS.glass) || { emissive: MATS.glass.emissive.clone(), emissiveIntensity: MATS.glass.emissiveIntensity };
  if (!MATS.glass.emissive) MATS.glass.emissive = new THREE.Color('#000000');
  MATS.glass.emissive.set('#ffb066');
  MATS.glass.emissiveIntensity = 0;

  let progress = 0;
  let nightUI = false;

  function applyProgress(p) {
    progress = p;
    dome.material.uniforms.uOpacity.value = p;
    starMat.opacity = p * 0.92;
    moon.material.opacity = Math.min(1, p * 1.15);
    halo.material.opacity = p * 0.55;
    moon.scale.setScalar(88 + Math.sin(performance.now() * 0.0004) * 1.2);
    wheelBulbs.material.opacity = p;
    staticBulbs.material.opacity = p * 0.95;
    wheelHalo.material.opacity = p * 0.30;
    staticHalo.material.opacity = p * 0.28;
    cabMat.opacity = p * 0.95;
    wheelBulbs.visible = staticBulbs.visible = cabinGlows.visible = p > 0.015;
    wheelHalo.visible = staticHalo.visible = p > 0.02;
    stars.visible = moon.visible = halo.visible = p > 0.01;

    // day lights -> night values
    for (const d of dayLights) {
      const l = d.light;
      if (l === sun) {
        l.intensity = daySunIntensity * (1 - p) + 0.16 * p;
        if (daySunColor && l.color) l.color.copy(daySunColor).lerp(new THREE.Color('#9db6e8'), p);
      } else if (l.isHemisphereLight) {
        l.intensity = d.intensity * (1 - p) + 0.42 * p;
        if (l.color) l.color.copy(d.color).lerp(new THREE.Color('#2b3d67'), p);
        if (l.groundColor) l.groundColor.copy(d.ground).lerp(new THREE.Color('#0c1220'), p);
      } else if (l.isDirectionalLight) {
        l.intensity = d.intensity * (1 - p) + d.intensity * 0.12 * p;
      } else if (l.isPointLight) {
        l.intensity = d.intensity * (1 - p) + d.intensity * 0.12 * p;
      } else if (l.isSpotLight) {
        l.intensity = d.intensity * (1 - p);
      }
    }

    // moon + night lights ramp (deliberately restrained so the dark sky keeps its depth)
    moonLight.intensity = 0.68 * p;
    washWarm.intensity = 560 * p;
    washPink.intensity = 280 * p;
    baseGlow.intensity = 160 * p;
    garlandWash.intensity = 340 * p;
    garlandPink.intensity = 300 * p;
    rimCool.intensity = 0.45 * p;

    // IBL / reflections dim; glass windows glow
    for (const [m, b] of materialBases) {
      m.envMapIntensity = b.env * (1 - 0.94 * p);
    }
    MATS.glass.emissiveIntensity = 1.9 * p;
    if (glassBase && glassBase.emissiveIntensity !== undefined) {
      // keep a floor so windows still catch the night lights
    }

    // environment scenery drops to a moonlit blue-grey silhouette
    for (const [m, b] of sceneryBases) {
      const nightFactor = b.unlit ? 0.10 : 0.26;
      m.color.copy(b.color).multiplyScalar(1 - (1 - nightFactor) * p);
      if (m.opacity !== undefined) m.opacity = b.opacity;
    }
    // day sky glow billboard fades out
    scene.fog.color.copy(dayFogColor).lerp(nightFogColor, p);

    if (sunGlow) sunGlow.visible = p < 0.35;

    renderer.toneMappingExposure = dayExposure * (1 - p) + nightExposure * p;

    // fireworks are enabled once the scene is mostly night
    if (fireworks) {
      fireworks.setOpacity(Math.max(0, (p - 0.45) / 0.55));
      fireworks.setActive(p > 0.7);
    }

    if (!nightUI && p > 0.55) {
      nightUI = true;
      document.body.classList.add('night');
    } else if (nightUI && p <= 0.5) {
      nightUI = false;
      document.body.classList.remove('night');
    }
  }

  function update(dt, time) {
    if (progress < 0.01) {
      if (fireworks) fireworks.update(dt, time);
      return;
    }
    // cabin window glow follows the rotating gondolas
    const angle = wheel.getAngle();
    const explode = wheel.getExplode ? wheel.getExplode() : 0;
    const drop = 2.35 + explode * 1.2;
    const cz = Math.cos(-angle), sz = Math.sin(-angle);
    const arr = cabGeo.getAttribute('position').array;
    for (let i = 0; i < cabCount; i++) {
      const a = cabBaseAngles[i];
      const rimX = Math.cos(a) * R, rimY = Math.sin(a) * R;
      // local offset (0, -drop + 0.45) rotated by -angle
      const oy = -drop + 0.45;
      arr[i * 3] = rimX + (sz * oy);
      arr[i * 3 + 1] = rimY + (cz * oy);
      arr[i * 3 + 2] = 0;
    }
    cabGeo.getAttribute('position').needsUpdate = true;

    // gentle moon halo breathing + star twinkle
    if (halo.material) halo.material.opacity = progress * (0.5 + Math.sin(time * 0.7) * 0.06);
    if (moon.material) moon.material.opacity = Math.min(1, progress * 1.15);

    if (fireworks) fireworks.update(dt, time);
  }

  const stats = { stars: starCount, wheelBulbs: wheelBulbsData.pos.length / 3, staticBulbs: staticBulbsData.pos.length / 3, cabins: cabCount };
  console.info('[night] ready:', JSON.stringify(stats));

  return {
    group,
    setProgress: applyProgress,
    getProgress: () => progress,
    update,
    moonDir,
    moonLight,
    stats,
    dispose() {
      scene.remove(group);
      scene.remove(moonLight, moonLight.target, washWarm, washPink, baseGlow, rimCool);
    },
  };
}
