import * as THREE from 'three';
import { worldMaterial } from '../world/shared.js';
import { PUDDLE_GLSL, OBST_VS, OBST_FS } from '../world/track.js';
import { DZ, obstacleBoxes } from './course.js';

// Renders the streamed course: pooled deck + tunnel meshes (geometry rewritten in
// place on reuse, never reallocated) and one instanced mesh for every obstacle box.

const MAX_SAMPLES = 640;
const LIP = 0.7;
const TUBE_H = 5;

const ROT_VS = /* glsl */`
attribute vec4 aRot;    // amp, omega, phase, -
attribute vec2 aPivot;  // rotation pivot (x, y) for rotating tunnels
uniform float uRunTime;
vec3 rotDeck(vec3 p){ if (aRot.x == 0.0) return p; float th = aRot.x * sin(aRot.y * uRunTime + aRot.z);
  vec2 d = p.xy - aPivot; float c = cos(th), s = sin(th); return vec3(aPivot + vec2(d.x * c - d.y * s, d.x * s + d.y * c), p.z); }
vec3 rotN(vec3 n){ if (aRot.x == 0.0) return n; float th = aRot.x * sin(aRot.y * uRunTime + aRot.z); float c = cos(th), s = sin(th); return vec3(n.x * c - n.y * s, n.x * s + n.y * c, n.z); }
`;

const DECK_VS = ROT_VS + /* glsl */`
attribute vec4 aDeck;   // u, hw, s (along), distance to an open end
attribute float aSide;  // 1 on the side lips
varying vec3 vWorld; varying vec3 vNormalW; varying vec4 vDeck; varying float vSide;
void main(){
  vec3 p = rotDeck(position);
  vWorld = p; vNormalW = rotN(normal); vDeck = aDeck; vSide = aSide;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const DECK_FS = PUDDLE_GLSL + /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec4 vDeck; varying float vSide;
void main(){
  vec3 p = vWorld; vec3 n = normalize(vNormalW);
  vec3 neon = uNeon; float t = uTime;
  float u = vDeck.x, hw = vDeck.y, s = vDeck.z, dOpen = vDeck.w;
  float edgeBoost = max(uPower, 0.65);   // readability: edges never fully lose power
  vec3 col; float emis; float refl = 0.08 + uWet * 0.12; vec3 nOut = n;
  if (vSide > 0.5) {
    float band = gridLine(s, 1.2, 0.04);
    col = neon * (1.4 + band * 1.5) * edgeBoost; emis = 1.0; refl = 0.0;
  } else {
    float lat = gridLine(s, 2.4, 0.05);
    float lon = gridLine(u + hw, max(hw * 2.0 / 6.0, 0.55), 0.04);
    vec2 cell = vec2(floor((u + hw) / max(hw / 3.0, 0.5)), floor(s / 2.4));
    // the deck is read at speed: dead sections only dim here, they never go dark
    float live = mix(0.6, 1.0, neonLive(floor(cell / vec2(1.0, 6.0)) + floor(p.z * 0.01), t));
    float surge = uSurge * surgePulse(p.z, t, hash11(cell.x) * 3.0);
    float edge = 1.0 - smoothstep(0.08, 0.2, hw - abs(u));
    float endEdge = 1.0 - smoothstep(0.1, 0.35, dOpen);
    float lines = max(lat, lon);
    float grime = uGrime * fbm2(p.xz * vec2(0.6, 0.15));
    float crack = uGrime * (1.0 - smoothstep(0.0, 0.018, abs(fbm2(p.xz * 0.9 + 5.0) - 0.5))) * step(0.55, hash12(floor(p.xz * 0.08)));
    lines *= (1.0 - crack * 0.4) * (1.0 - grime * 0.25);
    vec3 base = vec3(0.012, 0.014, 0.016) * (1.0 - grime * 0.6) + vec3(0.02) * crack;
    float pud = puddleMask(p.xz) * step(1.6, hw);
    if (pud > 0.0) {
      vec2 cellR = floor(p.xz / 0.7); vec2 f = fract(p.xz / 0.7) - 0.5;
      float h = hash12(cellR); float ph = fract(t * (0.9 + h) + h * 7.0);
      vec2 c = (hash22(cellR) - 0.5) * 0.4;
      float r = length(f - c); float ring = sin((r - ph * 0.5) * 60.0) * (1.0 - ph) * smoothstep(0.5 * ph + 0.06, 0.5 * ph, r);
      vec2 dir = normalize(f - c + 1e-4);
      nOut = normalize(n + vec3(dir.x, 0.0, dir.y) * ring * 0.25 * uRain * pud);
      base *= mix(1.0, 0.6, pud); refl = mix(refl, 0.9, pud); lines *= mix(1.0, 0.8, pud);
    }
    vec3 lit = base * (0.25 + poolLight(p, n) * 1.5) + base * uLightning * 4.0;
    float blob = ballBlob(p);
    col = lit * blob + neon * lines * (2.2 * live + surge * 6.0) * mix(0.6, 1.0, uPower) * mix(0.6, 1.0, blob);
    col += neon * max(edge, endEdge) * 3.0 * edgeBoost;
    emis = max(lines * live, max(edge, endEdge));
  }
  writeGBuffer(col, refl, (viewMatrix * vec4(nOut, 0.0)).xyz, emis);
}`;

const TUBE_VS = ROT_VS + /* glsl */`
attribute vec2 aTube;   // perimeter coordinate (m), s along
varying vec3 vWorld; varying vec3 vNormalW; varying vec2 vTube;
void main(){
  vec3 p = rotDeck(position);
  vWorld = p; vNormalW = rotN(normal); vTube = aTube;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const TUBE_FS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec2 vTube;
void main(){
  vec3 n = normalize(vNormalW);
  float ring = gridLine(vTube.y, 2.4, 0.05), rib = gridLine(vTube.x, 1.0, 0.035);
  float live = neonLive(vec2(floor(vTube.x / 3.0), floor(vTube.y / 14.0)), uTime);
  float surge = uSurge * surgePulse(vTube.y * 3.0, uTime * 1.6, floor(vTube.x) * 0.37);
  vec3 base = vec3(0.006, 0.007, 0.009);
  vec3 col = base * (0.4 + poolLight(vWorld, n)) + uNeon * (max(ring, rib) * 1.6 * live * mix(0.35, 1.0, uPower) + surge * rib * 5.0);
  writeGBuffer(col, 0.05, (viewMatrix * vec4(n, 0.0)).xyz, max(ring, rib) * live);
}`;

class PooledMesh {
  constructor(material, vertsPer, indexFn, attrs) {
    const g = new THREE.BufferGeometry();
    const nV = MAX_SAMPLES * vertsPer;
    this.attrs = {};
    for (const [name, size] of Object.entries(attrs)) {
      const a = new THREE.BufferAttribute(new Float32Array(nV * size), size).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a); this.attrs[name] = a;
    }
    g.setIndex(indexFn(MAX_SAMPLES));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.idxPerSeg = g.index.count / (MAX_SAMPLES - 1);
  }
  commit(nSamples) {
    for (const a of Object.values(this.attrs)) a.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, (nSamples - 1) * this.idxPerSeg);
  }
}

function deckIndex(n) {
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 6, b = (i + 1) * 6;
    idx.push(a, b, a + 1, a + 1, b, b + 1);            // top
    idx.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2); // left lip
    idx.push(a + 4, b + 4, a + 5, a + 5, b + 4, b + 5); // right lip
  }
  return idx;
}
// octagonal tunnel section (the deck is the floor face); 7 faces × 2 verts per ring
const OCT = (hw) => { const c = 1.7; return [[-hw, 0], [-hw - c, c], [-hw - c, TUBE_H - c], [-hw, TUBE_H], [hw, TUBE_H], [hw + c, TUBE_H - c], [hw + c, c], [hw, 0]]; };
const TUBE_VERTS = 14;
function tubeIndex(n) {
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    for (let f = 0; f < 7; f++) {
      const a = i * TUBE_VERTS + f * 2, b = (i + 1) * TUBE_VERTS + f * 2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return idx;
}

export class CourseView {
  constructor(scene, obstacleScene, shared, course) {
    this.scene = scene; this.course = course;
    this.uRunTime = { value: 0 };
    const u = { ...shared, uRunTime: this.uRunTime };
    this.deckMat = worldMaterial({ uniforms: u, vertexShader: DECK_VS, fragmentShader: DECK_FS, side: THREE.DoubleSide });
    this.tubeMat = worldMaterial({ uniforms: u, vertexShader: TUBE_VS, fragmentShader: TUBE_FS, side: THREE.DoubleSide });
    this.free = { deck: [], tube: [] };
    this.live = new Map(); // chunk → [PooledMesh]
    this.maxBoxes = 600;
    this.obst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), worldMaterial({
      uniforms: { ...shared, uRimMin: { value: 0.35 } }, vertexShader: OBST_VS, fragmentShader: OBST_FS }), this.maxBoxes);
    this.obst.frustumCulled = false;
    this.obst.count = 0;
    obstacleScene.add(this.obst);
    this.boxes = []; this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler(0, 0, 0, 'YZX');
    this.p = new THREE.Vector3(); this.sc = new THREE.Vector3();
    course.on('add', (c) => this.addChunk(c));
    course.on('remove', (c) => this.removeChunk(c));
  }

  get materials() { return [this.deckMat, this.tubeMat, this.obst.material]; }

  take(kind) {
    let pm = this.free[kind].pop();
    if (!pm) {
      pm = kind === 'deck'
        ? new PooledMesh(this.deckMat, 6, deckIndex, { position: 3, normal: 3, aDeck: 4, aSide: 1, aRot: 4, aPivot: 2 })
        : new PooledMesh(this.tubeMat, TUBE_VERTS, tubeIndex, { position: 3, normal: 3, aTube: 2, aRot: 4, aPivot: 2 });
      pm.kind = kind;
    }
    this.scene.add(pm.mesh);
    return pm;
  }

  addChunk(chunk) {
    const list = [];
    for (const pl of chunk.platforms) {
      list.push(this.buildDeck(pl));
      if (pl.tunnel) list.push(this.buildTube(pl));
    }
    this.live.set(chunk, list);
  }

  removeChunk(chunk) {
    for (const pm of this.live.get(chunk) || []) { this.scene.remove(pm.mesh); this.free[pm.kind].push(pm); }
    this.live.delete(chunk);
  }

  buildDeck(pl) {
    const pm = this.take('deck'), A = pm.attrs;
    const n = Math.min(pl.n, MAX_SAMPLES), len = (n - 1) * DZ;
    const rot = pl.rot;
    for (let i = 0; i < n; i++) {
      const z = pl.z0 - i * DZ, cx = pl.cx[i], cy = pl.cy[i], hw = pl.hw[i], th = pl.bank[i], hc = pl.pivot;
      const c = Math.cos(th), s = Math.sin(th);
      // deck surface rotated about (cx, cy + hc)
      const P = (u, down) => [cx + u * c + hc * s + down * s, cy + hc + u * s - hc * c - down * c];
      const [lx, ly] = P(-hw, 0), [rx, ry] = P(hw, 0), [lbx, lby] = P(-hw, LIP), [rbx, rby] = P(hw, LIP);
      const nx = -s, ny = c; // top normal
      const sAlong = i * DZ;
      const dOpen = Math.min(pl.openStart ? sAlong : 1e3, pl.openEnd ? len - sAlong : 1e3);
      const v = i * 6;
      const set = (k, x, y, nnx, nny, uu, side) => {
        A.position.setXYZ(v + k, x, y, z); A.normal.setXYZ(v + k, nnx, nny, 0);
        A.aDeck.setXYZW(v + k, uu, hw, sAlong, dOpen); A.aSide.setX(v + k, side);
        if (rot) { A.aRot.setXYZW(v + k, rot.amp, rot.omega, rot.phase, 0); A.aPivot.setXY(v + k, cx, cy + hc); }
        else A.aRot.setXYZW(v + k, 0, 0, 0, 0);
      };
      set(0, lx, ly, nx, ny, -hw, 0); set(1, rx, ry, nx, ny, hw, 0);
      set(2, lx, ly, -c, -s, -hw, 1); set(3, lbx, lby, -c, -s, -hw, 1);
      set(4, rx, ry, c, s, hw, 1); set(5, rbx, rby, c, s, hw, 1);
    }
    pm.commit(n);
    return pm;
  }

  buildTube(pl) {
    const pm = this.take('tube'), A = pm.attrs;
    const n = Math.min(pl.n, MAX_SAMPLES), rot = pl.rot;
    for (let i = 0; i < n; i++) {
      const z = pl.z0 - i * DZ, cx = pl.cx[i], cy = pl.cy[i], hw = pl.hw[i] + 0.02;
      const v = i * TUBE_VERTS, sAlong = i * DZ;
      const pts = OCT(hw);
      let per = 0;
      for (let f = 0; f < 7; f++) {
        const [x0, y0] = pts[f], [x1, y1] = pts[f + 1];
        const ex = x1 - x0, ey = y1 - y0, L = Math.hypot(ex, ey);
        const nx = -ey / L, ny = ex / L; // inward normal (points wind clockwise around the inside)
        for (const [k, x, y, p] of [[0, x0, y0, per], [1, x1, y1, per + L]]) {
          const vi = v + f * 2 + k;
          A.position.setXYZ(vi, cx + x, cy + y, z); A.normal.setXYZ(vi, nx, ny, 0);
          A.aTube.setXY(vi, p, sAlong);
          if (rot) { A.aRot.setXYZW(vi, rot.amp, rot.omega, rot.phase, 0); A.aPivot.setXY(vi, cx, cy + pl.pivot); }
          else A.aRot.setXYZW(vi, 0, 0, 0, 0);
        }
        per += L;
      }
    }
    pm.commit(n);
    return pm;
  }

  update(t, ballZ) {
    this.uRunTime.value = t;
    let k = 0;
    for (const c of this.course.chunks) {
      if (c.zEnd > ballZ + 40 || c.zStart < ballZ - 420) continue;
      for (const o of c.obstacles) {
        const nb = obstacleBoxes(o, t, this.boxes);
        for (let i = 0; i < nb && k < this.maxBoxes; i++) {
          const b = this.boxes[i];
          this.e.set(0, b.yaw, b.roll);
          this.m.compose(this.p.set(b.x, b.y, b.z), this.q.setFromEuler(this.e), this.sc.set(b.hx * 2, b.hy * 2, b.hz * 2));
          this.obst.setMatrixAt(k++, this.m);
        }
      }
    }
    this.obst.count = k;
    this.obst.instanceMatrix.needsUpdate = true;
  }
}
