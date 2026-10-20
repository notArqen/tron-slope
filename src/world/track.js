import * as THREE from 'three';
import { worldMaterial, TRACK_W, trackY, SLOPE_TAN, GROUND_OFFSET } from './shared.js';

const TRACK_LEN = 700;
const AHEAD = 560;

// Puddle mask shared by the GPU (track shader) and CPU (splash trigger).
export const PUDDLE_GLSL = /* glsl */`
float puddleMask(vec2 xz){
  float n = fbm2(xz * vec2(0.22, 0.12) + 13.7);
  float th = 1.0 - uPuddle * uWet * 0.55;
  return smoothstep(th, th + 0.04, n + 0.08);
}`;
function h12(x, y) {
  let a = (x * 0.1031) % 1, b = (y * 0.1031) % 1, c = (x * 0.1031) % 1;
  if (a < 0) a += 1; if (b < 0) b += 1; if (c < 0) c += 1;
  const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += d; b += d; c += d;
  const r = ((a + b) * c) % 1; return r < 0 ? r + 1 : r;
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = h12(ix, iy), b = h12(ix + 1, iy), c = h12(ix, iy + 1), d = h12(ix + 1, iy + 1);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}
export function puddleMaskCPU(x, z, puddle, wet) {
  let px = x * 0.22 + 13.7, pz = z * 0.12 + 13.7, a = 0.5, s = 0;
  for (let i = 0; i < 4; i++) { s += a * vnoise(px, pz); px *= 2.03; pz *= 2.03; a *= 0.5; }
  const th = 1 - puddle * wet * 0.55;
  const t = Math.min(1, Math.max(0, (s + 0.08 - th) / 0.04));
  return t * t * (3 - 2 * t);
}

function buildTrackGeometry() {
  // cross-section: outer lip down, top surface, lip down; extruded along -z on the slope
  const segs = 140, w = TRACK_W / 2, lip = 0.7;
  const prof = [[-w, -lip, -1, 0], [-w, 0, -1, 0], [-w, 0, 0, 1], [w, 0, 0, 1], [w, 0, 1, 0], [w, -lip, 1, 0]];
  const pos = [], nor = [], uv = [], idx = [];
  const up = new THREE.Vector3(0, 1, -SLOPE_TAN).normalize(); // surface normal of the slope plane
  for (let s = 0; s <= segs; s++) {
    const z = -AHEAD + (s / segs) * TRACK_LEN;
    for (const [x, y, nx, ny] of prof) {
      pos.push(x, y + z * SLOPE_TAN, z);
      if (ny > 0) nor.push(up.x, up.y, up.z); else nor.push(nx, ny, 0);
      uv.push(nx === 0 ? 0 : 1, 0);
    }
  }
  const P = prof.length;
  for (let s = 0; s < segs; s++) {
    for (const [a, b] of [[0, 1], [2, 3], [4, 5]]) {
      const i0 = s * P + a, i1 = s * P + b, j0 = (s + 1) * P + a, j1 = (s + 1) * P + b;
      if (a === 0) idx.push(i0, i1, j0, i1, j1, j0); // left lip faces -x
      else if (a === 4) idx.push(i0, j0, i1, i1, j0, j1);
      else idx.push(i0, j0, i1, i1, j0, j1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const COMMON_VS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec2 vUv;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz; vNormalW = normalize(mat3(modelMatrix) * normal); vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const TRACK_FS = PUDDLE_GLSL + /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec2 vUv;
uniform float uHalfW;
void main(){
  vec3 p = vWorld; vec3 n = normalize(vNormalW);
  vec3 neon = uNeon;
  float t = uTime;
  float edgeBoost = max(uPower, 0.65);    // readability: rails never fully lose power
  vec3 col; float emis = 0.0; float refl = 0.08 + uWet * 0.12; vec3 nOut = n;
  if (vUv.x > 0.5) {
    // side lips: solid emissive rails — the track edge must always read
    float band = gridLine(p.y - trackY(p.z), 0.35, 0.03);
    col = neon * (1.6 + band * 2.0) * edgeBoost;
    emis = 1.0; refl = 0.0;
  } else {
    float along = p.z;
    float lat = gridLine(along, 2.4, 0.05);
    float lon = gridLine(p.x, uHalfW / 3.0, 0.04);
    vec2 cell = vec2(floor(p.x / (uHalfW / 3.0)), floor(along / 2.4));
    float live = neonLive(floor(cell / vec2(1.0, 6.0)), t);
    float surge = uSurge * surgePulse(along, t, hash11(cell.x) * 3.0);
    float edge = 1.0 - smoothstep(0.08, 0.2, uHalfW - abs(p.x));
    float lines = max(lat, lon);
    // grime + cracks
    float grime = uGrime * fbm2(p.xz * vec2(0.6, 0.15));
    float crackN = fbm2(p.xz * 0.9 + 5.0);
    float crack = uGrime * (1.0 - smoothstep(0.0, 0.018, abs(crackN - 0.5))) * step(0.55, hash12(floor(p.xz * 0.08)));
    lines *= (1.0 - crack * 0.9) * (1.0 - grime * 0.35);
    vec3 base = vec3(0.012, 0.014, 0.016) * (1.0 - grime * 0.6) + vec3(0.02) * crack;
    // puddles + rain ripples
    float pud = puddleMask(p.xz);
    if (pud > 0.0) {
      vec2 cellR = floor(p.xz / 0.7); vec2 f = fract(p.xz / 0.7) - 0.5;
      float h = hash12(cellR);
      float ph = fract(t * (0.9 + h) + h * 7.0);
      vec2 c = (hash22(cellR) - 0.5) * 0.4;
      float r = length(f - c); float ring = sin((r - ph * 0.5) * 60.0) * (1.0 - ph) * smoothstep(0.5 * ph + 0.06, 0.5 * ph, r);
      vec2 dir = normalize(f - c + 1e-4);
      nOut = normalize(n + vec3(dir.x, 0.0, dir.y) * ring * 0.25 * uRain * pud);
      base *= mix(1.0, 0.35, pud);
      refl = mix(refl, 0.95, pud);
      lines *= mix(1.0, 0.45, pud);
    }
    vec3 lit = base * (0.25 + poolLight(p, n) * 1.5) + base * uLightning * 4.0;
    float blob = ballBlob(p);
    col = lit * blob + neon * lines * (2.2 * live + surge * 6.0) * mix(0.4, 1.0, uPower) * blob;
    col += neon * edge * 3.0 * edgeBoost;
    emis = max(lines * live, edge);
  }
  writeGBuffer(col, refl, (viewMatrix * vec4(nOut, 0.0)).xyz, emis);
}`;

const GROUND_FS = PUDDLE_GLSL + /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec2 vUv;
void main(){
  vec3 p = vWorld; vec3 n = normalize(vNormalW);
  float g = max(gridLine(p.x, 12.0, 0.06), gridLine(p.z, 12.0, 0.06));
  float live = neonLive(floor(p.xz / 48.0), uTime);
  float street = 1.0 - smoothstep(9.0, 10.0, abs(p.x));
  float wet = uWet * (0.5 + 0.5 * fbm2(p.xz * 0.05));
  vec3 base = vec3(0.01) * (1.0 + street);
  vec3 col = base * (0.3 + poolLight(p, n) * 2.0) + uNeon * g * 0.55 * live * uPower;
  col += uSmog * 0.015;
  writeGBuffer(col, 0.2 + wet * 0.7, (viewMatrix * vec4(n, 0.0)).xyz, g * live * 0.6);
}`;

export class Track {
  constructor(scene, shared) {
    this.mat = worldMaterial({ uniforms: { ...shared, uHalfW: { value: TRACK_W / 2 } }, vertexShader: COMMON_VS, fragmentShader: TRACK_FS, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(buildTrackGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    const gGeo = new THREE.PlaneGeometry(900, 1400, 1, 1);
    gGeo.rotateX(-Math.PI / 2);
    // tilt to follow the slope
    gGeo.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.atan(SLOPE_TAN)));
    this.ground = new THREE.Mesh(gGeo, worldMaterial({ uniforms: { ...shared }, vertexShader: COMMON_VS, fragmentShader: GROUND_FS, side: THREE.DoubleSide }));
    this.ground.frustumCulled = false;
    scene.add(this.ground);

    // reaction-distance boundary (debug): an upright gate frame across the track
    const bGeo = new THREE.PlaneGeometry(TRACK_W + 1.2, 3.2);
    bGeo.translate(0, 1.6, 0);
    this.boundary = new THREE.Mesh(bGeo, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, side: THREE.DoubleSide,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `layout(location=0) out highp vec4 gColor; layout(location=1) out highp vec4 gNormal; varying vec2 vUv;
        void main(){ vec2 e = min(vUv, 1.0 - vUv) * vec2(${(TRACK_W + 1.2).toFixed(1)}, 3.2);
          float frame = step(min(e.x, e.y), 0.12); float hatch = step(0.85, fract((vUv.x * 9.0 + vUv.y * 2.0)));
          if (frame < 0.5 && hatch < 0.5) discard;
          gColor = vec4(vec3(6.0, 0.3, 4.5) * (frame > 0.5 ? 1.0 : 0.35), 0.0); gNormal = vec4(0.5, 0.5, 1.0, 1.0); }`,
    }));
    this.boundary.frustumCulled = false;
    this.boundary.visible = false;
    scene.add(this.boundary);
  }

  update(ballZ, reactDist, showBoundary) {
    const snap = Math.round(ballZ / 2.4) * 2.4;
    this.mesh.position.set(0, 0, 0);
    this.mesh.position.z = snap;
    this.mesh.position.y = trackY(snap);
    this.ground.position.set(0, trackY(ballZ - 400) - GROUND_OFFSET, ballZ - 400);
    this.boundary.visible = showBoundary;
    const bz = ballZ - reactDist;
    this.boundary.position.set(0, trackY(bz), bz);
  }
}

// ----------------------------------------------------------------------------------
// Placeholder obstacles — generic blocks for readability/contrast testing only.
const OBST_VS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vLocal; varying vec3 vScale;
void main(){
  mat4 m = modelMatrix * instanceMatrix;
  vScale = vec3(length(m[0].xyz), length(m[1].xyz), length(m[2].xyz));
  vLocal = position * vScale;
  vec4 wp = m * vec4(position, 1.0);
  vWorld = wp.xyz; vNormalW = normalize(mat3(m) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const OBST_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vLocal; varying vec3 vScale;
uniform float uRimMin;
void main(){
  vec3 n = normalize(vNormalW);
  vec3 hs = vScale * 0.5; vec3 a = abs(vLocal);
  vec3 d = hs - a;
  // distance to the nearest box edge (two smallest face distances)
  float e = min(min(max(d.x, d.y), max(d.y, d.z)), max(d.x, d.z));
  float edge = 1.0 - smoothstep(0.03, 0.09, e);
  float grid = max(gridLine(vLocal.x, 0.5, 0.02), max(gridLine(vLocal.y, 0.5, 0.02), gridLine(vLocal.z, 0.5, 0.02)));
  vec3 V = normalize(uCamPos - vWorld);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 2.0);
  // minimum-contrast rim: independent of weather / power so obstacles always read
  float rim = max(fres, uRimMin);
  vec3 body = vec3(0.03, 0.004, 0.004) * (0.4 + poolLight(vWorld, n));
  vec3 col = body + uNeon2 * (edge * 5.0 + grid * 0.9 + rim * 1.4);
  writeGBuffer(col, 0.05, (viewMatrix * vec4(n, 0.0)).xyz, max(edge, rim * 0.6));
}`;

export class TestObstacles {
  constructor(scene, shared, count = 28) {
    this.count = count;
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), worldMaterial({
      uniforms: { ...shared, uRimMin: { value: 0.35 } }, vertexShader: OBST_VS, fragmentShader: OBST_FS }), count);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.items = [];
    this.m = new THREE.Matrix4();
    this.reset(0);
  }

  spawnAt(i, z) {
    const w = 0.8 + Math.random() * 1.8, h = 0.9 + Math.random() * 1.6, d = 0.8 + Math.random() * 1.2;
    const x = (Math.random() - 0.5) * (TRACK_W - w - 0.6);
    this.items[i] = { x, z, w, h, d };
    this.writeMatrix(i);
  }

  writeMatrix(i) {
    const o = this.items[i];
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.atan(SLOPE_TAN), 0, 0));
    this.m.compose(new THREE.Vector3(o.x, trackY(o.z) + o.h / 2, o.z), q, new THREE.Vector3(o.w, o.h, o.d));
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  reset(ballZ) {
    this.farZ = ballZ - 70;
    for (let i = 0; i < this.count; i++) { this.spawnAt(i, this.farZ); this.farZ -= 18 + Math.random() * 22; }
  }

  update(ballZ, enabled) {
    this.mesh.visible = enabled;
    for (let i = 0; i < this.count; i++) {
      if (this.items[i].z > ballZ + 20) { this.spawnAt(i, this.farZ); this.farZ -= 18 + Math.random() * 22; }
    }
  }

  // sphere vs AABB on the slope frame (approximate: slope is gentle)
  hit(bx, bz, r) {
    if (!this.mesh.visible) return false;
    for (const o of this.items) {
      const dx = Math.max(Math.abs(bx - o.x) - o.w / 2, 0), dz = Math.max(Math.abs(bz - o.z) - o.d / 2, 0);
      if (dx * dx + dz * dz < r * r * 0.8) return true;
    }
    return false;
  }
}
