import * as THREE from 'three';
import { HASH, WIND, PALETTE, FOG } from '../gfx/glsl.js';
import { VOLUME_GLSL, MAX_EMIT, MAX_VENTS } from './dystopia.js';

// All particle systems render into a separate (optionally lower-res) premultiplied
// buffer with soft depth fade against the scene depth, then get composited after
// fog — so they self-fog correctly instead of being fogged as background.
// Each system is its own Scene so it can be timed / toggled independently.

const PHEADER = HASH + WIND + PALETTE + FOG + VOLUME_GLSL + /* glsl */`
uniform vec3 uCamPos; uniform vec3 uBoxCenter; uniform vec3 uBoxSize; uniform float uAmount; uniform float uLightning;
attribute vec4 aSeed; attribute vec4 aSeed2;
varying vec2 vUv; varying vec4 vCol; varying float vViewZ;
vec3 wrapBox(vec3 p){ vec3 mn = uBoxCenter - uBoxSize * 0.5; return mn + mod(p - mn, uBoxSize); }
`;
const PFRAG = /* glsl */`
layout(location = 0) out highp vec4 pColor;
uniform sampler2D uDepth; uniform vec2 uRes; uniform vec2 uNearFar;
varying vec2 vUv; varying vec4 vCol; varying float vViewZ;
float sceneViewZ(){
  float d = texture(uDepth, gl_FragCoord.xy / uRes).r;
  float n = uNearFar.x, f = uNearFar.y;
  return (n * f) / ((f - n) * d - f);
}
float softFade(float k){ return clamp((vViewZ - sceneViewZ()) * k, 0.0, 1.0); }
`;

function quadGeometry(maxCount) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const s1 = new Float32Array(maxCount * 4), s2 = new Float32Array(maxCount * 4);
  for (let i = 0; i < s1.length; i++) { s1[i] = Math.random(); s2[i] = Math.random(); }
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(s1, 4));
  g.setAttribute('aSeed2', new THREE.InstancedBufferAttribute(s2, 4));
  g.instanceCount = maxCount;
  return g;
}

function pMaterial(shared, extraUniforms, vs, fs, additive) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...shared, ...extraUniforms },
    vertexShader: PHEADER + vs,
    fragmentShader: HASH + PFRAG + fs,
    transparent: true, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: additive ? THREE.ZeroFactor : THREE.OneFactor, blendDstAlpha: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
  });
}

// camera-facing billboard corner from centre
const BILLBOARD = /* glsl */`
vec3 billboard(vec3 c, float size, float rot){
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec2 q = vec2(position.x, position.y - 0.5);
  float cs = cos(rot), sn = sin(rot); q = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);
  return c + (right * q.x + up * q.y) * size;
}
void emit(vec3 wp, vec3 col, float alpha){
  vec4 mv = viewMatrix * vec4(wp, 1.0); vViewZ = mv.z;
  float fog = fogAmountTo(uCamPos, wp);
  vCol = vec4(mix(col, uFogColor * 0.4 * alpha, fog), alpha * (1.0 - fog * 0.6));
  gl_Position = projectionMatrix * mv;
}`;

const SYSTEMS = {
  // ---------------------------------------------------------------- rain
  rain: { max: 9000, additive: true, box: [44, 34, 70], ahead: 22, uniforms: {},
    vs: BILLBOARD + /* glsl */`
void main(){
  vUv = uv;
  if (aSeed2.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float fall = 11.0 + aSeed2.x * 5.0;
  vec3 p0 = aSeed.xyz * uBoxSize;
  vec3 p = wrapBox(p0 + vec3(0.0, -fall * uTime, 0.0) + uWindOffset + curlNoise(p0 * 0.035) * uTurbulence * 0.6);
  vec3 vel = vec3(0.0, -fall, 0.0) + windAt(p);
  vec3 axis = normalize(vel);
  vec3 toCam = normalize(uCamPos - p);
  vec3 side = normalize(cross(axis, toCam));
  float len = 0.35 + length(vel) * 0.045;
  vec3 wp = p + side * position.x * 0.018 * (1.0 + aSeed2.y) + axis * position.y * len;
  float light = 0.25 + uLightning * 2.0;
  emit(wp, (uFogColor * 0.6 + uSmog * 0.25 + vec3(0.5, 0.6, 0.7) * light) * 0.45, 0.0);
}`,
    fs: /* glsl */`
void main(){
  float a = smoothstep(0.0, 0.5, vUv.y) * (1.0 - smoothstep(0.5, 1.0, vUv.y)) * (1.0 - abs(vUv.x - 0.5) * 2.0);
  pColor = vec4(vCol.rgb * a * softFade(2.0), 0.0);
}` },

  // ---------------------------------------------------------------- dust motes + storm dust
  dust: { max: 5000, additive: false, box: [40, 24, 50], ahead: 15, uniforms: { uStorm: { value: 0 } },
    vs: BILLBOARD + /* glsl */`
uniform float uStorm;
void main(){
  vUv = uv;
  if (aSeed2.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 p0 = aSeed.xyz * uBoxSize;
  vec3 p = wrapBox(p0 + uWindOffset * (0.6 + aSeed2.x * 0.8) + curlNoise(p0 * 0.05 + uTime * 0.05) * 3.0 * uTurbulence);
  vec3 shaft = coneLight(p);
  float sh = clamp(dot(shaft, vec3(0.33)) * 1.6, 0.0, 1.0);
  float storm = uStorm * step(aSeed2.y, 0.75);
  vec3 col = shaft * 0.9 + vec3(0.55, 0.38, 0.22) * storm * (0.15 + uLightning);
  float alpha = max(sh * 0.9, storm * 0.35);
  float size = mix(0.035, 0.2, storm) * (0.6 + aSeed2.z);
  if (alpha < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  emit(billboard(p, size, aSeed.w * 6.28), col * alpha, alpha);
}`,
    fs: /* glsl */`
void main(){ float r = length(vUv - 0.5) * 2.0; float a = (1.0 - smoothstep(0.3, 1.0, r)) * softFade(3.0);
  pColor = vec4(vCol.rgb, vCol.a) * a; }` },

  // ---------------------------------------------------------------- ash
  ash: { max: 4000, additive: false, box: [40, 26, 50], ahead: 15, uniforms: {},
    vs: BILLBOARD + /* glsl */`
void main(){
  vUv = uv;
  if (aSeed2.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float fall = 0.9 + aSeed2.x * 0.8;
  vec3 p0 = aSeed.xyz * uBoxSize;
  vec3 p = wrapBox(p0 + vec3(0.0, -fall * uTime, 0.0) + uWindOffset * 0.9 + curlNoise(p0 * 0.06 + uTime * 0.03) * 2.0 * uTurbulence);
  float glowing = step(0.93, aSeed2.y);
  vec3 col = mix(vec3(0.05, 0.05, 0.055) + uSmog * 0.03, vec3(3.0, 0.8, 0.2) * (0.6 + 0.4 * sin(uTime * 5.0 + aSeed.w * 30.0)), glowing);
  emit(billboard(p, 0.05 + aSeed2.z * 0.05, uTime * (aSeed.w - 0.5) * 4.0), col * 0.8, 0.8);
}`,
    fs: /* glsl */`
void main(){ vec2 q = abs(vUv - 0.5) * 2.0; float a = (1.0 - smoothstep(0.6, 1.0, max(q.x, q.y * 1.4))) * softFade(3.0);
  pColor = vec4(vCol.rgb, vCol.a) * a; }` },

  // ---------------------------------------------------------------- tumbling paper / trash
  debris: { max: 400, additive: false, box: [50, 18, 60], ahead: 18, uniforms: {},
    vs: /* glsl */`
void emit2(vec3 wp, vec3 col, float alpha){
  vec4 mv = viewMatrix * vec4(wp, 1.0); vViewZ = mv.z;
  float fog = fogAmountTo(uCamPos, wp);
  vCol = vec4(mix(col, uFogColor * 0.4 * alpha, fog), alpha);
  gl_Position = projectionMatrix * mv;
}
mat3 rotAxis(vec3 a, float r){ float c = cos(r), s = sin(r), t = 1.0 - c; a = normalize(a);
  return mat3(t*a.x*a.x + c, t*a.x*a.y + s*a.z, t*a.x*a.z - s*a.y, t*a.x*a.y - s*a.z, t*a.y*a.y + c, t*a.y*a.z + s*a.x, t*a.x*a.z + s*a.y, t*a.y*a.z - s*a.x, t*a.z*a.z + c); }
void main(){
  vUv = uv;
  if (aSeed2.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 p0 = aSeed.xyz * uBoxSize;
  vec3 p = wrapBox(p0 + uWindOffset * (1.2 + aSeed2.x) + curlNoise(p0 * 0.05 + uTime * 0.1) * 4.0 * uTurbulence);
  // keep debris low: gusts lift it, gravity settles it near the deck
  p.y = uBoxCenter.y - uBoxSize.y * 0.5 + mod(p.y, 3.0 + uGust * 12.0);
  float spin = uTime * (2.0 + aSeed2.y * 6.0) * (0.3 + uGust + uWindStrength * 0.08);
  mat3 R = rotAxis(aSeed.wzy - 0.5, spin);
  vec2 sz = vec2(0.25 + aSeed2.z * 0.25, 0.3 + aSeed2.y * 0.2);
  vec3 lp = R * vec3(position.x * sz.x, (position.y - 0.5) * sz.y, 0.0);
  vec3 nrm = R * vec3(0.0, 0.0, 1.0);
  float lit = 0.3 + 0.7 * abs(dot(nrm, normalize(vec3(0.3, 1.0, 0.2))));
  vec3 col = mix(vec3(0.5, 0.48, 0.42), vec3(0.25, 0.27, 0.3), step(0.5, aSeed2.x)) * lit * (0.08 + uLightning * 0.6) + uSmog * 0.02;
  emit2(p + lp, col, 0.95);
}`,
    fs: /* glsl */`
void main(){ pColor = vec4(vCol.rgb, vCol.a) * softFade(4.0); }` },

  // ---------------------------------------------------------------- embers / sparks from broken fixtures
  embers: { max: 1600, additive: true, box: null, uniforms: {},
    vs: BILLBOARD + /* glsl */`
uniform vec4 uEmit[${MAX_EMIT}];
void main(){
  vUv = uv;
  if (aSeed2.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  int ei = int(aSeed.x * ${MAX_EMIT}.0);
  vec4 e = uEmit[ei];
  float life = 0.8 + aSeed2.x * 1.4;
  float age = fract(uTime / life + aSeed.y) * life;
  vec3 v0 = (vec3(aSeed.z, aSeed.w, aSeed2.y) - 0.5) * vec3(5.0, 3.0, 5.0) + vec3(0.0, 1.5, 0.0);
  vec3 w = windAt(e.xyz);
  vec3 p = e.xyz + v0 * age + vec3(0.0, -6.0, 0.0) * age * age + w * age * 0.6;
  float heat = 1.0 - age / life;
  vec3 col = vec3(4.0, 1.4, 0.35) * heat * heat * e.w;
  vec3 vel = v0 + vec3(0.0, -12.0, 0.0) * age + w * 0.6;
  // stretch along velocity for spark streaks
  vec3 axis = normalize(vel); vec3 side = normalize(cross(axis, normalize(uCamPos - p)));
  vec3 wp = p + side * position.x * 0.03 + axis * position.y * (0.05 + length(vel) * 0.03);
  emit(wp, col, 0.0);
}`,
    fs: /* glsl */`
void main(){ float a = 1.0 - abs(vUv.x - 0.5) * 2.0; pColor = vec4(vCol.rgb * a, 0.0); }` },

  // ---------------------------------------------------------------- steam from vents
  steam: { max: 600, additive: false, box: null, uniforms: {},
    vs: BILLBOARD + /* glsl */`
uniform vec4 uVents[${MAX_VENTS}];
void main(){
  vUv = uv;
  if (aSeed2.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  int vi = int(aSeed.x * ${MAX_VENTS}.0);
  vec4 v = uVents[vi];
  float life = 3.0 + aSeed2.x * 2.5;
  float age = fract(uTime / life + aSeed.y) * life; float k = age / life;
  vec3 w = windAt(v.xyz + vec3(0.0, age, 0.0));
  vec3 p = v.xyz + vec3((aSeed.z - 0.5) * 0.6, age * 1.8, (aSeed.w - 0.5) * 0.6) + w * age * 0.5;
  float size = v.w * (0.6 + k * 3.5);
  float alpha = smoothstep(0.0, 0.1, k) * (1.0 - k) * 0.22;
  vec3 col = (uFogColor * 0.35 + uSmog * 0.1 + uNeon * 0.04) * (1.0 + uLightning * 3.0);
  emit(billboard(p, size, aSeed2.y * 6.28 + age * 0.3), col * alpha, alpha);
}`,
    fs: /* glsl */`
void main(){ float r = length(vUv - 0.5) * 2.0; float n = fbm2(vUv * 3.0 + vCol.a * 10.0);
  float a = (1.0 - smoothstep(0.2, 1.0, r)) * (0.5 + n) * softFade(0.8);
  pColor = vec4(vCol.rgb, vCol.a) * a; }` },
};

// CPU-pooled systems (splash droplets + ball dust) share one renderer.
const CPU_VS = /* glsl */ BILLBOARD.replace('void emit', 'void emitUnused') + /* glsl */`
attribute vec4 aPos;  // xyz, size
attribute vec4 aCol;  // rgb, alpha
void main(){
  vUv = uv;
  if (aPos.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 wp = billboard(aPos.xyz, aPos.w, aSeed.x * 6.28);
  vec4 mv = viewMatrix * vec4(wp, 1.0); vViewZ = mv.z;
  float fog = fogAmountTo(uCamPos, aPos.xyz);
  vCol = vec4(mix(aCol.rgb, uFogColor * 0.4 * aCol.a, fog), aCol.a);
  gl_Position = projectionMatrix * mv;
}`;
const CPU_FS = /* glsl */`
void main(){ float r = length(vUv - 0.5) * 2.0; float a = (1.0 - smoothstep(0.2, 1.0, r)) * softFade(4.0);
  pColor = vec4(vCol.rgb, vCol.a) * a; }`;

export class Particles {
  constructor(shared, depthUniforms) {
    this.systems = {};
    for (const [name, def] of Object.entries(SYSTEMS)) {
      const geo = quadGeometry(def.max);
      const u = { uBoxCenter: { value: new THREE.Vector3() }, uBoxSize: { value: new THREE.Vector3(...(def.box || [1, 1, 1])) }, uAmount: { value: 1 }, ...def.uniforms, ...depthUniforms };
      const mat = pMaterial(shared, u, def.vs, def.fs, def.additive);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(mesh);
      this.systems[name] = { def, geo, mat, mesh, scene, enabled: true };
    }
    // CPU pool
    this.cpuMax = 700;
    const geo = quadGeometry(this.cpuMax);
    this.cpuPos = new Float32Array(this.cpuMax * 4);
    this.cpuCol = new Float32Array(this.cpuMax * 4);
    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(this.cpuPos, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aCol', new THREE.InstancedBufferAttribute(this.cpuCol, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = pMaterial(shared, { uBoxCenter: { value: new THREE.Vector3() }, uBoxSize: { value: new THREE.Vector3(1, 1, 1) }, uAmount: { value: 1 }, ...depthUniforms }, CPU_VS, CPU_FS, false);
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false;
    const scene = new THREE.Scene(); scene.add(mesh);
    this.cpu = { geo, mat, mesh, scene, list: [], enabled: true };
    this.tmp = new THREE.Vector3();
  }

  // amounts: { rain, dust, ash, debris, embers, steam } 0..1+, plus per-system enable + count scale
  update(cam, amounts, enabled, countScale, storm) {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    for (const [name, s] of Object.entries(this.systems)) {
      s.enabled = !!enabled[name] && amounts[name] > 0.001;
      const a = Math.min(1, amounts[name]);
      // seeds are random, so drawing the first N instances *is* the density control —
      // cost scales directly with weather amount × particle-count setting (max = 2× budget)
      s.mat.uniforms.uAmount.value = 1;
      s.geo.instanceCount = Math.max(1, Math.min(s.def.max, Math.ceil(s.def.max * 0.5 * countScale * a)));
      if (s.def.box) s.mat.uniforms.uBoxCenter.value.copy(cam.position).addScaledVector(fwd, s.def.ahead);
      if (name === 'dust') s.mat.uniforms.uStorm.value = storm;
    }
  }

  // splash / dust emission from the ball
  emit(kind, pos, vel, n) {
    for (let i = 0; i < n; i++) {
      if (this.cpu.list.length >= this.cpuMax) this.cpu.list.shift();
      const spread = kind === 'splash' ? 3.5 : 1.6;
      this.cpu.list.push({ kind, p: pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6)),
        v: new THREE.Vector3(vel.x * 0.2 + (Math.random() - 0.5) * spread, (kind === 'splash' ? 2.5 : 0.8) + Math.random() * 2.5, vel.z * 0.15 + (Math.random() - 0.5) * spread),
        age: 0, life: kind === 'splash' ? 0.5 + Math.random() * 0.4 : 1.2 + Math.random() * 1.2, size: kind === 'splash' ? 0.04 + Math.random() * 0.05 : 0.25 + Math.random() * 0.3 });
    }
  }

  stepCPU(dt, wind) {
    const L = this.cpu.list;
    for (let i = L.length - 1; i >= 0; i--) {
      const q = L[i]; q.age += dt;
      if (q.age > q.life) { L.splice(i, 1); continue; }
      wind.at(q.p, this.tmp);
      const drag = q.kind === 'splash' ? 0.5 : 2.0;
      q.v.addScaledVector(this.tmp.sub(q.v), Math.min(1, drag * dt));
      q.v.y -= (q.kind === 'splash' ? 14 : 0.6) * dt;
      q.p.addScaledVector(q.v, dt);
    }
    for (let i = 0; i < this.cpuMax; i++) {
      const q = L[i];
      if (!q) { this.cpuPos[i * 4 + 3] = 0; continue; }
      const k = q.age / q.life;
      const grow = q.kind === 'splash' ? 1 : 1 + k * 3;
      this.cpuPos.set([q.p.x, q.p.y, q.p.z, q.size * grow], i * 4);
      const a = (1 - k) * (q.kind === 'splash' ? 0.9 : 0.25);
      if (q.kind === 'splash') this.cpuCol.set([0.35 * a, 0.42 * a, 0.5 * a, a * 0.6], i * 4);
      else this.cpuCol.set([0.22 * a, 0.18 * a, 0.14 * a, a], i * 4);
    }
    this.cpu.geo.attributes.aPos.needsUpdate = true;
    this.cpu.geo.attributes.aCol.needsUpdate = true;
    this.cpu.geo.instanceCount = Math.max(1, L.length);
  }
}
