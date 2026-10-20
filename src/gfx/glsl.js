// Shared GLSL chunks. Every world/particle/post shader that needs wind, fog,
// pooled lights or the neon palette pulls them from here so there is exactly
// one definition of each.

export const HASH = /* glsl */ `
float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3){ p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1,0)), f.x), mix(hash12(i + vec2(0,1)), hash12(i + vec2(1,1)), f.x), f.y); }
float fbm2(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

// ---- the one shared wind field ------------------------------------------------
// Base flow + gust events + curl-noise turbulence. Mirrored exactly in wind.js
// (windAtCPU) for CPU-side consumers (splash, ball dust, lens droplets).
export const WIND = /* glsl */ `
uniform vec3 uWindDir;
uniform float uWindStrength;
uniform float uGust;
uniform vec3 uGustDir;
uniform float uTurbulence;
uniform float uTime;
uniform vec3 uWindOffset;
vec3 windPot(vec3 p){
  return vec3(
    sin(p.y * 1.3 + uTime * 0.31) + sin(p.z * 0.7 - uTime * 0.23),
    sin(p.z * 1.1 + uTime * 0.27) + sin(p.x * 0.9 + uTime * 0.19),
    sin(p.x * 1.2 - uTime * 0.29) + sin(p.y * 0.8 + uTime * 0.21));
}
vec3 curlNoise(vec3 p){
  const float e = 0.1;
  vec3 px0 = windPot(p - vec3(e,0,0)), px1 = windPot(p + vec3(e,0,0));
  vec3 py0 = windPot(p - vec3(0,e,0)), py1 = windPot(p + vec3(0,e,0));
  vec3 pz0 = windPot(p - vec3(0,0,e)), pz1 = windPot(p + vec3(0,0,e));
  return vec3((py1.z - py0.z) - (pz1.y - pz0.y),
              (pz1.x - pz0.x) - (px1.z - px0.z),
              (px1.y - px0.y) - (py1.x - py0.x)) / (2.0 * e);
}
vec3 windAt(vec3 p){
  vec3 base = uWindDir * uWindStrength + uGustDir * (uGust * uWindStrength * 1.5);
  return base + curlNoise(p * 0.035) * uTurbulence * (0.4 + uWindStrength * 0.25);
}
`;

// ---- palette -------------------------------------------------------------------
export const PALETTE = /* glsl */ `
uniform vec3 uNeon;      // primary grid colour
uniform vec3 uNeon2;     // hazard / obstacle colour
uniform vec3 uSmog;      // sky glow colour
uniform float uPower;    // 0 = blackout, 1 = full grid power
uniform float uFlicker;  // neon flicker amount
uniform float uSurge;    // power surge pulse enable/strength
`;

// ---- slope frame + fog -----------------------------------------------------------
// The whole world rides on an inclined plane: track y = z * slopeTan.
// Street level sits uGroundOffset below the track and follows the same slope.
export const FOG = /* glsl */ `
uniform float uSlopeTan;
uniform float uGroundOffset;
uniform float uFogDensity;
uniform vec3 uFogColor;
uniform float uMistHeight;
uniform float uMistDensity;
uniform float uReactDist;
uniform float uFogNearCap;
uniform vec3 uDistrictA;
uniform vec3 uDistrictB;
float trackY(float z){ return z * uSlopeTan; }
float groundY(float z){ return z * uSlopeTan - uGroundOffset; }
float districtF(float z){ float d = -z / 520.0; float i = floor(d); return mix(hash11(i * 7.13), hash11((i + 1.0) * 7.13), smoothstep(0.75, 1.0, fract(d))); }
vec3 districtTint(float z){ return mix(uDistrictA, uDistrictB, districtF(z)); }
float fogDensityAt(vec3 p){
  float h = p.y - groundY(p.z);
  float dist = 0.6 + 0.8 * districtF(p.z);
  float base = uFogDensity * dist * exp(-max(h, 0.0) * 0.012);
  float mist = uMistDensity * exp(-max(h, 0.0) / max(uMistHeight, 0.5));
  return base + mist;
}
// readability guarantee: inside the reaction distance fog may never exceed the cap
float capFog(float fogAmt, float viewDist){
  float cap = mix(uFogNearCap, 1.0, smoothstep(uReactDist, uReactDist * 1.5, viewDist));
  return min(fogAmt, cap);
}
// cheap 4-tap transmittance for particles / anything forward-shaded
float fogAmountTo(vec3 cam, vec3 p){
  vec3 d = p - cam; float L = length(d); float od = 0.0;
  for (int i = 0; i < 4; i++){ od += fogDensityAt(cam + d * ((float(i) + 0.5) / 4.0)); }
  od *= L / 4.0;
  return capFog(1.0 - exp(-od), L);
}
`;

// ---- pooled dynamic lights + analytic ball shadow --------------------------------
export const LIGHTS = /* glsl */ `
#define MAX_POOL 16
uniform vec4 uPoolPos[MAX_POOL];
uniform vec4 uPoolCol[MAX_POOL];
uniform int uPoolCount;
uniform vec4 uBall;           // xyz centre, w radius
uniform int uShadowMode;      // 0 off, 1 blob, 2 soft (4 lights), 3 soft (all)
float sphereShadow(vec3 p, vec3 L, float maxT){
  vec3 oc = uBall.xyz - p; float t = clamp(dot(oc, L), 0.0, maxT);
  float d = length(oc - L * t);
  float k = max(t * 0.12, 0.05);
  return smoothstep(uBall.w - k, uBall.w + k, d);
}
float ballBlob(vec3 p){
  if (uShadowMode == 0) return 1.0;
  vec2 dxz = p.xz - uBall.xz; float h = uBall.y - p.y;
  float r = uBall.w * (1.1 + h * 0.15);
  return mix(0.35, 1.0, smoothstep(r * 0.5, r * 1.6, length(dxz))) ;
}
vec3 poolLight(vec3 p, vec3 n){
  vec3 acc = vec3(0.0);
  int nShadow = uShadowMode == 3 ? MAX_POOL : (uShadowMode == 2 ? 4 : 0);
  for (int i = 0; i < MAX_POOL; i++){
    if (i >= uPoolCount) break;
    vec3 L = uPoolPos[i].xyz - p; float d = max(length(L), 1e-3); float r = uPoolPos[i].w;
    float att = clamp(1.0 - d / r, 0.0, 1.0); att *= att;
    L /= d;
    float s = 1.0;
    if (i < nShadow && att > 0.0) s = sphereShadow(p, L, d);
    acc += uPoolCol[i].rgb * (att * (max(dot(n, L), 0.0) * 0.8 + 0.2) * s);
  }
  return acc;
}
`;

// MRT outputs written by every opaque world material.
export const MRT_OUT = /* glsl */ `
layout(location = 0) out highp vec4 gColor;   // rgb HDR, a = reflectivity
layout(location = 1) out highp vec4 gNormal;  // view normal * .5 + .5, a = emissive (selective bloom) mask
void writeGBuffer(vec3 col, float refl, vec3 viewN, float emissive){
  gColor = vec4(max(col, vec3(0.0)), refl);
  gNormal = vec4(normalize(viewN) * 0.5 + 0.5, clamp(emissive, 0.0, 1.0));
}
`;

// Grid-line helper: anti-aliased distance-to-line in world units.
export const GRID = /* glsl */ `
float gridLine(float coord, float spacing, float width){
  float f = abs(fract(coord / spacing + 0.5) - 0.5) * spacing;
  float w = fwidth(coord) + 1e-4;
  return 1.0 - smoothstep(width - w, width + w, f);
}
// travelling power surge along a coordinate
float surgePulse(float coord, float t, float seed){
  float ph = fract((coord * 0.004) - t * 0.35 + seed);
  return smoothstep(0.0, 0.015, ph) * (1.0 - smoothstep(0.015, 0.06, ph));
}
`;
