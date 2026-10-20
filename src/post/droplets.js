import * as THREE from 'three';
import { DROP_VS, DROP_FS } from './shaders.js';

// Screen-space lens droplets: a limited CPU pool simulated in uv space and
// rendered as refractive normal blobs into a small target the lens pass samples.
// Wind (shared field, sampled at the camera) pushes them sideways; airflow at
// speed pushes them outward and clears them faster; big drops run down as streaks.
export class LensDroplets {
  constructor(max = 96) {
    this.max = max;
    this.list = [];
    this.rt = new THREE.WebGLRenderTarget(384, 216, { type: THREE.UnsignedByteType, depthBuffer: false });
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.attr = new Float32Array(max * 2 * 4);
    g.setAttribute('aDrop', new THREE.InstancedBufferAttribute(this.attr, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: DROP_VS, fragmentShader: DROP_FS,
      uniforms: { uAspect: { value: 16 / 9 } }, depthTest: false, depthWrite: false, transparent: false });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.mesh);
    this.cam = new THREE.Camera();
    this.spawnAcc = 0;
    this.tmp = new THREE.Vector3();
  }

  update(dt, { amount, density, speedN, wind, camera, aspect }) {
    this.mat.uniforms.uAspect.value = aspect;
    const cap = Math.round(this.max * Math.min(1, density / 2) * 2) / 2;
    // spawn rate scales with rain/droplet weather amount
    this.spawnAcc += dt * amount * 22 * density;
    while (this.spawnAcc > 1 && this.list.length < cap) {
      this.spawnAcc -= 1;
      this.list.push({ x: Math.random(), y: Math.random(), r: 0.006 + Math.random() * 0.018, vx: 0, vy: 0, life: 4 + Math.random() * 8, age: 0, trail: 0 });
    }
    if (this.list.length >= cap) this.spawnAcc = 0;
    // wind at the camera, projected onto screen-right
    wind.at(camera.position, this.tmp);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const wx = this.tmp.dot(right) * 0.004;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      d.age += dt * (1 + speedN * 3); // cleared faster at high speed
      const big = d.r > 0.014;
      // airflow pushes outward from the centre at speed
      const ox = d.x - 0.5, oy = d.y - 0.5;
      d.vx += (ox * speedN * 0.9 + wx) * dt;
      d.vy += (oy * speedN * 0.9 - (big ? 0.12 : 0.01)) * dt;
      d.vx *= Math.exp(-2 * dt); d.vy *= Math.exp(-2 * dt);
      d.x += d.vx * dt; d.y += d.vy * dt;
      d.trail = Math.min(2.5, Math.hypot(d.vx, d.vy) * 25);
      if (d.age > d.life || d.x < -0.05 || d.x > 1.05 || d.y < -0.1 || d.y > 1.1) this.list.splice(i, 1);
    }
    const L = this.list;
    for (let i = 0; i < this.max; i++) {
      const d = L[i];
      if (!d) { this.attr.set([0, 0, 0, 0], i * 4); continue; }
      const shrink = Math.min(1, (d.life - d.age) * 1.5);
      this.attr.set([d.x, d.y, d.r * shrink, d.trail], i * 4);
    }
    this.geo.attributes.aDrop.needsUpdate = true;
    this.geo.instanceCount = Math.max(1, L.length);
  }

  render(renderer) {
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x808000, 0);
    renderer.clear(true, false, false);
    if (this.list.length) renderer.render(this.scene, this.cam);
    renderer.setClearColor(0x000000, 0);
  }
}
