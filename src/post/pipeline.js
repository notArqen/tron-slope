import * as THREE from 'three';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import * as SH from './shaders.js';
import { makeLUT, makeDirt } from './textures.js';
import { LensDroplets } from './droplets.js';

const HALTON = Array.from({ length: 8 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);
function halton(i, b) { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }

function rt(w, h, { type = THREE.HalfFloatType, filter = THREE.LinearFilter, count = 1, depth = false } = {}) {
  const t = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type, minFilter: filter, magFilter: filter, depthBuffer: depth, stencilBuffer: false, count,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
  for (const tex of t.textures) { tex.generateMipmaps = false; tex.colorSpace = THREE.NoColorSpace; }
  return t;
}

class FSPass {
  constructor(fs, uniforms = {}) {
    this.material = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: SH.FS_VERT, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
    this.u = this.material.uniforms;
  }
}

// The whole post stack. Each logical effect is its own pass (or pass group) so
// it can be toggled, given its own resolution, and timed individually.
export class Pipeline {
  constructor(renderer, perf, shared, vol) {
    this.r = renderer; this.perf = perf; this.shared = shared; this.vol = vol;
    this.quadGeo = new THREE.BufferGeometry();
    this.quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(this.quadGeo, null); this.quad.frustumCulled = false;
    this.quadScene = new THREE.Scene(); this.quadScene.add(this.quad);
    this.quadCam = new THREE.Camera();

    this.depthU = { tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() }, uNearFar: { value: new THREE.Vector2() } };
    const D = this.depthU;
    const N = { tNormal: { value: null } };
    const cam = { uCamWorld: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() } };
    this.camU = cam;

    this.p = {
      ao: new FSPass(SH.AO_FS, { ...D, ...N, uRadius: { value: 1.6 }, uIntensity: { value: 1 }, uSamples: { value: 8 }, uFrame: { value: 0 } }),
      ssr: new FSPass(SH.SSR_FS, { ...D, ...N, tColor: { value: null }, uSteps: { value: 32 }, uFrame: { value: 0 }, uMaxDist: { value: 60 } }),
      gi: new FSPass(SH.GI_FS, { ...D, ...N, tColor: { value: null }, uFrame: { value: 0 } }),
      fog: new FSPass(SH.FOG_FS, { ...shared, ...vol, ...D, ...N, uCamWorld: cam.uCamWorld, uSteps: { value: 16 }, uFrame: { value: 0 },
        uVolStrength: { value: 1 }, uGlow: { value: 1 }, uVolumetric: { value: 1 }, uFogOn: { value: 1 } }),
      god: new FSPass(SH.GOD_FS, { ...N, tColor: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.6) }, uStrength: { value: 0.5 }, uVisible: { value: 1 } }),
      composite: new FSPass(SH.COMPOSITE_FS, { ...D, ...N, tColor: { value: null }, tAO: { value: null }, tSSR: { value: null }, tPlanar: { value: null }, tGI: { value: null },
        tFog: { value: null }, tGod: { value: null }, tPart: { value: null }, uAO: { value: 1 }, uRefl: { value: 2 }, uGI: { value: 1 }, uFog: { value: 1 }, uGod: { value: 1 }, uHaze: { value: 1 },
        uReflStrength: { value: 1 }, uGIStrength: { value: 0.5 }, uHazeStrength: { value: 0.5 }, uSmog: shared.uSmog, uCamWorld: cam.uCamWorld, uMirrorVP: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() } }),
      taa: new FSPass(SH.TAA_FS, { ...D, tCurrent: { value: null }, tHistory: { value: null }, uCamWorld: cam.uCamWorld, uPrevVP: cam.uPrevVP, uTexel: { value: new THREE.Vector2() }, uReset: { value: 1 } }),
      motion: new FSPass(SH.MOTION_FS, { ...D, tColor: { value: null }, uCamWorld: cam.uCamWorld, uPrevVP: cam.uPrevVP, uTime: shared.uTime,
        uMB: { value: 1 }, uMBStrength: { value: 0.6 }, uMBSamples: { value: 8 }, uRadial: { value: 1 }, uRadialStrength: { value: 0.5 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uHaze: { value: 1 }, uHazeStrength: { value: 0.5 }, uSlopeTan: shared.uSlopeTan, uVents: vol.uVents }),
      dofPrep: new FSPass(SH.DOF_PREP_FS, { ...D, tColor: { value: null }, uFocus: { value: 10 }, uAperture: { value: 0.5 }, uMaxBlur: { value: 8 } }),
      dofBlur: new FSPass(SH.DOF_BLUR_FS, { tPrep: { value: null }, uSamples: { value: 24 }, uTexel: { value: new THREE.Vector2() }, uMaxBlur: { value: 8 } }),
      dofComp: new FSPass(SH.DOF_COMP_FS, { tColor: { value: null }, tBlur: { value: null }, tPrep: { value: null } }),
      bright: new FSPass(SH.BRIGHT_FS, { tColor: { value: null }, tMask: { value: null }, uThreshold: { value: 1.4 }, uSelective: { value: 0.6 }, uTexel: { value: new THREE.Vector2() } }),
      down: new FSPass(SH.DOWN_FS, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } }),
      up: new FSPass(SH.UP_FS, { tColor: { value: null }, tLow: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 0.75 } }),
      streak: new FSPass(SH.STREAK_FS, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uSpread: { value: 1 } }),
      flare: new FSPass(SH.FLARE_FS, { tColor: { value: null }, uGhosts: { value: 4 }, uDispersal: { value: 0.35 } }),
      lum: new FSPass(SH.LUM_FS, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 1 } }),
      adapt: new FSPass(SH.ADAPT_FS, { tPrev: { value: null }, tCur: { value: null }, uRate: { value: 0.05 } }),
      grade: new FSPass(SH.GRADE_FS, { tColor: { value: null }, tBloom: { value: null }, tStreak: { value: null }, tFlare: { value: null }, tBloomLow: { value: null }, tDirt: { value: makeDirt() },
        tAdapt: { value: null }, tLUT: { value: null }, uBloom: { value: 1 }, uStreak: { value: 1 }, uFlare: { value: 1 }, uHalation: { value: 1 }, uDirt: { value: 1 },
        uBloomStrength: { value: 1 }, uStreakStrength: { value: 0.3 }, uFlareStrength: { value: 0.3 }, uHalationStrength: { value: 0.3 }, uDirtStrength: { value: 0.6 },
        uStreakTint: { value: new THREE.Color(0.6, 0.8, 1.2) }, uAE: { value: 1 }, uExposure: { value: 0 }, uTonemap: { value: 1 }, uLUTStrength: { value: 0.7 },
        uSat: { value: 1 }, uContrast: { value: 1 }, uLift: { value: 0 }, uGamma: { value: 1 }, uGain: { value: 1 }, uBloomOnly: { value: 0 } }),
      fxaa: new FSPass(SH.FXAA_FS, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() } }),
      cas: new FSPass(SH.CAS_FS, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uSharp: { value: 0.4 } }),
      lens: new FSPass(SH.LENS_FS, { tColor: { value: null }, tDrops: { value: null }, uTime: shared.uTime, uAspect: { value: 1.7 }, uDist: { value: 1 }, uDistAmt: { value: 0.06 },
        uCA: { value: 1 }, uCAStr: { value: 0.35 }, uDrops: { value: 1 }, uVig: { value: 1 }, uVigStr: { value: 0.45 }, uGrain: { value: 1 }, uGrainStr: { value: 0.05 } }),
      style: new FSPass(SH.STYLE_FS, { tColor: { value: null }, uOutRes: { value: new THREE.Vector2() }, uTime: shared.uTime, uCRT: { value: 0 }, uScan: { value: 0.35 }, uCurve: { value: 0.15 },
        uDither: { value: 1 }, uGlitch: { value: 0 }, uPixel: { value: 0 }, uPixelSize: { value: 4 } }),
      debug: new FSPass(SH.DEBUG_FS, { ...D, ...N, tView: { value: null }, uMode: { value: 0 }, uCamWorld: cam.uCamWorld, uPrevVP: cam.uPrevVP }),
      copy: new FSPass(SH.COPY_FS, { tColor: { value: null } }),
    };
    this.smaa = new SMAAPass();
    this.droplets = new LensDroplets(96);
    this.luts = {};
    this.mirrorCam = new THREE.PerspectiveCamera();
    this.frame = 0;
    this.prevVP = new THREE.Matrix4();
    this.unjitteredProj = new THREE.Matrix4();
    this.size = { w: 0, h: 0, ow: 0, oh: 0, half: true };
    this.historyValid = false;
  }

  lut(name) { return this.luts[name] || (this.luts[name] = makeLUT(name)); }

  setSize(w, h, outW, outH, { halfRes, particleScale }) {
    const s = this.size;
    if (s.w === w && s.h === h && s.ow === outW && s.oh === outH && s.half === halfRes && s.ps === particleScale) return;
    Object.assign(s, { w, h, ow: outW, oh: outH, half: halfRes, ps: particleScale });
    for (const k of Object.keys(this.t || {})) { const v = this.t[k]; (Array.isArray(v) ? v : [v]).forEach((x) => x.dispose()); }
    const hw = Math.ceil(w / 2), hh = Math.ceil(h / 2), qw = Math.ceil(w / 4), qh = Math.ceil(h / 4);
    const ew = halfRes ? hw : w, eh = halfRes ? hh : h;
    const scene = rt(w, h, { count: 2, depth: true });
    scene.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    scene.depthTexture.minFilter = scene.depthTexture.magFilter = THREE.NearestFilter;
    this.t = {
      scene,
      planar: rt(hw, hh, { depth: true }),
      part: rt(Math.ceil(w * particleScale), Math.ceil(h * particleScale)),
      ao: rt(ew, eh, { type: THREE.UnsignedByteType }),
      ssr: rt(ew, eh),
      gi: rt(qw, qh),
      fog: rt(hw, hh),
      god: rt(qw, qh),
      hdrA: rt(w, h), hdrB: rt(w, h),
      hist: [rt(w, h), rt(w, h)],
      dof: rt(hw, hh), dofPrep: rt(hw, hh),
      bloom: [], bloomUp: [],
      streakA: rt(qw, qh), streakB: rt(qw, qh),
      flare: rt(qw, qh),
      lum: [rt(64, 64, { type: THREE.FloatType }), rt(16, 16, { type: THREE.FloatType }), rt(4, 4, { type: THREE.FloatType }), rt(1, 1, { type: THREE.FloatType })],
      adapt: [rt(1, 1, { type: THREE.FloatType, filter: THREE.NearestFilter }), rt(1, 1, { type: THREE.FloatType, filter: THREE.NearestFilter })],
      ldrA: rt(w, h, { type: THREE.UnsignedByteType }), ldrB: rt(w, h, { type: THREE.UnsignedByteType }),
    };
    let bw = hw, bh = hh;
    for (let i = 0; i < 7; i++) { this.t.bloom.push(rt(bw, bh)); this.t.bloomUp.push(rt(bw, bh)); bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1); }
    this.smaa.setSize(w, h);
    this.historyValid = false;
    this.adaptIdx = 0;
    this._adaptReset = true;
  }

  pass(p, target) {
    this.quad.material = p.material;
    this.r.setRenderTarget(target);
    this.r.render(this.quadScene, this.quadCam);
  }
  timed(name, fn) { this.perf.time(name, fn); }

  // TAA jitter — call before rendering, after camera.updateProjectionMatrix()
  jitter(camera, enabled) {
    this.unjitteredProj.copy(camera.projectionMatrix);
    if (!enabled) return;
    const [jx, jy] = HALTON[this.frame % 8];
    camera.projectionMatrix.elements[8] += (jx * 2) / this.size.w;
    camera.projectionMatrix.elements[9] += (jy * 2) / this.size.h;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }

  renderPlanar(layers, camera, planeNormal, planePoint) {
    const mc = this.mirrorCam;
    const n = planeNormal, cp = camera.position;
    const view = planePoint.clone().sub(cp);
    if (view.dot(n) > 0) return false;
    view.reflect(n).negate().add(planePoint);
    const rot = new THREE.Matrix4().extractRotation(camera.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(cp);
    const target = planePoint.clone().sub(look).reflect(n).negate().add(planePoint);
    mc.position.copy(view);
    mc.up.set(0, 1, 0).applyMatrix4(rot).reflect(n);
    mc.lookAt(target);
    mc.near = camera.near; mc.far = camera.far;
    mc.updateMatrixWorld();
    mc.projectionMatrix.copy(this.unjitteredProj);
    // oblique near plane clipping (as in three's Reflector)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, planePoint).applyMatrix4(mc.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const e = mc.projectionMatrix.elements;
    const q = new THREE.Vector4((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    clip.multiplyScalar(2 / clip.dot(q));
    e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1; e[14] = clip.w;
    mc.projectionMatrixInverse.copy(mc.projectionMatrix).invert();
    this.r.setRenderTarget(this.t.planar);
    this.r.clear();
    for (const L of layers) if (L.visible && L.reflect) this.r.render(L.scene, mc);
    this.p.composite.u.uMirrorVP.value.multiplyMatrices(this.unjitteredProj, mc.matrixWorldInverse);
    return true;
  }

  render(f) {
    const { camera, s, layers, particles, cones, dt, speedN, glitch, ballPos, wind, weather, debugMode } = f;
    const r = this.r, t = this.t, P = this.p;
    this.frame++;
    r.autoClear = false;
    r.setClearColor(0x000000, 0);

    // shared depth uniforms
    this.depthU.tDepth.value = t.scene.depthTexture;
    this.depthU.uInvProj.value.copy(camera.projectionMatrixInverse);
    this.depthU.uProj.value.copy(camera.projectionMatrix);
    this.depthU.uNearFar.value.set(camera.near, camera.far);
    this.camU.uCamWorld.value.copy(camera.matrixWorld);
    this.camU.uPrevVP.value.copy(this.prevVP);
    const sceneColor = t.scene.textures[0], sceneNormal = t.scene.textures[1];
    for (const p of Object.values(P)) if (p.u.tNormal) p.u.tNormal.value = sceneNormal;

    // 1) world → MRT g-buffer, one layer at a time so each system is timed separately
    r.setRenderTarget(t.scene);
    r.clear(true, true, false);
    for (const L of layers) if (L.visible) this.timed(L.name, () => r.render(L.scene, camera));

    // 2) planar reflection fallback
    const refl = s.reflections ? s.reflectionQuality : 'off';
    const reflMode = refl === 'off' ? 0 : (refl === 'planar' ? 1 : 2);
    let planarOK = false;
    if (reflMode === 1) this.timed('planar reflection', () => { planarOK = this.renderPlanar(layers, camera, f.planeNormal, f.planePoint); });

    // 3) particles → premultiplied buffer
    r.setRenderTarget(t.part);
    r.clear(true, false, false);
    for (const [name, sys] of Object.entries(particles.systems)) {
      if (!sys.enabled) continue;
      sys.mat.uniforms.uRes.value.set(t.part.width, t.part.height);
      this.timed('particles: ' + name, () => r.render(sys.scene, camera));
    }
    if (particles.cpu.enabled && particles.cpu.list.length) {
      particles.cpu.mat.uniforms.uRes.value.set(t.part.width, t.part.height);
      this.timed('particles: splash/ball dust', () => r.render(particles.cpu.scene, camera));
    }
    if (cones.visible) this.timed('searchlight cones (fallback)', () => r.render(cones.scene, camera));

    // 4) AO / SSR / GI
    if (s.ao) this.timed('ao', () => {
      P.ao.u.uRadius.value = s.aoRadius; P.ao.u.uIntensity.value = s.aoIntensity; P.ao.u.uSamples.value = s.aoSamples; P.ao.u.uFrame.value = this.frame % 64;
      this.pass(P.ao, t.ao);
    });
    if (reflMode === 2) this.timed('ssr', () => {
      P.ssr.u.tColor.value = sceneColor; P.ssr.u.uSteps.value = refl === 'ssr-high' ? Math.max(s.ssrSteps, 48) : s.ssrSteps; P.ssr.u.uFrame.value = this.frame % 64;
      this.pass(P.ssr, t.ssr);
    });
    if (s.gi) this.timed('ssgi', () => { P.gi.u.tColor.value = sceneColor; P.gi.u.uFrame.value = this.frame % 64; this.pass(P.gi, t.gi); });

    // 5) fog / volumetric shafts, god rays
    const fogOn = s.fog || s.volumetric;
    if (fogOn) this.timed(s.volumetric ? 'volumetric fog' : 'height fog', () => {
      const u = P.fog.u; u.uSteps.value = s.fogSteps; u.uFrame.value = this.frame % 64; u.uVolStrength.value = s.volStrength;
      u.uGlow.value = weather.glow; u.uVolumetric.value = s.volumetric ? 1 : 0; u.uFogOn.value = s.fog ? 1 : 0.35;
      this.pass(P.fog, t.fog);
    });
    if (s.godrays) this.timed('god rays', () => {
      const u = P.god.u; u.tColor.value = sceneColor;
      // source: lightning strike when flashing, otherwise the smog glow on the horizon ahead
      const az = weather.lightning > 0.05 ? weather.lightningAz : 0;
      const dir = new THREE.Vector3(Math.sin(az), 0.08, -Math.cos(az)).multiplyScalar(800).add(camera.position);
      const pr = dir.project(camera);
      u.uSun.value.set(pr.x * 0.5 + 0.5, pr.y * 0.5 + 0.5);
      u.uVisible.value = pr.z < 1 ? 1 : 0;
      u.uStrength.value = s.godrayStrength * (0.6 + weather.lightning * 3);
      this.pass(P.god, t.god);
    });

    // 6) composite
    this.timed('composite', () => {
      const u = P.composite.u;
      u.tColor.value = sceneColor; u.tAO.value = t.ao.texture; u.tSSR.value = t.ssr.texture; u.tPlanar.value = t.planar.texture; u.tGI.value = t.gi.texture;
      u.tFog.value = t.fog.texture; u.tGod.value = t.god.texture; u.tPart.value = t.part.texture;
      u.uAO.value = s.ao ? 1 : 0; u.uRefl.value = reflMode === 1 && !planarOK ? 0 : reflMode; u.uGI.value = s.gi ? 1 : 0;
      u.uFog.value = fogOn ? 1 : 0; u.uGod.value = s.godrays ? 1 : 0; u.uHaze.value = s.haze ? 1 : 0;
      u.uReflStrength.value = s.reflStrength; u.uGIStrength.value = s.giStrength; u.uHazeStrength.value = s.hazeStrength;
      u.uTexel.value.set(1 / t.ao.width, 1 / t.ao.height);
      this.pass(P.composite, t.hdrA);
    });
    let cur = t.hdrA, spare = t.hdrB;

    // 7) TAA
    if (s.aa === 'taa') this.timed('taa', () => {
      const h = t.hist, dst = h[this.frame & 1], src = h[(this.frame + 1) & 1];
      const u = P.taa.u; u.tCurrent.value = cur.texture; u.tHistory.value = src.texture; u.uTexel.value.set(1 / t.hdrA.width, 1 / t.hdrA.height);
      u.uReset.value = this.historyValid ? 0 : 1;
      this.pass(P.taa, dst);
      this.historyValid = true;
      cur = dst;
    }); else this.historyValid = false;

    // 8) heat haze + motion blur + radial speed blur
    const mbOn = s.motionBlur, radOn = s.radialBlur && speedN > 0.02, hazeOn = s.heatHaze;
    if (mbOn || radOn || hazeOn) this.timed('motion (blur/radial/haze)', () => {
      const u = P.motion.u; u.tColor.value = cur.texture;
      u.uMB.value = mbOn ? 1 : 0; u.uMBStrength.value = s.mbStrength * (0.3 + speedN); u.uMBSamples.value = s.mbSamples;
      u.uRadial.value = radOn ? 1 : 0; u.uRadialStrength.value = s.radialStrength * speedN * speedN;
      const c = ballPos.clone().add(new THREE.Vector3(0, -60 * 0.19, -60)).project(camera);
      u.uCenter.value.set(c.x * 0.5 + 0.5, c.y * 0.5 + 0.5);
      u.uHaze.value = hazeOn ? 1 : 0; u.uHazeStrength.value = s.heatHazeStrength;
      const dst = cur === t.hdrA ? t.hdrB : t.hdrA;
      this.pass(P.motion, dst); cur = dst;
    });

    // 9) DOF
    if (s.dof) this.timed('dof', () => {
      const focus = camera.position.distanceTo(ballPos);
      const scaleBlur = s.dofMaxBlur * (t.dof.height / 540);
      P.dofPrep.u.uFocus.value = focus; P.dofPrep.u.uAperture.value = s.dofAperture; P.dofPrep.u.tColor.value = cur.texture;
      this.pass(P.dofPrep, t.dofPrep);
      P.dofBlur.u.tPrep.value = t.dofPrep.texture; P.dofBlur.u.uMaxBlur.value = scaleBlur;
      P.dofBlur.u.uSamples.value = s.dofSamples; P.dofBlur.u.uTexel.value.set(1 / t.dof.width, 1 / t.dof.height);
      this.pass(P.dofBlur, t.dof);
      P.dofComp.u.tColor.value = cur.texture; P.dofComp.u.tBlur.value = t.dof.texture; P.dofComp.u.tPrep.value = t.dofPrep.texture;
      const dst = cur === t.hdrA ? t.hdrB : t.hdrA;
      this.pass(P.dofComp, dst); cur = dst;
    });
    spare = cur === t.hdrA ? t.hdrB : t.hdrA;

    // 10) bloom pyramid (+ streaks, flare); halation and dirt reuse the low mips in grade
    const mips = s.bloomMips;
    const needBloom = s.bloom || s.streaks || s.flare || s.halation || s.dirt;
    if (needBloom) this.timed('bloom', () => {
      const B = t.bloom, U = t.bloomUp;
      P.bright.u.tColor.value = cur.texture; P.bright.u.tMask.value = sceneNormal;
      P.bright.u.uThreshold.value = s.bloomThreshold; P.bright.u.uSelective.value = s.bloomSelective;
      P.bright.u.uTexel.value.set(1 / cur.width, 1 / cur.height);
      this.pass(P.bright, B[0]);
      for (let i = 1; i < mips; i++) { P.down.u.tColor.value = B[i - 1].texture; P.down.u.uTexel.value.set(1 / B[i - 1].width, 1 / B[i - 1].height); this.pass(P.down, B[i]); }
      let low = B[mips - 1];
      for (let i = mips - 2; i >= 0; i--) {
        P.up.u.tColor.value = B[i].texture; P.up.u.tLow.value = low.texture; P.up.u.uTexel.value.set(1 / low.width, 1 / low.height); P.up.u.uRadius.value = s.bloomRadius;
        this.pass(P.up, U[i]); low = U[i];
      }
    });
    if (s.streaks) this.timed('anamorphic streaks', () => {
      const len = s.streakLength;
      P.streak.u.tColor.value = t.bloom[1].texture; P.streak.u.uTexel.value.set(1 / t.streakA.width, 1 / t.streakA.height);
      let a = t.streakA, b = t.streakB;
      for (let i = 0; i < 4; i++) {
        P.streak.u.uSpread.value = Math.pow(3.2, i) * len;
        this.pass(P.streak, a); P.streak.u.tColor.value = a.texture; [a, b] = [b, a];
      }
      this.streakTex = b.texture;
    });
    if (s.flare) this.timed('lens flare', () => { P.flare.u.tColor.value = t.bloom[2].texture; P.flare.u.uGhosts.value = s.flareGhosts; this.pass(P.flare, t.flare); });

    // 11) auto exposure
    if (s.autoExposure) this.timed('auto exposure', () => {
      let src = cur;
      for (let i = 0; i < 4; i++) {
        P.lum.u.tColor.value = src.texture; P.lum.u.uFirst.value = i === 0 ? 1 : 0; P.lum.u.uTexel.value.set(1 / src.width, 1 / src.height);
        this.pass(P.lum, t.lum[i]); src = t.lum[i];
      }
      const a = t.adapt[this.adaptIdx], b = t.adapt[1 - this.adaptIdx];
      P.adapt.u.tPrev.value = a.texture; P.adapt.u.tCur.value = t.lum[3].texture;
      P.adapt.u.uRate.value = this._adaptReset ? 1 : 1 - Math.exp(-dt * s.aeSpeed);
      this._adaptReset = false;
      this.pass(P.adapt, b); this.adaptIdx = 1 - this.adaptIdx;
    });

    // 12) grade + tonemap → LDR
    this.timed('tonemap/grade', () => {
      const u = P.grade.u;
      u.tColor.value = cur.texture; u.tBloom.value = mips > 1 ? t.bloomUp[0].texture : t.bloom[0].texture;
      u.tStreak.value = this.streakTex || t.streakA.texture; u.tFlare.value = t.flare.texture;
      u.tBloomLow.value = t.bloomUp[Math.min(3, mips - 2)]?.texture || t.bloom[0].texture;
      u.tAdapt.value = t.adapt[this.adaptIdx].texture; u.tLUT.value = this.lut(s.lut);
      u.uBloom.value = s.bloom ? 1 : 0; u.uStreak.value = s.streaks ? 1 : 0; u.uFlare.value = s.flare ? 1 : 0; u.uHalation.value = s.halation ? 1 : 0; u.uDirt.value = s.dirt ? 1 : 0;
      u.uBloomStrength.value = s.bloomStrength; u.uStreakStrength.value = s.streakStrength; u.uFlareStrength.value = s.flareStrength;
      u.uHalationStrength.value = s.halationStrength; u.uDirtStrength.value = s.dirtStrength;
      u.uAE.value = s.autoExposure ? 1 : 0; u.uExposure.value = s.exposure;
      u.uTonemap.value = { aces: 0, agx: 1, filmic: 2, reinhard: 3 }[s.tonemapper];
      u.uLUTStrength.value = s.lutStrength; u.uSat.value = s.saturation; u.uContrast.value = s.contrast;
      u.uLift.value = s.lift; u.uGamma.value = s.gamma; u.uGain.value = s.gain;
      u.uBloomOnly.value = debugMode === 'bloom' ? 1 : 0;
      this.pass(P.grade, t.ldrA);
    });
    let ld = t.ldrA, ls = t.ldrB;
    const swapL = () => { [ld, ls] = [ls, ld]; };

    // 13) spatial AA + CAS
    if (s.aa === 'fxaa') this.timed('fxaa', () => { P.fxaa.u.tColor.value = ld.texture; P.fxaa.u.uTexel.value.set(1 / ld.width, 1 / ld.height); this.pass(P.fxaa, ls); swapL(); });
    else if (s.aa === 'smaa') this.timed('smaa', () => { this.smaa.render(r, ls, ld); swapL(); });
    if (s.cas) this.timed('cas', () => { P.cas.u.tColor.value = ld.texture; P.cas.u.uTexel.value.set(1 / ld.width, 1 / ld.height); P.cas.u.uSharp.value = s.casStrength; this.pass(P.cas, ls); swapL(); });

    // 14) lens droplets
    const dropsOn = s.lensDroplets && f.dropletAmount > 0.001;
    this.droplets.update(dt, { amount: dropsOn ? f.dropletAmount : 0, density: s.dropletDensity, speedN, wind, camera, aspect: this.size.ow / this.size.oh });
    if (dropsOn || this.droplets.list.length) this.timed('lens droplets', () => this.droplets.render(r));

    // 15) lens
    const lensOn = s.distortion || s.ca || s.vignette || s.grain || dropsOn;
    if (lensOn) this.timed('lens (dist/CA/vig/grain/drops)', () => {
      const u = P.lens.u; u.tColor.value = ld.texture; u.tDrops.value = this.droplets.rt.texture; u.uAspect.value = this.size.ow / this.size.oh;
      u.uDist.value = s.distortion ? 1 : 0; u.uDistAmt.value = s.distortionAmt; u.uCA.value = s.ca ? 1 : 0; u.uCAStr.value = s.caStrength;
      u.uDrops.value = this.droplets.list.length ? 1 : 0; u.uVig.value = s.vignette ? 1 : 0; u.uVigStr.value = s.vignetteStrength;
      u.uGrain.value = s.grain ? 1 : 0; u.uGrainStr.value = s.grainStrength;
      this.pass(P.lens, ls); swapL();
    });

    // 16) style + output to screen (or a debug buffer)
    if (debugMode !== 'final' && debugMode !== 'bloom') {
      const modes = { depth: 1, normal: 2, velocity: 3, ao: 5, ssr: 6, fog: 7, particles: 4 };
      const views = { ao: t.ao, ssr: t.ssr, fog: t.fog, particles: t.part };
      P.debug.u.uMode.value = modes[debugMode] || 0;
      P.debug.u.tView.value = (views[debugMode] || t.hdrA).texture;
      this.pass(P.debug, null);
    } else this.timed('style/output', () => {
      const u = P.style.u; u.tColor.value = ld.texture; u.uOutRes.value.set(this.size.ow, this.size.oh);
      u.uCRT.value = s.scanlines ? 1 : 0; u.uScan.value = s.scanlineStrength; u.uCurve.value = s.crtCurve;
      u.uDither.value = s.dither ? 1 : 0;
      u.uGlitch.value = s.glitch === 'always' ? 0.25 * s.glitchStrength : (s.glitch === 'death' ? glitch * s.glitchStrength : 0);
      u.uPixel.value = s.pixelate ? 1 : 0; u.uPixelSize.value = s.pixelSize;
      this.pass(P.style, null);
    });

    // remember this frame's unjittered view-projection for reprojection next frame
    this.prevVP.multiplyMatrices(this.unjitteredProj, camera.matrixWorldInverse);
  }
}
