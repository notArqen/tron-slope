import * as THREE from 'three';
import { HASH, WIND, PALETTE, FOG, LIGHTS, MRT_OUT, GRID } from '../gfx/glsl.js';

export const SLOPE_DEG = 11;
export const SLOPE_TAN = Math.tan(THREE.MathUtils.degToRad(SLOPE_DEG));
export const GROUND_OFFSET = 70;
export const TRACK_W = 7;
export const trackY = (z) => z * SLOPE_TAN;

export const PALETTES = {
  slope:  { neon: [0.12, 1.0, 0.18], neon2: [1.0, 0.07, 0.05], smog: [1.0, 0.42, 0.12] },
  tron:   { neon: [0.08, 0.72, 1.0], neon2: [1.0, 0.42, 0.05], smog: [0.95, 0.45, 0.2] },
  legacy: { neon: [1.0, 0.5, 0.1], neon2: [0.15, 0.75, 1.0], smog: [1.0, 0.38, 0.1] },
  ares:   { neon: [1.0, 0.08, 0.05], neon2: [0.85, 0.9, 1.0], smog: [0.85, 0.2, 0.12] },
};

// Uniform objects shared *by reference* across every world material.
export function createShared(wind) {
  const MAX = 16;
  const u = {
    ...wind.uniforms,
    uNeon: { value: new THREE.Color(...PALETTES.slope.neon) },
    uNeon2: { value: new THREE.Color(...PALETTES.slope.neon2) },
    uSmog: { value: new THREE.Color(...PALETTES.slope.smog) },
    uPower: { value: 1 },
    uFlicker: { value: 0.2 },
    uSurge: { value: 1 },
    uSlopeTan: { value: SLOPE_TAN },
    uGroundOffset: { value: GROUND_OFFSET },
    uFogDensity: { value: 0.005 },
    uFogColor: { value: new THREE.Color(0.4, 0.3, 0.3) },
    uMistHeight: { value: 9 },
    uMistDensity: { value: 0.02 },
    uReactDist: { value: 40 },
    uFogNearCap: { value: 0.3 },
    uDistrictA: { value: new THREE.Color(1.0, 0.55, 0.3) },
    uDistrictB: { value: new THREE.Color(0.55, 0.6, 1.0) },
    uPoolPos: { value: Array.from({ length: MAX }, () => new THREE.Vector4()) },
    uPoolCol: { value: Array.from({ length: MAX }, () => new THREE.Vector4()) },
    uPoolCount: { value: 0 },
    uBall: { value: new THREE.Vector4(0, 0, 0, 0.5) },
    uShadowMode: { value: 2 },
    uWet: { value: 0.5 },
    uPuddle: { value: 0.5 },
    uRain: { value: 0 },
    uGrime: { value: 1 },
    uCamPos: { value: new THREE.Vector3() },
    uLightning: { value: 0 },
    uLightningAz: { value: 0 },
  };
  return u;
}

export const WORLD_HEADER = HASH + WIND + PALETTE + FOG + LIGHTS + /* glsl */`
uniform float uWet; uniform float uPuddle; uniform float uRain; uniform float uGrime;
uniform vec3 uCamPos; uniform float uLightning; uniform float uLightningAz;
// neon flicker / dead-section mask for a grid cell id
float neonLive(vec2 cell, float t){
  float h = hash12(cell);
  float dead = step(h, 0.08 + (1.0 - uPower) * 0.85);              // dead sections grow in blackout
  float buzz = step(0.86, hash12(cell + floor(t * 13.0))) * step(0.7, h); // fast buzz
  float slow = 0.5 + 0.5 * sin(t * (3.0 + h * 20.0) + h * 40.0);
  float f = 1.0 - uFlicker * (buzz * 0.85 + (1.0 - slow) * 0.15 * step(0.5, h));
  return (1.0 - dead) * f;
}
`;

// Build a GLSL3 ShaderMaterial that writes the MRT gbuffer.
export function worldMaterial({ uniforms, vertexShader, fragmentShader, defines = {}, ...rest }) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms,
    defines,
    vertexShader: WORLD_HEADER + vertexShader,
    fragmentShader: MRT_OUT + WORLD_HEADER + GRID + fragmentShader,
    ...rest,
  });
}
