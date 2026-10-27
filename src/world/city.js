import * as THREE from 'three';
import { worldMaterial, TRACK_W, trackY, GROUND_OFFSET } from './shared.js';

// Instanced tower canyon flanking the track. One draw call; window and edge-light
// patterns are generated in the shader. Instances are laid out tier-major so
// lowering `cityDensity` drops the outermost columns first (mesh.count).
const ROW_SPACING = 22;
const ROWS = 52;            // ~1.1 km of city
const TIERS = 6;            // columns per side, nearest first
const BEHIND = 90;

const VS = /* glsl */`
attribute vec4 aSeed; // x seed, y kind (0 normal / 1 hazard), z window density, w lit fraction
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vLocal; varying vec3 vScale; varying vec4 vSeed; varying vec3 vNormalL;
void main(){
  mat4 m = modelMatrix * instanceMatrix;
  vScale = vec3(length(m[0].xyz), length(m[1].xyz), length(m[2].xyz));
  vLocal = (position + vec3(0.0, 0.5, 0.0)) * vScale;   // metres from base corner-centre
  vNormalL = normal;
  vSeed = aSeed;
  vec4 wp = m * vec4(position + vec3(0.0, 0.5, 0.0), 1.0);
  vWorld = wp.xyz; vNormalW = normalize(mat3(m) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vLocal; varying vec3 vScale; varying vec4 vSeed; varying vec3 vNormalL;
void main(){
  vec3 n = normalize(vNormalW); vec3 nl = vNormalL;
  float seed = vSeed.x;
  // facade coords (metres): u across the face, v up
  vec2 fc; float faceW;
  if (abs(nl.x) > 0.5) { fc = vec2(vLocal.z, vLocal.y); faceW = vScale.z; }
  else if (abs(nl.z) > 0.5) { fc = vec2(vLocal.x, vLocal.y); faceW = vScale.x; }
  else { fc = vLocal.xz; faceW = vScale.x; }
  bool roof = abs(nl.y) > 0.5;
  float style = floor(vSeed.y + 0.5); // 0 grid, 1 hazard grid, 2 brutalist, 3 glass, 4 industrial
  vec3 neon = mix(uNeon, uNeon2, step(0.5, style) * step(style, 1.5));
  float t = uTime;

  // Slope-style facade grid
  float cellW = 3.2, cellH = 3.2;
  float gl = max(gridLine(fc.x, cellW, 0.05), gridLine(fc.y, cellH, 0.05));
  vec2 cell = floor(fc / vec2(cellW, cellH));
  float live = neonLive(vec2(seed * 91.0, 0.0) + floor(cell / 4.0), t);
  // surge running up vertical grid lines
  float surge = uSurge * surgePulse(fc.y * 6.0 + vWorld.z * 0.5, t * 1.3, seed) * gridLine(fc.x, cellW, 0.06);

  // windows inside each cell
  vec2 wf = fract(fc / vec2(cellW, cellH));
  float inWin = step(0.18, wf.x) * step(wf.x, 0.82) * step(0.22, wf.y) * step(wf.y, 0.78);
  float h = hash12(cell + seed * 17.0);
  float lit = step(1.0 - vSeed.w, h) * inWin * (1.0 - float(roof));
  float winFlick = 0.75 + 0.25 * sin(t * (1.0 + h * 4.0) + h * 30.0);
  vec3 warm = mix(vec3(1.0, 0.55, 0.25), vec3(0.6, 0.8, 1.0), step(0.7, hash11(h * 13.0)));
  // glass grime streaks + cracks
  float streak = uGrime * smoothstep(0.4, 0.9, vnoise(vec2(fc.x * 2.5, fc.y * 0.08 + seed * 10.0)));
  float crackN = vnoise(fc * 1.7 + seed * 3.0);
  float crack = uGrime * (1.0 - smoothstep(0.0, 0.02, abs(crackN - 0.5))) * step(0.82, hash12(cell * 0.25 + seed));
  vec3 win = warm * lit * winFlick * 0.9 * (1.0 - streak * 0.7) * mix(0.25, 1.0, uPower);
  win += vec3(0.25) * crack * inWin;

  // bright vertical edges + roof outline
  vec3 hs = vScale * 0.5; vec3 lp = vLocal - vec3(0.0, hs.y, 0.0);
  vec3 d = hs - abs(lp);
  float e = min(min(max(d.x, d.y), max(d.y, d.z)), max(d.x, d.z));
  float edge = 1.0 - smoothstep(0.12, 0.35, e);

  // height fade: grid fades into the mist near street level
  float hFade = smoothstep(0.0, 40.0, vLocal.y);
  vec3 base = vec3(0.006, 0.007, 0.009) * (1.0 - streak * 0.5);
  vec3 col = base * (0.3 + poolLight(vWorld, n) * 1.2) + base * uLightning * 6.0;
  float gridAmt = gl * live * 0.9 * hFade * mix(0.25, 1.0, uPower);
  col += neon * (gridAmt * 1.6 + surge * 5.0 + edge * 2.2 * live * mix(0.35, 1.0, uPower));
  col += win;
  float refl = roof ? 0.4 * uWet : 0.15;
  float emis = max(gridAmt, edge * live);
  if (style > 1.5 && style < 2.5) {
    // brutalist: dark concrete, floor bands, thin warm window slits, almost no neon
    float band = gridLine(fc.y, 4.0, 0.08);
    float slit = step(0.62, wf.y) * step(wf.y, 0.74) * step(0.55, hash12(floor(fc / vec2(2.0, 4.0)) + seed * 9.0)) * (1.0 - float(roof));
    vec3 conc = vec3(0.016, 0.015, 0.014) * (0.6 + 0.4 * vnoise(fc * 0.7 + seed * 5.0)) * (1.0 - streak * 0.6);
    col = conc * (0.4 + poolLight(vWorld, n) * 1.4) + conc * uLightning * 8.0 + vec3(0.02) * band
        + vec3(1.0, 0.5, 0.18) * slit * 1.4 * mix(0.2, 1.0, uPower) + uNeon2 * edge * 0.25;
    emis = slit * 0.6; refl = 0.05;
  } else if (style > 2.5 && style < 3.5) {
    // glass: deep blue curtain wall with vertical light strips that pulse upward
    float strip = gridLine(fc.x, 2.4, 0.06) * (1.0 - float(roof));
    float pulse = 0.6 + 0.4 * sin(fc.y * 0.15 - t * 2.0 + seed * 20.0);
    vec3 glass = vec3(0.004, 0.012, 0.03) + vec3(0.02, 0.05, 0.09) * pow(1.0 - abs(dot(n, normalize(uCamPos - vWorld))), 3.0);
    col = glass * (0.5 + poolLight(vWorld, n)) + vec3(0.25, 0.75, 1.0) * strip * pulse * 1.8 * mix(0.3, 1.0, uPower)
        + vec3(0.25, 0.75, 1.0) * edge * 1.2 + win * 0.3;
    emis = max(strip * pulse, edge); refl = roof ? 0.5 : 0.6;
  } else if (style > 3.5) {
    // industrial: rusted steel, hazard-striped bands, blinking red roof lights
    vec3 rust = mix(vec3(0.03, 0.014, 0.008), vec3(0.012, 0.012, 0.014), vnoise(fc * vec2(0.3, 1.2) + seed * 4.0)) * (1.0 - streak * 0.5);
    float bandY = step(fc.y, 2.2) + step(vScale.y - 2.0, fc.y);
    float hazard = step(0.5, fract((fc.x + fc.y) * 0.6)) * bandY * (1.0 - float(roof));
    float lamp = (1.0 - smoothstep(0.3, 0.6, e)) * step(vScale.y - 0.6, vLocal.y) * step(0.5, fract(t * 0.8 + seed * 7.0));
    col = rust * (0.5 + poolLight(vWorld, n) * 1.5) + rust * uLightning * 6.0 + vec3(0.9, 0.62, 0.05) * hazard * 0.35 * mix(0.3, 1.0, uPower)
        + vec3(1.0, 0.05, 0.03) * lamp * 8.0 + win * 0.5;
    emis = max(lamp, hazard * 0.25); refl = 0.08;
  }
  writeGBuffer(col, refl, (viewMatrix * vec4(n, 0.0)).xyz, emis);
}`;

// biomes cycle every ~900 m of run distance (same sequence every run: only the track changes)
export const BIOMES = ['grid', 'glass', 'brutalist', 'industrial', 'void'];
export function biomeAt(z) { const i = Math.floor((-z + 300 + (globalThis.__biomeShift || 0)) / 900); return i <= 0 ? 'grid' : BIOMES[i % BIOMES.length]; } // __biomeShift: debug only

export class City {
  constructor(scene, shared) {
    this.count = ROWS * TIERS * 2;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    this.seed = new Float32Array(this.count * 4);
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(this.seed, 4));
    this.mesh = new THREE.InstancedMesh(geo, worldMaterial({ uniforms: { ...shared }, vertexShader: VS, fragmentShader: FS }), this.count);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.rowZ = new Float32Array(ROWS);
    this.m = new THREE.Matrix4();
    this.reset(0);
  }

  idx(row, tier, side) { return (tier * 2 + side) * ROWS + row; }

  buildRow(row, z) {
    this.rowZ[row] = z;
    for (let tier = 0; tier < TIERS; tier++) {
      for (let side = 0; side < 2; side++) {
        const i = this.idx(row, tier, side);
        const sgn = side ? 1 : -1;
        const biome = biomeAt(z), R = Math.random;
        let w = 9 + R() * 14, d = 8 + R() * 12, topOff = tier === 0 ? -10 + R() * 70 : 5 + R() * 120, style = R() < 0.12 ? 1 : 0;
        if (biome === 'glass') { w = 7 + R() * 8; d = 7 + R() * 8; topOff = tier === 0 ? 30 + R() * 90 : 60 + R() * 140; style = 3; }
        else if (biome === 'brutalist') { w = 18 + R() * 14; d = 16 + R() * 12; topOff = tier === 0 ? -20 + R() * 50 : R() * 60; style = 2; }
        else if (biome === 'industrial') {
          const stack = R() < 0.22; style = 4;
          if (stack) { w = 3 + R() * 2; d = w; topOff = 30 + R() * 50; } else { w = 16 + R() * 20; d = 14 + R() * 16; topOff = -45 + R() * 40; }
        }
        const gap = tier === 0 ? 15 + R() * 7 : 0; // room for winding tracks (±9 m + width)
        const x = sgn * (TRACK_W / 2 + gap + w / 2 + tier * 26 + R() * 8);
        const zz = z + (R() - 0.5) * 8;
        const base = trackY(zz) - GROUND_OFFSET - 2;
        const h = Math.max(trackY(zz) + topOff - base, 20);
        // void: the classic Slope look — nothing but black around the track
        if (biome === 'void') this.m.makeScale(0.001, 0.001, 0.001).setPosition(x, base - 500, zz);
        else this.m.makeScale(w, h, d).setPosition(x, base, zz);
        this.mesh.setMatrixAt(i, this.m);
        this.seed.set([R(), style, 0.5 + R() * 0.5, 0.08 + R() * 0.3], i * 4);
      }
    }
  }

  reset(ballZ) {
    for (let r = 0; r < ROWS; r++) this.buildRow(r, ballZ + BEHIND - r * ROW_SPACING);
    this.farZ = ballZ + BEHIND - ROWS * ROW_SPACING;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.geometry.attributes.aSeed.needsUpdate = true;
  }

  update(ballZ, density) {
    let dirty = false;
    for (let r = 0; r < ROWS; r++) {
      if (this.rowZ[r] > ballZ + BEHIND) { this.buildRow(r, this.farZ); this.farZ -= ROW_SPACING; dirty = true; }
    }
    if (dirty) { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.geometry.attributes.aSeed.needsUpdate = true; }
    this.mesh.count = Math.max(2 * ROWS, Math.round(TIERS * density) * 2 * ROWS);
  }
}
