import * as THREE from 'three';
import { worldMaterial, TRACK_W, trackY, SLOPE_TAN } from './shared.js';

export const BALL_R = 0.55;

const VS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vObj;
void main(){
  vObj = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz; vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vObj;
float ang(float a, float k){ float f = abs(fract(a * k / 6.2831853 + 0.5) - 0.5); return f; }
void main(){
  vec3 n = normalize(vNormalW); vec3 o = normalize(vObj);
  float lon = atan(o.z, o.x);
  float lat = asin(clamp(o.y, -1.0, 1.0));
  float wl = fwidth(lon) * 1.2 + 0.004, wa = fwidth(lat) * 1.2 + 0.004;
  float dm = ang(lon, 4.0) * 1.5707963 * cos(lat);
  float mer = 1.0 - smoothstep(0.035, 0.035 + wl, dm);
  float par = 1.0 - smoothstep(0.02, 0.02 + wa, min(abs(lat), abs(abs(lat) - 0.62)));
  float seam = max(mer, par);
  vec3 V = normalize(uCamPos - vWorld);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  vec3 body = vec3(0.004, 0.012, 0.006) * (0.4 + poolLight(vWorld, n) * 0.6);
  vec3 col = body + uNeon * (seam * 4.0 + fres * 0.9);
  writeGBuffer(col, 0.1, (viewMatrix * vec4(n, 0.0)).xyz, max(seam, fres * 0.5));
}`;

export class Ball {
  constructor(scene, shared) {
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 48, 32), worldMaterial({ uniforms: { ...shared }, vertexShader: VS, fragmentShader: FS }));
    scene.add(this.mesh);
    this.input = 0;
    this.keys = new Set();
    addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('#overlay')) return;
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    this.reset();
  }

  reset() {
    this.x = 0; this.z = 0; this.vx = 0;
    this.speed = 14; this.minSpeed = 14; this.maxSpeed = 62;
    this.fallY = 0; this.vy = 0; this.falling = false; this.dead = false;
    this.dist = 0; this.runTime = 0;
    this.q = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
  }

  get speedN() { return (this.speed - this.minSpeed) / (this.maxSpeed - this.minSpeed); }
  get y() { return trackY(this.z) + BALL_R + this.fallY; }

  step(dt) {
    if (this.dead) return;
    const k = this.keys;
    this.input = (k.has('ArrowLeft') || k.has('KeyA') ? -1 : 0) + (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0);
    this.runTime += dt;
    // speed ramps toward max (placeholder curve; real curve comes from SPEC.md)
    this.speed += 1.6 * (1 - this.speed / this.maxSpeed) * dt * 3;
    // steering: lateral accel with damping
    this.vx += this.input * 46 * dt;
    this.vx *= Math.exp(-6.5 * dt);
    this.x += this.vx * dt;
    this.z -= this.speed * dt;
    this.dist += this.speed * dt;

    if (!this.falling && Math.abs(this.x) > TRACK_W / 2 + BALL_R * 0.2) this.falling = true;
    if (this.falling) {
      this.vy -= 28 * dt; this.fallY += this.vy * dt;
      if (this.fallY < -9) this.dead = true;
    }

    // rolling: rotate about axis perpendicular to motion on the slope plane
    this.vel.set(this.vx, -this.speed * SLOPE_TAN, -this.speed);
    const v = this.vel.length();
    const axis = new THREE.Vector3(0, 1, -SLOPE_TAN).normalize().cross(this.vel).normalize();
    const dq = new THREE.Quaternion().setFromAxisAngle(axis, (v * dt) / BALL_R);
    this.q.premultiply(dq);
  }

  sync() {
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.quaternion.copy(this.q);
  }
}
