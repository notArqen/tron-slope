import * as THREE from 'three';
import { worldMaterial, trackY, GROUND_OFFSET } from './shared.js';

const SKY_VS = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w * 0.99999; // pin to far plane
}`;
const SKY_FS = /* glsl */`
varying vec3 vDir;
uniform float uGlow;
void main(){
  vec3 d = normalize(vDir);
  float el = d.y;
  float az = atan(d.x, -d.z);
  // orange smog dome: glow hugs the horizon, district tint varies with heading
  float horizon = exp(-max(el + 0.05, 0.0) * 7.0);
  vec3 tint = mix(uSmog, uSmog * districtTint(uCamPos.z) * 1.4, 0.35);
  vec3 col = vec3(0.004, 0.004, 0.008) + tint * horizon * 0.55 * uGlow;
  col += tint * 0.04 * uGlow * (0.6 + 0.4 * fbm2(vec2(az * 3.0, el * 9.0) + uTime * 0.01));
  // lightning: broad flash + jagged bolt at a random azimuth
  float da = az - uLightningAz;
  float flash = uLightning * exp(-da * da * 3.0);
  col += vec3(0.6, 0.65, 1.0) * flash * 2.5 * smoothstep(-0.1, 0.4, el);
  float path = uLightningAz + (fbm2(vec2(el * 9.0, floor(uLightningAz * 10.0))) - 0.5) * 0.25;
  float bolt = exp(-abs(az - path) * 900.0) * step(-0.02, el) * step(el, 0.55) * uLightning;
  col += vec3(0.8, 0.85, 1.0) * bolt * 40.0;
  gColor = vec4(col, 0.0);
  gNormal = vec4(0.5, 0.5, 0.5, clamp(bolt * 4.0, 0.0, 1.0)); // zero normal marks sky
}`;

// distant skyline silhouettes + aviation strobes
const SL_VS = /* glsl */`
attribute vec2 aStrobe; // phase, colour (0 red / 1 blue)
varying vec3 vWorld; varying vec3 vNormalW; varying float vTop; varying vec2 vStrobe; varying vec3 vLocalN;
void main(){
  mat4 m = modelMatrix * instanceMatrix;
  vec3 p = position + vec3(0.0, 0.5, 0.0);
  vTop = p.y; vStrobe = aStrobe; vLocalN = p;
  vec4 wp = m * vec4(p, 1.0);
  vWorld = wp.xyz; vNormalW = normalize(mat3(m) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const SL_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying float vTop; varying vec2 vStrobe; varying vec3 vLocalN;
uniform float uStrobes;
void main(){
  vec3 n = normalize(vNormalW);
  vec3 col = vec3(0.002);
  // strobe lamp near the roof centre
  float lamp = smoothstep(0.985, 1.0, vTop) * (1.0 - smoothstep(0.04, 0.1, length(vLocalN.xz)));
  float blink = step(0.82, fract(uTime * 0.9 + vStrobe.x));
  vec3 sc = mix(vec3(1.0, 0.05, 0.03), vec3(0.1, 0.25, 1.0), vStrobe.y);
  col += sc * lamp * blink * 60.0 * uStrobes;
  writeGBuffer(col, 0.0, (viewMatrix * vec4(n, 0.0)).xyz, lamp * blink * uStrobes);
}`;

export class Sky {
  constructor(scene, shared) {
    this.uGlow = { value: 0.8 };
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1500, 48, 24), worldMaterial({
      uniforms: { ...shared, uGlow: this.uGlow }, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false }));
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    const N = 90;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const strobe = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) { strobe[i * 2] = Math.random(); strobe[i * 2 + 1] = Math.random() < 0.5 ? 0 : 1; }
    geo.setAttribute('aStrobe', new THREE.InstancedBufferAttribute(strobe, 2));
    this.uStrobes = { value: 1 };
    this.skyline = new THREE.InstancedMesh(geo, worldMaterial({ uniforms: { ...shared, uStrobes: this.uStrobes }, vertexShader: SL_VS, fragmentShader: SL_FS }), N);
    this.skyline.frustumCulled = false;
    this.layout = [];
    for (let i = 0; i < N; i++) {
      const ang = (Math.random() - 0.5) * 2.6;
      const r = 650 + Math.random() * 500;
      this.layout.push({ x: Math.sin(ang) * r, z: -Math.cos(ang) * r, w: 30 + Math.random() * 60, h: 120 + Math.random() * 260 });
    }
    this.m = new THREE.Matrix4();
    scene.add(this.skyline);
  }

  update(cam, ballZ, glow, strobes, strobesOn) {
    this.mesh.position.copy(cam.position);
    this.uGlow.value = glow;
    this.uStrobes.value = strobesOn ? strobes : 0;
    // skyline rides with the player (it is "at infinity" relative to the run)
    for (let i = 0; i < this.layout.length; i++) {
      const o = this.layout[i];
      const z = ballZ + o.z;
      const base = trackY(z) - GROUND_OFFSET;
      this.m.makeScale(o.w, o.h, o.w).setPosition(o.x, base, z);
      this.skyline.setMatrixAt(i, this.m);
    }
    this.skyline.instanceMatrix.needsUpdate = true;
  }
}
