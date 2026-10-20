import * as THREE from 'three';
import { worldMaterial, TRACK_W, trackY } from './shared.js';

export const MAX_CONES = 8;
export const MAX_EMIT = 8;
export const MAX_VENTS = 8;

// Searchlight-cone / spark-emitter / steam-vent uniforms, shared by the fog
// pass (volumetric shafts), dust motes (visible only inside shafts), embers and steam.
export function createVolumeUniforms() {
  return {
    uConePos: { value: Array.from({ length: MAX_CONES }, () => new THREE.Vector4()) },
    uConeDir: { value: Array.from({ length: MAX_CONES }, () => new THREE.Vector4()) },
    uConeCol: { value: Array.from({ length: MAX_CONES }, () => new THREE.Vector4()) },
    uConeCount: { value: 0 },
    uEmit: { value: Array.from({ length: MAX_EMIT }, () => new THREE.Vector4()) },
    uVents: { value: Array.from({ length: MAX_VENTS }, () => new THREE.Vector4()) },
  };
}
export const VOLUME_GLSL = /* glsl */`
#define MAX_CONES ${MAX_CONES}
uniform vec4 uConePos[MAX_CONES]; uniform vec4 uConeDir[MAX_CONES]; uniform vec4 uConeCol[MAX_CONES]; uniform int uConeCount;
// radiance scattered toward the eye from searchlight cones at point p
vec3 coneLight(vec3 p){
  vec3 acc = vec3(0.0);
  for (int i = 0; i < MAX_CONES; i++){
    if (i >= uConeCount) break;
    vec3 L = p - uConePos[i].xyz; float d = length(L);
    float c = dot(L / max(d, 1e-3), uConeDir[i].xyz);
    float inCone = smoothstep(uConeDir[i].w, mix(uConeDir[i].w, 1.0, 0.35), c);
    float att = clamp(1.0 - d / uConePos[i].w, 0.0, 1.0);
    acc += uConeCol[i].rgb * uConeCol[i].w * inCone * att * att / (1.0 + d * 0.02);
  }
  return acc;
}`;

// ---------------------------------------------------------------- drones
const DRONE_VS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vL;
void main(){ mat4 m = modelMatrix * instanceMatrix; vL = position; vec4 wp = m * vec4(position,1.0);
  vWorld = wp.xyz; vNormalW = normalize(mat3(m) * normal); gl_Position = projectionMatrix * viewMatrix * wp; }`;
const DRONE_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vL;
void main(){ vec3 n = normalize(vNormalW);
  float blink = step(0.5, fract(uTime * 1.7 + vWorld.x * 0.1));
  float lamp = smoothstep(0.42, 0.5, abs(vL.x));
  vec3 lc = vL.x > 0.0 ? vec3(1.0, 0.05, 0.03) : vec3(0.1, 0.3, 1.0);
  vec3 col = vec3(0.01) * (0.4 + poolLight(vWorld, n)) + lc * lamp * blink * 25.0 + vec3(1.0, 0.95, 0.85) * smoothstep(0.1, 0.0, length(vL.xz)) * step(vL.y, -0.1) * 30.0;
  writeGBuffer(col, 0.1, (viewMatrix * vec4(n, 0.0)).xyz, lamp * blink);
}`;

// ---------------------------------------------------------------- holo billboards
const BB_VS = /* glsl */`
attribute vec4 aB; // seed, hue select, aspect, unused
varying vec2 vUv; varying vec4 vB; varying vec3 vWorld;
void main(){ vUv = uv; vB = aB; mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const BB_FS = /* glsl */`
varying vec2 vUv; varying vec4 vB; varying vec3 vWorld;
uniform float uBillOn;
// abstract glyph: 3x5 segment cell lit from hash bits — never readable text
float glyph(vec2 cellId, vec2 f){
  vec2 g = floor(f * vec2(3.0, 5.0));
  float h = hash12(cellId * 1.37 + g * 7.1 + floor(uTime * 0.7 + hash12(cellId) * 9.0));
  vec2 inner = fract(f * vec2(3.0, 5.0));
  float box = step(0.12, inner.x) * step(inner.x, 0.88) * step(0.1, inner.y) * step(inner.y, 0.9);
  return step(0.45, h) * box;
}
void main(){
  float seed = vB.x; float t = uTime;
  vec2 uv = vUv;
  // interference: horizontal tear + rolling bands
  float tear = step(0.96, hash11(floor(t * 12.0) + seed * 50.0)) * (hash11(floor(uv.y * 18.0) + floor(t * 30.0)) - 0.5) * 0.15;
  uv.x += tear;
  float bands = 0.75 + 0.25 * sin(uv.y * 140.0 + t * 9.0);
  float roll = smoothstep(0.0, 0.05, abs(fract(uv.y - t * 0.15 + seed) - 0.5));
  vec2 grid = vec2(6.0, 3.0) * vec2(vB.z, 1.0);
  vec2 c = floor(uv * grid); vec2 f = fract(uv * grid);
  c.x += floor(t * 0.5 + seed * 10.0);
  float g = glyph(c + seed * 31.0, f * vec2(1.25, 1.1) - vec2(0.12, 0.05));
  // big abstract emblem: rings/bars behind glyphs
  vec2 q = vUv - 0.5; q.x *= vB.z * 0.5;
  float emblem = smoothstep(0.02, 0.0, abs(length(q) - 0.32 - 0.03 * sin(t * 2.0 + seed * 9.0))) * 0.7;
  vec3 a = vB.y < 0.33 ? vec3(0.1, 0.9, 1.0) : (vB.y < 0.66 ? vec3(1.0, 0.15, 0.6) : uNeon);
  vec3 b = vB.y < 0.5 ? vec3(1.0, 0.45, 0.1) : vec3(0.5, 0.3, 1.0);
  float flick = mix(1.0, step(0.25, hash11(floor(t * 20.0) + seed * 9.0)), uFlicker) * mix(0.15, 1.0, uPower);
  vec3 col = (a * g * 4.0 + b * emblem * 3.0 + a * 0.12) * bands * roll * flick;
  // chromatic split on tears
  col.r *= 1.0 + abs(tear) * 20.0;
  float frame = 1.0 - smoothstep(0.0, 0.015, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
  col += a * frame * 3.0 * flick;
  col *= uBillOn;
  writeGBuffer(col, 0.0, vec3(0.0, 0.0, 1.0), clamp(max(g, frame), 0.0, 1.0) * uBillOn);
}`;

// ---------------------------------------------------------------- cables
const CABLE_VS = /* glsl */`
attribute vec3 aA; attribute vec3 aB; attribute float aSag;
varying vec3 vWorld; varying vec3 vNormalW;
void main(){
  float t = position.y + 0.5;                      // 0..1 along the span
  vec3 p = mix(aA, aB, t);
  float sagShape = 4.0 * t * (1.0 - t);
  p.y -= aSag * sagShape;
  // sway: read the shared wind field at the cable point
  vec3 w = windAt(p);
  p += vec3(w.x, 0.0, w.z) * 0.12 * sagShape * (0.8 + 0.2 * sin(uTime * 2.3 + aA.x));
  p.y -= length(w.xz) * 0.03 * sagShape;
  vec3 side = normalize(cross(normalize(aB - aA), vec3(0.0, 1.0, 0.0)));
  p += side * position.x * 0.09 + vec3(0.0, 1.0, 0.0) * position.z * 0.09;
  vWorld = p; vNormalW = normalize(side * position.x + vec3(0.0, 1.0, 0.0) * position.z + 1e-4);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const CABLE_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW;
void main(){ vec3 n = normalize(vNormalW);
  vec3 col = vec3(0.01) + poolLight(vWorld, n) * 0.08 + uSmog * 0.02 + vec3(0.6, 0.7, 1.0) * uLightning * 0.3;
  writeGBuffer(col, 0.0, (viewMatrix * vec4(n, 0.0)).xyz, 0.0);
}`;

export class Dystopia {
  constructor(scene, shared, vol) {
    this.shared = shared; this.vol = vol;
    // drones
    this.droneN = 6;
    const dg = new THREE.BoxGeometry(1.0, 0.25, 0.6);
    this.drones = new THREE.InstancedMesh(dg, worldMaterial({ uniforms: { ...shared }, vertexShader: DRONE_VS, fragmentShader: DRONE_FS }), this.droneN);
    this.drones.frustumCulled = false;
    scene.add(this.drones);
    this.droneState = [];
    // fallback visible cones when volumetrics are off
    const cg = new THREE.ConeGeometry(1, 1, 24, 1, true);
    cg.translate(0, -0.5, 0);
    this.coneMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      uniforms: { uCol: { value: new THREE.Color(1, 0.95, 0.85) } },
      vertexShader: 'varying float vH; varying vec3 vN; varying vec3 vV; void main(){ vH = -position.y; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'layout(location=0) out highp vec4 gColor; uniform vec3 uCol; varying float vH; varying vec3 vN; varying vec3 vV; void main(){ float f = abs(dot(normalize(vN), normalize(vV))); gColor = vec4(uCol * 0.06 * f * f * (1.0 - vH), 0.0); }',
    });
    this.coneMeshes = [];
    this.coneScene = new THREE.Scene();
    for (let i = 0; i < this.droneN; i++) { const m = new THREE.Mesh(cg, this.coneMat); m.frustumCulled = false; this.coneScene.add(m); this.coneMeshes.push(m); }

    // billboards
    this.bbN = 10;
    const bg = new THREE.PlaneGeometry(1, 1);
    this.bbAttr = new Float32Array(this.bbN * 4);
    bg.setAttribute('aB', new THREE.InstancedBufferAttribute(this.bbAttr, 4));
    this.uBillOn = { value: 1 };
    this.billboards = new THREE.InstancedMesh(bg, worldMaterial({ uniforms: { ...shared, uBillOn: this.uBillOn }, vertexShader: BB_VS, fragmentShader: BB_FS, side: THREE.DoubleSide }), this.bbN);
    this.billboards.frustumCulled = false;
    scene.add(this.billboards);
    this.bbState = [];

    // cables
    this.cableN = 36;
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 4, 20, true);
    const cgeo = new THREE.InstancedBufferGeometry();
    cgeo.index = cyl.index; cgeo.attributes.position = cyl.attributes.position; cgeo.attributes.normal = cyl.attributes.normal;
    this.cA = new Float32Array(this.cableN * 3); this.cB = new Float32Array(this.cableN * 3); this.cS = new Float32Array(this.cableN);
    cgeo.setAttribute('aA', new THREE.InstancedBufferAttribute(this.cA, 3));
    cgeo.setAttribute('aB', new THREE.InstancedBufferAttribute(this.cB, 3));
    cgeo.setAttribute('aSag', new THREE.InstancedBufferAttribute(this.cS, 1));
    cgeo.instanceCount = this.cableN;
    this.cables = new THREE.Mesh(cgeo, worldMaterial({ uniforms: { ...shared }, vertexShader: CABLE_VS, fragmentShader: CABLE_FS }));
    this.cables.frustumCulled = false;
    scene.add(this.cables);
    this.cableZ = new Float32Array(this.cableN);

    // broken fixtures (spark emitters) + steam vents: positions only
    this.fixtures = []; this.vents = [];
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.v = new THREE.Vector3(); this.s = new THREE.Vector3();
    this.reset(0);
  }

  reset(z0) {
    this.droneState = Array.from({ length: this.droneN }, (_, i) => this.newDrone(z0 - 60 - i * 70));
    this.bbState = Array.from({ length: this.bbN }, (_, i) => this.newBillboard(i, z0 - 40 - i * 60));
    for (let i = 0; i < this.cableN; i++) this.newCable(i, z0 - i * 28);
    this.fixtures = Array.from({ length: MAX_EMIT }, (_, i) => this.newFixture(z0 - 30 - i * 55));
    this.vents = Array.from({ length: MAX_VENTS }, (_, i) => this.newVent(z0 - 20 - i * 45));
  }

  newDrone(z) {
    return { z, x: (Math.random() - 0.5) * 30, h: 14 + Math.random() * 22, ph: Math.random() * 10, speed: 2 + Math.random() * 6,
      sweep: 0.3 + Math.random() * 0.6, col: Math.random() < 0.7 ? [1, 0.93, 0.8] : (Math.random() < 0.5 ? [1, 0.25, 0.2] : [0.4, 0.6, 1]) };
  }
  newBillboard(i, z) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const w = 6 + Math.random() * 10, h = 3 + Math.random() * 5;
    const st = { z, x: side * (TRACK_W / 2 + 4 + Math.random() * 8), y: 5 + Math.random() * 22, w, h, side, hue: Math.random() };
    this.bbAttr.set([Math.random(), st.hue, w / h, 0], i * 4);
    this.billboards.geometry.attributes.aB.needsUpdate = true;
    return st;
  }
  newCable(i, z) {
    this.cableZ[i] = z;
    const ya = trackY(z) + 8 + Math.random() * 30, yb = ya + (Math.random() - 0.5) * 10;
    const xa = -(TRACK_W / 2 + 6 + Math.random() * 20), xb = TRACK_W / 2 + 6 + Math.random() * 20;
    const zb = z + (Math.random() - 0.5) * 20;
    this.cA.set([xa, ya, z], i * 3); this.cB.set([xb, yb, zb], i * 3); this.cS[i] = 1 + Math.random() * 5;
    const g = this.cables.geometry;
    g.attributes.aA.needsUpdate = g.attributes.aB.needsUpdate = g.attributes.aSag.needsUpdate = true;
  }
  newFixture(z) {
    const side = Math.random() < 0.5 ? -1 : 1;
    return { z, x: side * (TRACK_W / 2 + 6 + Math.random() * 4), y: trackY(z) + 3 + Math.random() * 14, ph: Math.random() * 100 };
  }
  newVent(z) {
    const side = Math.random() < 0.5 ? -1 : 1;
    return { z, x: side * (TRACK_W / 2 + 1.2 + Math.random() * 2.5), y: trackY(z) - 0.6, s: 0.6 + Math.random() * 0.8 };
  }

  update(time, dt, ballZ, cfg, pool) {
    const { drones: dOn, billboards: bOn, cables: cOn, power, flicker, volumetric } = cfg;
    // ---- drones + searchlight cones
    this.drones.visible = dOn;
    let nc = 0;
    for (let i = 0; i < this.droneN; i++) {
      let d = this.droneState[i];
      if (d.z > ballZ + 30) { d = this.droneState[i] = this.newDrone(ballZ - 380 - Math.random() * 200); }
      d.z += d.speed * dt;
      const x = d.x + Math.sin(time * 0.3 + d.ph) * 6;
      const y = trackY(d.z) + d.h + Math.sin(time * 0.8 + d.ph) * 1.2;
      this.v.set(x, y, d.z);
      this.m.compose(this.v, this.q.setFromEuler(new THREE.Euler(0, Math.sin(time * 0.2 + d.ph) * 0.5, 0)), this.s.set(1.8, 1.8, 1.8));
      this.drones.setMatrixAt(i, this.m);
      // searchlight sweeps over the track ahead/below
      const tx = Math.sin(time * d.sweep + d.ph) * 10, tz = d.z - 8 + Math.cos(time * d.sweep * 0.7 + d.ph) * 10;
      const ty = trackY(tz);
      const dir = new THREE.Vector3(tx - x, ty - y, tz - d.z).normalize();
      const range = 90, cosA = Math.cos(0.17);
      const on = dOn ? 1 : 0;
      if (dOn && nc < MAX_CONES) {
        this.vol.uConePos.value[nc].set(x, y - 0.3, d.z, range);
        this.vol.uConeDir.value[nc].set(dir.x, dir.y, dir.z, cosA);
        this.vol.uConeCol.value[nc].set(d.col[0], d.col[1], d.col[2], 2.2);
        nc++;
        pool.push(tx, ty + 1.5, tz, 14, d.col[0] * 3, d.col[1] * 3, d.col[2] * 3);
      }
      const cm = this.coneMeshes[i];
      cm.visible = on && !volumetric;
      const L = Math.min(range * 0.5, Math.hypot(tx - x, ty - y, tz - d.z) * 1.2);
      cm.position.set(x, y - 0.3, d.z);
      cm.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      cm.scale.set(L * Math.tan(0.17), L, L * Math.tan(0.17));
    }
    this.vol.uConeCount.value = nc;
    this.drones.instanceMatrix.needsUpdate = true;

    // ---- billboards
    this.billboards.visible = bOn;
    this.uBillOn.value = bOn ? 1 : 0;
    for (let i = 0; i < this.bbN; i++) {
      let b = this.bbState[i];
      if (b.z > ballZ + 25) b = this.bbState[i] = this.newBillboard(i, ballZ - 560 - Math.random() * 60);
      const y = trackY(b.z) + b.y;
      this.v.set(b.x, y, b.z);
      this.q.setFromEuler(new THREE.Euler(0, -b.side * 1.15, 0));
      this.m.compose(this.v, this.q, this.s.set(b.w, b.h, 1));
      this.billboards.setMatrixAt(i, this.m);
      if (bOn) {
        const hue = b.hue < 0.33 ? [0.1, 0.9, 1] : (b.hue < 0.66 ? [1, 0.15, 0.6] : [0.3, 1, 0.3]);
        const k = 1.6 * (0.15 + 0.85 * power) * (1 - flicker * 0.3 * (Math.sin(time * 37 + i) > 0.6 ? 1 : 0));
        pool.push(b.x - b.side * 2, y, b.z, 22, hue[0] * k, hue[1] * k, hue[2] * k);
      }
    }
    this.billboards.instanceMatrix.needsUpdate = true;

    // ---- cables
    this.cables.visible = cOn;
    for (let i = 0; i < this.cableN; i++) if (this.cableZ[i] > ballZ + 40) this.newCable(i, ballZ - 960 - Math.random() * 30);

    // ---- broken fixtures (spark emitters + flickering warm light)
    for (let i = 0; i < MAX_EMIT; i++) {
      let f = this.fixtures[i];
      if (f.z > ballZ + 20) f = this.fixtures[i] = this.newFixture(ballZ - 420 - Math.random() * 60);
      const spit = Math.sin(time * 7 + f.ph) * Math.sin(time * 2.3 + f.ph * 2) > 0.2 ? 1 : 0.15;
      this.vol.uEmit.value[i].set(f.x, f.y, f.z, spit);
      pool.push(f.x, f.y, f.z, 10, 2.2 * spit, 1.1 * spit, 0.4 * spit);
    }
    // ---- vents
    for (let i = 0; i < MAX_VENTS; i++) {
      let v = this.vents[i];
      if (v.z > ballZ + 15) v = this.vents[i] = this.newVent(ballZ - 360 - Math.random() * 40);
      this.vol.uVents.value[i].set(v.x, v.y, v.z, v.s);
    }
  }
}

// Collects light candidates each frame and uploads the nearest N to the pool uniforms.
export class LightPool {
  constructor(shared) { this.u = shared; this.buf = []; this.n = 0; }
  begin() { this.n = 0; }
  push(x, y, z, r, cr, cg, cb) {
    if (!this.buf[this.n]) this.buf[this.n] = new Float32Array(8);
    this.buf[this.n].set([x, y, z, r, cr, cg, cb, 0]);
    this.n++;
  }
  end(ref, max) {
    const items = this.buf.slice(0, this.n);
    for (const b of items) { const dx = b[0] - ref.x, dy = b[1] - ref.y, dz = b[2] - ref.z; b[7] = (dx * dx + dy * dy + dz * dz) / (b[3] * b[3]); }
    items.sort((a, b) => a[7] - b[7]);
    const n = Math.min(max, items.length);
    for (let i = 0; i < n; i++) {
      const b = items[i];
      this.u.uPoolPos.value[i].set(b[0], b[1], b[2], b[3]);
      this.u.uPoolCol.value[i].set(b[4], b[5], b[6], 1);
    }
    this.u.uPoolCount.value = n;
  }
}
