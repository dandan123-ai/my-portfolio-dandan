/**
 * Dream Wheel — cinematic post stack.
 *
 * EffectComposer chain:
 *   RenderPass
 *     -> GTAOPass            (subtle grounded AO, own depth/normal g-buffer)
 *     -> UnrealBloomPass     (tight specular bloom, threshold 0.85)
 *     -> BokehPass           (very subtle DOF focused on the hub)
 *     -> OutputPass          (ACES tone mapping + sRGB)
 *     -> SMAAPass            (edge AA, replaces MSAA)
 *     -> Grade ShaderPass    (vignette, warm/cool split-tone, film grain, edge CA)
 *
 * Public API (CONTRACT §3.2):
 *   createPost({ renderer, scene, camera, quality }) ->
 *     { render(dt), setSize(w, h), setQuality(q), stats, ready, setDOF(bool), dispose() }
 *
 * quality === 'low' disables GTAO / DOF / grain (fast QA screenshots).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/* ------------------------------------------------------------------ *
 *  Final grade: vignette + split tone + grain + tiny chromatic aberration
 * ------------------------------------------------------------------ */
const GradeShader = {
  name: 'DreamWheelGrade',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uVignette: { value: 0.18 },
    uGrain: { value: 0.02 },
    uAberration: { value: 1.0 },
    uSaturation: { value: 1.14 },
    uContrast: { value: 0.20 },
    uSplit: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uSplit;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);

      // tiny radial chromatic aberration, strongest at the frame edges
      vec2 ca = d * r2 * uAberration * 0.0032;
      vec3 c;
      c.r = texture2D(tDiffuse, uv + ca).r;
      c.g = texture2D(tDiffuse, uv).g;
      c.b = texture2D(tDiffuse, uv - ca).b;

      // split tone: clean blue-grey shadows, warm golden highlights (golden-hour print look)
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float shadowW = 1.0 - smoothstep(0.02, 0.36, l);
      float highW = smoothstep(0.40, 1.0, l);
      c += vec3(-0.007, 0.001, 0.015) * shadowW * uSplit;
      c += vec3(0.026, 0.013, -0.011) * highW * uSplit;

      // gentle filmic S-curve, then a touch of vibrance
      c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
      float l2 = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l2), c, uSaturation);

      // vignette
      float vig = smoothstep(0.94, 0.26, length(d * vec2(1.05, 0.88)) * 1.24);
      c *= mix(1.0, vig, uVignette);

      // very subtle highlight veil / halation
      c += vec3(0.004, 0.003, 0.001) * smoothstep(0.86, 1.0, l2);

      // fine film grain (animated, display space)
      float g = hash12(uv * uResolution + fract(uTime) * 431.7) - 0.5;
      c += g * uGrain;

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

const FOCUS_TARGET = new THREE.Vector3(0, 24.5, 0);

const PRESETS = {
  high: {
    // DOF stays in the chain but is off by default: at 1500x950 the depth-of-field pass
    // softened the cumulus sky more than it added, and it costs a full extra scene render.
    // It is implemented and can be enabled with post.setDOF(true) (see stats.dof).
    gtao: true, dof: false, grain: 0.02, bloomStrength: 0.28, bloomRadius: 0.52,
    bloomThreshold: 0.9, gtaoSamples: 16, dofAperture: 0.000006, dofMaxBlur: 0.0015,
  },
  low: {
    gtao: false, dof: false, grain: 0.0, bloomStrength: 0.24, bloomRadius: 0.5,
    bloomThreshold: 0.92, gtaoSamples: 8, dofAperture: 0.0, dofMaxBlur: 0.0,
  },
};

export function createPost({ renderer, scene, camera, quality = 'high' } = {}) {
  if (!renderer || !scene || !camera) throw new Error('createPost: renderer, scene and camera are required');

  const q = PRESETS[quality] ? quality : 'high';
  const preset = PRESETS[q];

  const size = renderer.getSize(new THREE.Vector2());
  const pixelRatio = renderer.getPixelRatio();
  let width = Math.max(2, Math.floor(size.x * pixelRatio));
  let height = Math.max(2, Math.floor(size.y * pixelRatio));

  const composer = new EffectComposer(renderer);

  /* --------------------------- render pass -------------------------- */
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  /* ------------------------------- GTAO ----------------------------- */
  const gtao = new GTAOPass(scene, camera, width, height);
  gtao.updateGtaoMaterial({
    radius: 2.1,
    distanceExponent: 1.5,
    thickness: 2.4,
    distanceFallOff: 1.0,
    scale: 1.0,
    samples: preset.gtaoSamples,
    screenSpaceRadius: false,
  });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
  gtao.blendIntensity = 0.86;
  gtao.output = GTAOPass.OUTPUT.Default;
  // keep AO energy on the wheel + plaza around the base, not the far horizon
  gtao.setSceneClipBox(new THREE.Box3(new THREE.Vector3(-80, -2, -80), new THREE.Vector3(80, 80, 80)));
  gtao.enabled = preset.gtao;
  composer.addPass(gtao);

  /* ------------------------------ bloom ----------------------------- */
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    preset.bloomStrength,
    preset.bloomRadius,
    preset.bloomThreshold,
  );
  bloom.enabled = true;
  composer.addPass(bloom);

  /* ------------------------------- DOF ------------------------------ */
  const bokeh = new BokehPass(scene, camera, {
    focus: camera.position.distanceTo(FOCUS_TARGET),
    aperture: preset.dofAperture,
    maxblur: preset.dofMaxBlur,
  });
  bokeh.enabled = preset.dof;
  composer.addPass(bokeh);

  /* ---------------------------- output LDR -------------------------- */
  const output = new OutputPass();
  composer.addPass(output);

  /* ------------------------------- SMAA ----------------------------- */
  const smaa = new SMAAPass(width, height);
  composer.addPass(smaa);

  /* ------------------------------ grade ----------------------------- */
  const grade = new ShaderPass(GradeShader);
  grade.uniforms.uGrain.value = preset.grain;
  grade.uniforms.uResolution.value.set(width, height);
  composer.addPass(grade);

  const stats = {
    quality: q,
    passes: composer.passes.length,
    draws: 0,
    triangles: 0,
    gtao: preset.gtao,
    dof: preset.dof,
    bloom: { strength: preset.bloomStrength, radius: preset.bloomRadius, threshold: preset.bloomThreshold },
    frames: 0,
  };

  let dofEnabled = preset.dof;
  let disposed = false;

  function updateStats() {
    const info = renderer.info;
    stats.draws = info.render.calls;
    stats.triangles = info.render.triangles;
    stats.frames++;
  }

  function render(dt = 0) {
    if (disposed) return;
    const d = Math.max(0, Math.min(dt, 0.1));
    grade.uniforms.uTime.value += d;

    if (bokeh.enabled) {
      // keep the wheel hub in focus as the camera orbits
      bokeh.uniforms.focus.value = camera.position.distanceTo(FOCUS_TARGET);
    }

    // accumulate draw/triangle counts across every internal pass (renderer resets per render)
    renderer.info.autoReset = false;
    renderer.info.reset();
    composer.render(d);
    updateStats();
    renderer.info.autoReset = true;
  }

  function setSize(w, h) {
    if (disposed) return;
    const pr = renderer.getPixelRatio();
    composer.setSize(w, h);
    width = Math.max(2, Math.floor(w * pr));
    height = Math.max(2, Math.floor(h * pr));
    grade.uniforms.uResolution.value.set(width, height);
    if (bokeh.enabled) bokeh.uniforms.focus.value = camera.position.distanceTo(FOCUS_TARGET);
  }

  function setQuality(next) {
    if (!PRESETS[next] || disposed) return;
    quality = next;
    const p = PRESETS[next];
    gtao.enabled = p.gtao && next !== 'low' ? p.gtao : p.gtao;
    dofEnabled = p.dof;
    bokeh.enabled = p.dof;
    grade.uniforms.uGrain.value = p.grain;
    bloom.strength = p.bloomStrength;
    bloom.radius = p.bloomRadius;
    bloom.threshold = p.bloomThreshold;
    stats.quality = next;
    stats.gtao = gtao.enabled;
    stats.dof = bokeh.enabled;
    stats.bloom = { strength: p.bloomStrength, radius: p.bloomRadius, threshold: p.bloomThreshold };
  }

  function setDOF(on) {
    dofEnabled = !!on && quality !== 'low';
    bokeh.enabled = dofEnabled;
    stats.dof = dofEnabled;
  }

  function dispose() {
    disposed = true;
    composer.passes.length = 0;
    composer.dispose && composer.dispose();
  }

  return {
    render,
    setSize,
    setQuality,
    setDOF,
    stats,
    ready: Promise.resolve(),
    dispose,
    /** @internal QA hooks */
    _composer: composer,
    _passes: { gtao, bloom, bokeh, output, smaa, grade },
  };
}
