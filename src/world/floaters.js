import * as THREE from 'three';
import { worldMaterial, trackY } from './shared.js';

// Floating wireframe cubes drifting beside the track (the Slope Tunnel look).
// One instanced draw; tumble + bob are computed in the vertex shader; the faces
// discard everything but their edges, so they read as glowing wire boxes.
const N = 90, SPAN = 520, AHEAD = 480;

const VS = /* glsl */`
attribute vec4 aF; // axis seed, spin speed, size, bob phase
varying vec3 vLocal; varying vec3 vWorld; varying float vSize;
mat3 axisAngle(vec3 a, float r){ a = normalize(a); float c = cos(r), s = sin(r), t = 1.0 - c;
  return mat3(t*a.x*a.x + c, t*a.x*a.y + s*a.z, t*a.x*a.z - s*a.y, t*a.x*a.y - s*a.z, t*a.y*a.y + c, t*a.y*a.z + s*a.x, t*a.x*a.z + s*a.y, t*a.y*a.z - s*a.x, t*a.z*a.z + c); }
void main(){
  vLocal = position; vSize = aF.z;
  vec3 axis = vec3(sin(aF.x * 6.28), cos(aF.x * 3.1), sin(aF.x * 9.7 + 1.0));
  vec3 p = axisAngle(axis, uTime * aF.y + aF.x * 20.0) * (position * aF.z);
  vec3 c = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  c.y += sin(uTime * 0.7 + aF.w) * 0.6;
  c += windAt(c) * 0.04 * sin(uTime * 0.3 + aF.w);
  vec4 wp = modelMatrix * vec4(c + p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FS = /* glsl */`
varying vec3 vLocal; varying vec3 vWorld; varying float vSize;
uniform float uFloatOn;
void main(){
  vec3 a = abs(vLocal) * 2.0;             // 0..1 toward each face
  // a fragment is on an edge when two of its three coordinates are near the face
  float w = 0.06 / max(vSize, 0.5);
  float ex = step(1.0 - w, a.x), ey = step(1.0 - w, a.y), ez = step(1.0 - w, a.z);
  float edge = step(1.5, ex + ey + ez);
  if (edge < 0.5) discard;
  vec3 cyan = vec3(0.15, 0.85, 1.0);
  vec3 col = mix(cyan, uNeon, 0.25) * 3.2 * mix(0.35, 1.0, uPower) * uFloatOn;
  writeGBuffer(col, 0.0, vec3(0.0, 0.0, 1.0), 1.0);
}`;

export class Floaters {
  constructor(scene, shared) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.attr = new Float32Array(N * 4);
    geo.setAttribute('aF', new THREE.InstancedBufferAttribute(this.attr, 4));
    this.uOn = { value: 1 };
    this.mesh = new THREE.InstancedMesh(geo, worldMaterial({ uniforms: { ...shared, uFloatOn: this.uOn }, vertexShader: VS, fragmentShader: FS, side: THREE.DoubleSide }), N);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.z = new Float32Array(N);
    this.m = new THREE.Matrix4();
    this.reset(0);
  }

  place(i, z) {
    this.z[i] = z;
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = side * (6 + Math.random() * 16);
    const y = trackY(z) + 1 + Math.random() * 15;
    this.m.makeTranslation(x, y, z);
    this.mesh.setMatrixAt(i, this.m);
    this.attr.set([Math.random(), (Math.random() - 0.5) * 1.6, 0.6 + Math.random() * 1.6, Math.random() * 6.28], i * 4);
  }

  reset(ballZ) {
    for (let i = 0; i < N; i++) this.place(i, ballZ + 30 - Math.random() * SPAN);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.geometry.attributes.aF.needsUpdate = true;
  }

  update(ballZ, on) {
    this.mesh.visible = on;
    let dirty = false;
    for (let i = 0; i < N; i++) if (this.z[i] > ballZ + 30) { this.place(i, ballZ - AHEAD - Math.random() * 40); dirty = true; }
    if (dirty) { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.geometry.attributes.aF.needsUpdate = true; }
  }
}
