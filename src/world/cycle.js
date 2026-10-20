import * as THREE from 'three';
import { worldMaterial } from './shared.js';

// Light cycle: a purely visual alternative to the ball. Physics (and therefore
// fairness) are unchanged — the ball's collision sphere still drives everything;
// the bike just rides on top of it, leans into steering and drags a light wall.
// All procedural: capsule body, canopy, hubless glowing wheels, no logos.

const BODY_VS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vObj;
void main(){ vObj = position; vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * wp; }`;
const BODY_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vObj;
uniform float uPart; // 0 body, 1 canopy, 2 rim, 3 hub
void main(){
  vec3 n = normalize(vNormalW), V = normalize(uCamPos - vWorld);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  vec3 col; float emis = 0.0;
  if (uPart > 1.5 && uPart < 2.5) { col = uNeon * 10.0; emis = 1.0; }                      // glowing rim
  else if (uPart > 2.5) { col = vec3(0.01) + uNeon * 0.15 * fres; }                          // dark hub
  else {
    // gloss black shell with a neon seam along the flank + a spine line on top
    vec3 env = mix(vec3(0.004), uSmog * 0.06 + vec3(0.02), smoothstep(-0.2, 1.0, n.y)) + poolLight(vWorld, n) * 0.08;
    // capsule is modelled along local y and rotated: local −z is up, local x is across
    float seam = (1.0 - smoothstep(0.015, 0.035, abs(vObj.z + 0.02))) * step(0.12, abs(vObj.x));
    float spine = (1.0 - smoothstep(0.015, 0.035, abs(vObj.x))) * step(0.12, -vObj.z);
    float tail = step(0.7, vObj.y) * step(0.15, -vObj.z + 0.25); // rear cap glows (what you see from behind)
    float glow = uPart > 0.5 ? 0.0 : max(max(seam, spine * 0.8), tail);
    col = env + vec3(0.6, 0.7, 0.8) * pow(fres, 2.0) * 0.5 + uNeon * (glow * 9.0 + pow(fres, 1.5) * 2.2); // neon silhouette
    if (uPart > 0.5) col = vec3(0.01, 0.02, 0.03) + uNeon * 0.25 * fres + vec3(0.5) * pow(fres, 6.0);
    emis = glow;
  }
  writeGBuffer(col, 0.25, (viewMatrix * vec4(n, 0.0)).xyz, emis);
}`;

const TRAIL_VS = /* glsl */`
attribute float aAge; // 0 at the bike → 1 at the tail
varying float vAge; varying float vH; varying vec3 vWorld;
void main(){ vAge = aAge; vH = uv.y; vec4 wp = vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const TRAIL_FS = /* glsl */`
varying float vAge; varying float vH; varying vec3 vWorld;
void main(){
  float fade = 1.0 - smoothstep(0.55, 1.0, vAge);
  float edge = smoothstep(0.85, 1.0, vH) + (1.0 - smoothstep(0.0, 0.08, vH)) * 0.6;
  float scan = 0.85 + 0.15 * sin(vWorld.z * 3.0 - uTime * 20.0);
  vec3 col = uNeon * (1.2 + edge * 3.0) * fade * scan;
  if (fade < 0.02) discard;
  writeGBuffer(col, 0.0, vec3(0.0, 0.0, 1.0), fade);
}`;

const TRAIL_N = 160, TRAIL_STEP = 0.35, TRAIL_H = 0.85;

export class LightCycle {
  constructor(scene, shared) {
    const mk = (part, side = THREE.FrontSide) => worldMaterial({ uniforms: { ...shared, uPart: { value: part } }, vertexShader: BODY_VS, fragmentShader: BODY_FS, side });
    this.group = new THREE.Group();
    this.pivot = new THREE.Group();          // leans/pitches; group carries position + heading
    this.group.add(this.pivot);
    // body: stretched capsule, low and long
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.25, 8, 20), mk(0));
    body.rotation.x = Math.PI / 2; body.scale.set(0.85, 1, 0.75); body.position.y = 0.52;
    // canopy bubble over the front half
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), mk(1));
    canopy.scale.set(0.8, 0.7, 1.6); canopy.position.set(0, 0.68, -0.18);
    this.pivot.add(body, canopy);
    // hubless wheels: glowing rim torus + dark hub disc
    this.wheels = [];
    for (const z of [-0.78, 0.78]) {
      const w = new THREE.Group(); w.position.set(0, 0.46, z);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.09, 10, 40), mk(2)); rim.rotation.y = Math.PI / 2;
      const tyre = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.1, 10, 40), mk(3)); tyre.rotation.y = Math.PI / 2; tyre.scale.set(1, 1, 0.9);
      const spokes = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 20, 1, true), mk(3, THREE.DoubleSide)); spokes.rotation.z = Math.PI / 2;
      w.add(tyre, rim, spokes);
      this.pivot.add(w); this.wheels.push(w);
    }
    this.group.scale.setScalar(1.25);
    this.group.visible = false;
    scene.add(this.group);

    // light wall: ribbon through recent rear-wheel positions
    const g = new THREE.BufferGeometry();
    this.tPos = new Float32Array(TRAIL_N * 2 * 3);
    const uv = new Float32Array(TRAIL_N * 2 * 2), age = new Float32Array(TRAIL_N * 2), idx = [];
    for (let i = 0; i < TRAIL_N; i++) {
      uv.set([i / (TRAIL_N - 1), 0, i / (TRAIL_N - 1), 1], i * 4); age[i * 2] = age[i * 2 + 1] = i / (TRAIL_N - 1);
      if (i < TRAIL_N - 1) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    g.setAttribute('position', new THREE.BufferAttribute(this.tPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aAge', new THREE.BufferAttribute(age, 1));
    g.setIndex(idx);
    this.trail = new THREE.Mesh(g, worldMaterial({ uniforms: { ...shared }, vertexShader: TRAIL_VS, fragmentShader: TRAIL_FS, side: THREE.DoubleSide }));
    this.trail.frustumCulled = false; this.trail.visible = false;
    scene.add(this.trail);
    this.pts = []; this.yaw = 0; this.lean = 0; this.pitch = 0; this.spin = 0;
    this.v = new THREE.Vector3(); this.tmp = new THREE.Vector3();
  }

  get materials() { const m = []; this.group.traverse((o) => o.material && m.push(o.material)); m.push(this.trail.material); return m; }

  reset() { this.pts.length = 0; }

  update(ball, dt, visible, alive) {
    this.group.visible = visible && alive;
    this.trail.visible = visible;
    if (!visible) return;
    const vel = ball.vel, sp = Math.hypot(vel.x, vel.z);
    if (dt > 0 && sp > 0.5) {
      const yaw = Math.atan2(-vel.x, -vel.z);
      this.yaw += (yaw - this.yaw) * (1 - Math.exp(-dt * 12));
      this.pitch += (Math.atan2(vel.y, sp) - this.pitch) * (1 - Math.exp(-dt * 10));
      const leanT = Math.max(-0.6, Math.min(0.6, -(ball.vu || 0) * 0.08)) + (ball.grounded ? -ball.bank : 0);
      this.lean += (leanT - this.lean) * (1 - Math.exp(-dt * 8));
      this.spin += (ball.speed * dt) / 0.46;
    }
    // bike sits on the deck under the collision sphere
    this.group.position.set(ball.x, ball.y - 0.55, ball.z);
    this.group.rotation.set(0, this.yaw, 0);
    this.pivot.rotation.set(this.pitch, 0, this.lean, 'YXZ');
    for (const w of this.wheels) w.rotation.x = -this.spin;

    // trail: drop a point every TRAIL_STEP metres of travel at the rear wheel
    this.tmp.set(0, 0, 0.9).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).add(this.group.position);
    const last = this.pts[0];
    if (!last || last.distanceToSquared(this.tmp) > TRAIL_STEP * TRAIL_STEP) {
      this.pts.unshift(this.tmp.clone());
      if (this.pts.length > TRAIL_N) this.pts.pop();
    } else last.copy(this.tmp);
    for (let i = 0; i < TRAIL_N; i++) {
      const p = this.pts[Math.min(i, this.pts.length - 1)] || this.tmp;
      this.tPos.set([p.x, p.y + 0.05, p.z, p.x, p.y + TRAIL_H, p.z], i * 6);
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
  }
}
