// Fullscreen post-processing shaders. All GLSL3; `fragColor` is location 0.
import { HASH, WIND, FOG } from '../gfx/glsl.js';
import { VOLUME_GLSL } from '../world/dystopia.js';

export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const HEAD = /* glsl */`
layout(location = 0) out highp vec4 fragColor;
varying vec2 vUv;
`;

// depth/position reconstruction helpers
const DEPTH = /* glsl */`
uniform sampler2D tDepth; uniform mat4 uInvProj; uniform mat4 uProj; uniform vec2 uNearFar;
float rawDepth(vec2 uv){ return texture(tDepth, uv).r; }
vec3 viewPosFrom(vec2 uv, float d){ vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return p.xyz / p.w; }
vec3 viewPos(vec2 uv){ return viewPosFrom(uv, rawDepth(uv)); }
vec2 projectUV(vec3 vp){ vec4 c = uProj * vec4(vp, 1.0); return c.xy / c.w * 0.5 + 0.5; }
`;
const NORMAL = /* glsl */`
uniform sampler2D tNormal;
vec3 viewNormal(vec2 uv){ vec3 n = texture(tNormal, uv).xyz * 2.0 - 1.0; return n; }
bool isSky(vec3 n){ return dot(n, n) < 0.05; }
`;

// ---------------------------------------------------------------- AO (GTAO-style horizon)
export const AO_FS = HEAD + HASH + DEPTH + NORMAL + /* glsl */`
uniform float uRadius; uniform float uIntensity; uniform int uSamples; uniform float uFrame;
void main(){
  vec3 n = viewNormal(vUv);
  float d = rawDepth(vUv);
  if (isSky(n) || d >= 1.0) { fragColor = vec4(1.0); return; }
  vec3 P = viewPosFrom(vUv, d);
  n = normalize(n);
  // project radius to screen
  float rs = uRadius * uProj[1][1] / max(-P.z, 0.1) * 0.5;
  float occ = 0.0;
  float rnd = hash12(gl_FragCoord.xy + uFrame * 7.31) * 6.2831853;
  for (int i = 0; i < 16; i++){
    if (i >= uSamples) break;
    float a = rnd + float(i) * 2.39996;
    float r = sqrt((float(i) + 0.5) / float(uSamples)) * rs;
    vec2 suv = vUv + vec2(cos(a), sin(a)) * r * vec2(uProj[1][1] / uProj[0][0], 1.0);
    vec3 S = viewPos(suv);
    vec3 v = S - P; float L = length(v);
    float h = max(dot(n, v / max(L, 1e-4)) - 0.08, 0.0);
    occ += h * (1.0 - smoothstep(uRadius * 0.6, uRadius * 1.4, L));
  }
  occ = 1.0 - occ / float(uSamples) * uIntensity * 1.6;
  fragColor = vec4(vec3(clamp(occ, 0.0, 1.0)), 1.0);
}`;

// ---------------------------------------------------------------- SSR
export const SSR_FS = HEAD + HASH + DEPTH + NORMAL + /* glsl */`
uniform sampler2D tColor; uniform int uSteps; uniform float uFrame; uniform float uMaxDist;
void main(){
  vec4 c0 = texture(tColor, vUv);
  float refl = c0.a;
  vec3 n = viewNormal(vUv);
  float d = rawDepth(vUv);
  if (refl < 0.04 || isSky(n) || d >= 1.0) { fragColor = vec4(0.0); return; }
  n = normalize(n);
  vec3 P = viewPosFrom(vUv, d);
  vec3 V = normalize(P);
  vec3 R = normalize(reflect(V, n));
  if (R.z > 0.0 && -P.z < 2.0) { fragColor = vec4(0.0); return; }
  float jitter = hash12(gl_FragCoord.xy + uFrame * 3.17);
  float stepLen = uMaxDist / float(uSteps);
  vec3 pos = P + R * stepLen * (0.3 + jitter);
  vec2 hitUV = vec2(-1.0); float thick = 0.0;
  for (int i = 0; i < 64; i++){
    if (i >= uSteps) break;
    vec2 uv = projectUV(pos);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    float sz = viewPos(uv).z;
    float dz = sz - pos.z;
    if (dz > 0.0 && dz < stepLen * 2.5 + 0.02 * -pos.z) {
      // binary refine
      vec3 a = pos - R * stepLen, b = pos;
      for (int k = 0; k < 4; k++){ vec3 m = (a + b) * 0.5; vec2 mu = projectUV(m); if (viewPos(mu).z > m.z) b = m; else a = m; }
      hitUV = projectUV(b); break;
    }
    pos += R * stepLen;
    stepLen *= 1.06;
  }
  if (hitUV.x < 0.0) { fragColor = vec4(0.0); return; }
  vec2 e = smoothstep(vec2(0.0), vec2(0.08), hitUV) * smoothstep(vec2(0.0), vec2(0.08), 1.0 - hitUV);
  float fade = e.x * e.y;
  vec3 hc = texture(tColor, hitUV).rgb;
  fragColor = vec4(hc, fade);
}`;

// ---------------------------------------------------------------- cheap SSGI (one-bounce neon bleed)
export const GI_FS = HEAD + HASH + DEPTH + NORMAL + /* glsl */`
uniform sampler2D tColor; uniform float uFrame;
void main(){
  vec3 n = viewNormal(vUv); float d = rawDepth(vUv);
  if (isSky(n) || d >= 1.0) { fragColor = vec4(0.0); return; }
  n = normalize(n);
  vec3 P = viewPosFrom(vUv, d);
  vec3 acc = vec3(0.0); float rnd = hash12(gl_FragCoord.xy + uFrame) * 6.28;
  float rs = 6.0 * uProj[1][1] / max(-P.z, 0.5) * 0.5;
  for (int i = 0; i < 6; i++){
    float a = rnd + float(i) * 2.39996; float r = (float(i) + 0.5) / 6.0 * rs;
    vec2 suv = vUv + vec2(cos(a), sin(a)) * r * vec2(uProj[1][1] / uProj[0][0], 1.0);
    if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) continue;
    vec3 S = viewPos(suv); vec3 v = S - P; float L = length(v);
    float w = max(dot(n, v / max(L, 1e-3)), 0.0) / (1.0 + L * L * 0.08);
    float em = texture(tNormal, suv).a;
    acc += texture(tColor, suv).rgb * em * w;
  }
  fragColor = vec4(acc / 6.0, 1.0);
}`;

// ---------------------------------------------------------------- volumetric fog + shafts (half res)
export const FOG_FS = HEAD + HASH + WIND + FOG + VOLUME_GLSL + DEPTH + NORMAL + /* glsl */`
uniform mat4 uCamWorld; uniform vec3 uCamPos; uniform int uSteps; uniform float uFrame;
uniform float uVolStrength; uniform float uGlow; uniform vec3 uSmog; uniform float uLightning; uniform int uVolumetric; uniform float uFogOn;
void main(){
  float d = rawDepth(vUv);
  vec3 n = viewNormal(vUv);
  vec3 vp = viewPosFrom(vUv, min(d, 0.99999));
  bool sky = isSky(n) || d >= 1.0;
  if (sky) vp = normalize(vp) * 420.0;
  vec3 wp = (uCamWorld * vec4(vp, 1.0)).xyz;
  vec3 ro = uCamPos; vec3 rd = wp - ro; float dist = length(rd); rd /= dist;
  int steps = uVolumetric == 1 ? uSteps : 4;
  float jitter = hash12(gl_FragCoord.xy + fract(uFrame * 0.618) * 100.0);
  float dt = dist / float(steps);
  float T = 1.0; vec3 L = vec3(0.0);
  vec3 amb = uFogColor * (0.06 + uGlow * 0.05) + uSmog * uGlow * 0.04;
  for (int i = 0; i < 32; i++){
    if (i >= steps) break;
    float t = (float(i) + jitter) * dt;
    vec3 x = ro + rd * t;
    // fog drift: density advected by the shared wind field
    float drift = 0.55 + 0.9 * vnoise((x.xz - uWindOffset.xz) * 0.025 + vec2(x.y * 0.02));
    float sigma = fogDensityAt(x) * drift * uFogOn;
    vec3 tint = districtTint(x.z);
    vec3 S = amb * tint + vec3(0.5, 0.55, 0.8) * uLightning * 0.35;
    if (uVolumetric == 1) S += coneLight(x) * uVolStrength;
    float a = exp(-sigma * dt);
    L += T * S * (1.0 - a) / max(sigma, 1e-5) * sigma;
    T *= a;
  }
  // readability guarantee: fog opacity inside the reaction distance is capped
  float fogAmt = 1.0 - T;
  float capped = sky ? fogAmt : capFog(fogAmt, dist);
  float k = fogAmt > 1e-4 ? capped / fogAmt : 1.0;
  fragColor = vec4(L * k, 1.0 - capped);
}`;

// ---------------------------------------------------------------- god rays (screen-space radial)
export const GOD_FS = HEAD + NORMAL + /* glsl */`
uniform sampler2D tColor; uniform vec2 uSun; uniform float uStrength; uniform float uVisible;
void main(){
  vec2 dir = (uSun - vUv) / 40.0; vec2 uv = vUv; float decay = 1.0; vec3 acc = vec3(0.0);
  for (int i = 0; i < 40; i++){
    uv += dir;
    vec3 n = texture(tNormal, uv).xyz * 2.0 - 1.0;
    float skyM = dot(n, n) < 0.05 ? 1.0 : 0.0;
    acc += min(texture(tColor, uv).rgb, vec3(4.0)) * skyM * decay;
    decay *= 0.965;
  }
  fragColor = vec4(acc / 40.0 * uStrength * uVisible, 1.0);
}`;

// ---------------------------------------------------------------- composite (lighting + fog + particles)
export const COMPOSITE_FS = HEAD + DEPTH + NORMAL + /* glsl */`
uniform sampler2D tColor; uniform sampler2D tAO; uniform sampler2D tSSR; uniform sampler2D tPlanar; uniform sampler2D tGI;
uniform sampler2D tFog; uniform sampler2D tGod; uniform sampler2D tPart;
uniform int uAO; uniform int uRefl; uniform int uGI; uniform int uFog; uniform int uGod; uniform int uHaze;
uniform float uReflStrength; uniform float uGIStrength; uniform float uHazeStrength; uniform vec3 uSmog;
uniform mat4 uCamWorld; uniform mat4 uMirrorVP; uniform vec2 uTexel;
void main(){
  vec4 c = texture(tColor, vUv);
  vec3 col = c.rgb;
  vec3 n = viewNormal(vUv);
  bool sky = isSky(n);
  float d = rawDepth(vUv);
  vec3 vp = viewPosFrom(vUv, d);
  if (!sky) {
    if (uAO == 1) {
      // 4-tap depth-aware blur of the half-res AO
      float ao = 0.0, wsum = 0.0;
      for (int i = 0; i < 4; i++){
        vec2 o = vec2(float(i & 1) - 0.5, float(i >> 1) - 0.5) * uTexel * 2.0;
        float w = 1.0 / (1.0 + abs(viewPos(vUv + o).z - vp.z) * 4.0);
        ao += texture(tAO, vUv + o).r * w; wsum += w;
      }
      col *= ao / wsum;
    }
    if (uGI == 1) col += texture(tGI, vUv).rgb * uGIStrength * (1.0 - texture(tNormal, vUv).a);
    if (uRefl > 0 && c.a > 0.04) {
      vec3 V = normalize(-vp); float fres = 0.04 + 0.96 * pow(1.0 - max(dot(normalize(n), V), 0.0), 5.0);
      vec3 rc = vec3(0.0); float conf = 0.0;
      if (uRefl == 1) { // planar fallback
        vec3 wp = (uCamWorld * vec4(vp, 1.0)).xyz;
        vec4 mc = uMirrorVP * vec4(wp, 1.0); vec2 muv = mc.xy / mc.w * 0.5 + 0.5;
        muv += normalize(n).xz * 0.02;
        rc = texture(tPlanar, muv).rgb; conf = 1.0;
      } else { vec4 s = texture(tSSR, vUv); rc = s.rgb; conf = s.a; }
      col += rc * conf * c.a * mix(0.35, 1.0, fres) * uReflStrength;
    }
  }
  float dist = sky ? 400.0 : length(vp);
  if (uFog == 1) { vec4 f = texture(tFog, vUv); col = col * f.a + f.rgb; }
  if (uHaze == 1) {
    float h = (1.0 - exp(-dist * 0.0025)) * uHazeStrength;
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, mix(col, uSmog * l * 1.5 + uSmog * 0.01, 0.7), h);
  }
  if (uGod == 1) col += texture(tGod, vUv).rgb;
  vec4 p = texture(tPart, vUv);
  col = col * (1.0 - p.a) + p.rgb;
  fragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- TAA resolve
export const TAA_FS = HEAD + DEPTH + /* glsl */`
uniform sampler2D tCurrent; uniform sampler2D tHistory; uniform mat4 uCamWorld; uniform mat4 uPrevVP; uniform vec2 uTexel; uniform float uReset;
vec3 toYCoCg(vec3 c){ return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25))); }
vec3 fromYCoCg(vec3 c){ return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
void main(){
  vec3 cur = texture(tCurrent, vUv).rgb;
  vec3 mn = vec3(1e9), mx = vec3(-1e9), m1 = vec3(0.0), m2 = vec3(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec3 s = toYCoCg(texture(tCurrent, vUv + vec2(x, y) * uTexel).rgb / (1.0 + texture(tCurrent, vUv + vec2(x, y) * uTexel).rgb));
    m1 += s; m2 += s * s;
  }
  m1 /= 9.0; vec3 sd = sqrt(max(m2 / 9.0 - m1 * m1, 0.0));
  mn = m1 - sd * 1.25; mx = m1 + sd * 1.25;
  float d = rawDepth(vUv);
  vec3 wp = (uCamWorld * vec4(viewPosFrom(vUv, min(d, 0.9999)), 1.0)).xyz;
  vec4 pc = uPrevVP * vec4(wp, 1.0); vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  vec3 hist = texture(tHistory, puv).rgb;
  vec3 hy = toYCoCg(hist / (1.0 + hist));
  hy = clamp(hy, mn, mx);
  vec3 h = fromYCoCg(hy); h = h / max(1.0 - h, vec3(1e-3));
  float off = (puv.x < 0.0 || puv.y < 0.0 || puv.x > 1.0 || puv.y > 1.0) ? 1.0 : 0.0;
  float vel = length((puv - vUv) / uTexel);
  float a = mix(0.1, 0.35, clamp(vel / 30.0, 0.0, 1.0));
  a = max(a, max(off, uReset));
  fragColor = vec4(mix(h, cur, a), 1.0);
}`;

// ---------------------------------------------------------------- motion: heat haze + camera motion blur + radial speed blur
export const MOTION_FS = HEAD + HASH + DEPTH + /* glsl */`
uniform sampler2D tColor; uniform mat4 uCamWorld; uniform mat4 uPrevVP; uniform float uTime;
uniform int uMB; uniform float uMBStrength; uniform int uMBSamples;
uniform int uRadial; uniform float uRadialStrength; uniform vec2 uCenter;
uniform int uHaze; uniform float uHazeStrength; uniform float uSlopeTan; uniform vec4 uVents[8];
void main(){
  vec2 uv = vUv;
  float d = rawDepth(vUv);
  vec3 vp = viewPosFrom(vUv, min(d, 0.9999));
  vec3 wp = (uCamWorld * vec4(vp, 1.0)).xyz;
  if (uHaze == 1) {
    float above = wp.y - wp.z * uSlopeTan;
    float m = exp(-max(above, 0.0) * 1.2) * smoothstep(8.0, 30.0, length(vp)) * (1.0 - smoothstep(150.0, 260.0, length(vp)));
    for (int i = 0; i < 8; i++){ vec3 dv = wp - uVents[i].xyz; m += exp(-dot(dv.xz, dv.xz) * 0.4) * step(0.0, dv.y) * exp(-dv.y * 0.3); }
    vec2 nn = vec2(vnoise(uv * vec2(60.0, 30.0) + vec2(0.0, -uTime * 4.0)), vnoise(uv * vec2(55.0, 33.0) + vec2(3.1, -uTime * 3.3))) - 0.5;
    uv += nn * 0.006 * uHazeStrength * clamp(m, 0.0, 1.5);
  }
  vec3 col = vec3(0.0); float wsum = 0.0;
  vec2 vel = vec2(0.0);
  if (uMB == 1) {
    vec4 pc = uPrevVP * vec4(wp, 1.0); vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
    vel = (vUv - puv) * uMBStrength;
    float l = length(vel); if (l > 0.06) vel *= 0.06 / l;
  }
  vec2 rad = vec2(0.0);
  if (uRadial == 1) rad = (uv - uCenter) * uRadialStrength * 0.06;
  int n = (uMB == 1 || uRadial == 1) ? uMBSamples : 1;
  float j = hash12(gl_FragCoord.xy) - 0.5;
  for (int i = 0; i < 16; i++){
    if (i >= n) break;
    float t = n > 1 ? (float(i) + j) / float(n - 1) - 0.5 : 0.0;
    vec2 o = vel * t - rad * (t + 0.5);
    col += texture(tColor, uv + o).rgb; wsum += 1.0;
  }
  fragColor = vec4(col / wsum, 1.0);
}`;

// ---------------------------------------------------------------- DOF (half-res gather + composite)
const COC = /* glsl */`
uniform float uFocus; uniform float uAperture; uniform float uMaxBlur; uniform float uDofStart;
// far-field only: nothing nearer than uDofStart blurs, so the track you read stays sharp
float cocAt(vec2 uv){ float z = -viewPos(uv).z; return clamp(uAperture * smoothstep(uDofStart, uDofStart * 2.5, z), 0.0, 1.0); }
`;
export const DOF_PREP_FS = HEAD + DEPTH + COC + /* glsl */`
uniform sampler2D tColor;
void main(){ fragColor = vec4(texture(tColor, vUv).rgb, cocAt(vUv)); }`;
export const DOF_BLUR_FS = HEAD + /* glsl */`
uniform sampler2D tPrep; uniform int uSamples; uniform vec2 uTexel; uniform float uMaxBlur;
void main(){
  vec4 c = texture(tPrep, vUv); float c0 = c.a;
  vec3 acc = c.rgb; float wsum = 1.0;
  for (int i = 0; i < 48; i++){
    if (i >= uSamples) break;
    float r = sqrt((float(i) + 0.5) / float(uSamples));
    float a = float(i) * 2.39996;
    vec4 s = texture(tPrep, vUv + vec2(cos(a), sin(a)) * r * uMaxBlur * uTexel);
    // gather: a tap contributes if its own CoC covers this distance (near-field bleeds over focus)
    float cover = smoothstep(r - 0.1, r, max(abs(s.a), abs(c0) * step(0.0, c0)));
    float w = cover * (1.0 + dot(s.rgb, vec3(0.3)) * 0.4);
    acc += s.rgb * w; wsum += w;
  }
  fragColor = vec4(acc / wsum, abs(c0));
}`;
export const DOF_COMP_FS = HEAD + /* glsl */`
uniform sampler2D tColor; uniform sampler2D tBlur; uniform sampler2D tPrep;
void main(){
  vec3 sharp = texture(tColor, vUv).rgb; vec4 b = texture(tBlur, vUv);
  float c = abs(texture(tPrep, vUv).a);
  fragColor = vec4(mix(sharp, b.rgb, smoothstep(0.05, 0.4, max(c, b.a))), 1.0);
}`;

// ---------------------------------------------------------------- bloom
export const BRIGHT_FS = HEAD + /* glsl */`
uniform sampler2D tColor; uniform sampler2D tMask; uniform float uThreshold; uniform float uSelective; uniform vec2 uTexel;
void main(){
  vec3 c = vec3(0.0); float m = 0.0;
  for (int i = 0; i < 4; i++){ vec2 o = vec2(float(i & 1) - 0.5, float(i >> 1) - 0.5) * uTexel; c += texture(tColor, vUv + o).rgb; m += texture(tMask, vUv + o).a; }
  c *= 0.25; m *= 0.25;
  c = min(c, vec3(64.0));
  float l = max(c.r, max(c.g, c.b));
  float knee = 0.5;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee); soft = soft * soft / (4.0 * knee + 1e-4);
  float contrib = max(soft, l - uThreshold) / max(l, 1e-4);
  fragColor = vec4(c * max(contrib, 0.0) + c * m * uSelective, 1.0);
}`;
export const DOWN_FS = HEAD + /* glsl */`
uniform sampler2D tColor; uniform vec2 uTexel;
void main(){
  vec3 a = texture(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(tColor, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture(tColor, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(tColor, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  vec3 b = texture(tColor, vUv).rgb;
  fragColor = vec4(a * 0.125 + b * 0.5, 1.0);
}`;
export const UP_FS = HEAD + /* glsl */`
uniform sampler2D tColor; uniform sampler2D tLow; uniform vec2 uTexel; uniform float uRadius;
void main(){
  vec3 l = vec3(0.0);
  l += texture(tLow, vUv + uTexel * vec2(-1, -1)).rgb + texture(tLow, vUv + uTexel * vec2(1, -1)).rgb;
  l += texture(tLow, vUv + uTexel * vec2(-1, 1)).rgb + texture(tLow, vUv + uTexel * vec2(1, 1)).rgb;
  l += (texture(tLow, vUv + uTexel * vec2(0, -1)).rgb + texture(tLow, vUv + uTexel * vec2(0, 1)).rgb
     + texture(tLow, vUv + uTexel * vec2(-1, 0)).rgb + texture(tLow, vUv + uTexel * vec2(1, 0)).rgb) * 2.0;
  l += texture(tLow, vUv).rgb * 4.0;
  fragColor = vec4(texture(tColor, vUv).rgb + l / 16.0 * uRadius, 1.0);
}`;
export const STREAK_FS = HEAD + /* glsl */`
uniform sampler2D tColor; uniform vec2 uTexel; uniform float uSpread;
void main(){
  vec3 acc = vec3(0.0); float w = 0.0;
  for (int i = -4; i <= 4; i++){ float k = exp(-float(i * i) * 0.12); acc += texture(tColor, vUv + vec2(float(i) * uSpread * uTexel.x, 0.0)).rgb * k; w += k; }
  fragColor = vec4(acc / w, 1.0);
}`;
export const FLARE_FS = HEAD + /* glsl */`
uniform sampler2D tColor; uniform int uGhosts; uniform float uDispersal;
vec3 chroma(vec2 uv, vec2 dir){ return vec3(texture(tColor, uv + dir * 0.006).r, texture(tColor, uv).g, texture(tColor, uv - dir * 0.006).b); }
void main(){
  vec2 uv = 1.0 - vUv; vec2 gv = (0.5 - uv) * uDispersal; vec3 acc = vec3(0.0);
  for (int i = 0; i < 8; i++){
    if (i >= uGhosts) break;
    vec2 o = fract(uv + gv * float(i));
    float w = pow(1.0 - length(0.5 - o) / 0.7071, 6.0);
    acc += chroma(o, normalize(gv + 1e-4)) * w * (i % 2 == 0 ? vec3(0.5, 0.8, 1.0) : vec3(1.0, 0.6, 0.4));
  }
  vec2 hv = normalize(gv + 1e-4) * 0.42;
  float hw = pow(1.0 - length(0.5 - fract(uv + hv)) / 0.7071, 9.0);
  acc += chroma(fract(uv + hv), hv) * hw * vec3(0.6, 0.7, 1.0);
  fragColor = vec4(acc, 1.0);
}`;

// ---------------------------------------------------------------- auto exposure
export const LUM_FS = HEAD + /* glsl */`
uniform sampler2D tColor; uniform vec2 uTexel; uniform int uFirst;
void main(){
  float s = 0.0;
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++){
    vec2 o = (vec2(x, y) - 1.5) * uTexel;
    vec3 c = texture(tColor, vUv + o).rgb;
    s += uFirst == 1 ? log(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4)) : c.r;
  }
  fragColor = vec4(s / 16.0, 0.0, 0.0, 1.0);
}`;
export const ADAPT_FS = HEAD + /* glsl */`
uniform sampler2D tPrev; uniform sampler2D tCur; uniform float uRate;
void main(){ float p = texture(tPrev, vec2(0.5)).r; float c = texture(tCur, vec2(0.5)).r;
  if (p != p || p == 0.0) p = c;
  fragColor = vec4(mix(p, c, uRate), 0.0, 0.0, 1.0); }`;

// ---------------------------------------------------------------- grade / tonemap
export const GRADE_FS = HEAD + /* glsl */`
precision highp sampler3D;
uniform sampler2D tColor; uniform sampler2D tBloom; uniform sampler2D tStreak; uniform sampler2D tFlare; uniform sampler2D tBloomLow; uniform sampler2D tDirt; uniform sampler2D tAdapt;
uniform sampler3D tLUT;
uniform int uBloom; uniform int uStreak; uniform int uFlare; uniform int uHalation; uniform int uDirt;
uniform float uBloomStrength; uniform float uStreakStrength; uniform float uFlareStrength; uniform float uHalationStrength; uniform float uDirtStrength;
uniform vec3 uStreakTint;
uniform int uAE; uniform float uExposure; uniform int uTonemap; uniform float uLUTStrength;
uniform float uSat; uniform float uContrast; uniform float uLift; uniform float uGamma; uniform float uGain; uniform int uBloomOnly;
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 reinhard(vec3 x){ float l = dot(x, vec3(0.2126, 0.7152, 0.0722)); return x / (1.0 + l); }
vec3 hable(vec3 x){ const float A=0.15,B=0.50,C=0.10,D=0.20,E=0.02,F=0.30; return ((x*(A*x+C*B)+D*E)/(x*(A*x+B)+D*F))-E/F; }
vec3 filmic(vec3 x){ return clamp(hable(x * 2.0) / hable(vec3(11.2)), 0.0, 1.0); }
vec3 agxContrast(vec3 x){ vec3 x2 = x * x; vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }
vec3 agx(vec3 c){
  const mat3 inM = mat3(0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588, 0.761241990602591, 0.0767994186031903, 0.0482516061458583, 0.101439036467562, 0.811302368396859);
  const mat3 outM = mat3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323, 1.157823702216272, -0.11060664309660294, -0.016493938717834573, -0.016493938717834257, 1.2519364065950405);
  c = inM * max(c, 0.0); c = clamp(log2(max(c, 1e-10)), -12.47393, 4.026069); c = (c + 12.47393) / 16.5;
  c = agxContrast(c); c = outM * c; c = pow(max(c, 0.0), vec3(2.2)); return clamp(c, 0.0, 1.0);
}
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main(){
  vec3 c = uBloomOnly == 1 ? vec3(0.0) : texture(tColor, vUv).rgb;
  vec3 b = texture(tBloom, vUv).rgb;
  vec3 glow = vec3(0.0);
  if (uBloom == 1) glow += b * uBloomStrength;
  if (uStreak == 1) glow += texture(tStreak, vUv).rgb * uStreakStrength * uStreakTint;
  if (uFlare == 1) glow += texture(tFlare, vUv).rgb * uFlareStrength;
  vec3 low = texture(tBloomLow, vUv).rgb;
  if (uHalation == 1) glow += low * vec3(1.0, 0.22, 0.06) * uHalationStrength;
  if (uDirt == 1) glow += low * texture(tDirt, vUv).rgb * uDirtStrength * 1.5;
  c += glow;
  float ev = uExposure;
  float expo = exp2(ev);
  if (uAE == 1) { float avg = exp(texture(tAdapt, vec2(0.5)).r); expo *= clamp(0.07 / max(avg, 1e-4), 0.35, 2.0); }
  else expo *= 1.0;
  c *= expo;
  if (uTonemap == 0) c = aces(c * 0.8); else if (uTonemap == 1) c = agx(c); else if (uTonemap == 2) c = filmic(c); else c = reinhard(c);
  vec3 s = toSRGB(clamp(c, 0.0, 1.0));
  vec3 g = texture(tLUT, s * (31.0 / 32.0) + 0.5 / 32.0).rgb;
  s = mix(s, g, uLUTStrength);
  float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
  s = mix(vec3(l), s, uSat);
  s = (s - 0.5) * uContrast + 0.5;
  s = pow(max(s * uGain + uLift * (1.0 - s), 0.0), vec3(1.0 / uGamma));
  fragColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------- FXAA (3.11-ish, LDR sRGB input)
export const FXAA_FS = HEAD + /* glsl */`
uniform sampler2D tColor; uniform vec2 uTexel;
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec3 rgbNW = texture(tColor, vUv + vec2(-1, -1) * uTexel).rgb, rgbNE = texture(tColor, vUv + vec2(1, -1) * uTexel).rgb;
  vec3 rgbSW = texture(tColor, vUv + vec2(-1, 1) * uTexel).rgb, rgbSE = texture(tColor, vUv + vec2(1, 1) * uTexel).rgb;
  vec3 rgbM = texture(tColor, vUv).rgb;
  float lNW = lum(rgbNW), lNE = lum(rgbNE), lSW = lum(rgbSW), lSE = lum(rgbSE), lM = lum(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
  vec3 a = 0.5 * (texture(tColor, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(tColor, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(tColor, vUv + dir * -0.5).rgb + texture(tColor, vUv + dir * 0.5).rgb);
  float lB = lum(b);
  fragColor = vec4((lB < lMin || lB > lMax) ? a : b, 1.0);
}`;

// ---------------------------------------------------------------- CAS
export const CAS_FS = HEAD + /* glsl */`
uniform sampler2D tColor; uniform vec2 uTexel; uniform float uSharp;
void main(){
  vec3 a = texture(tColor, vUv + vec2(0, -1) * uTexel).rgb, b = texture(tColor, vUv + vec2(-1, 0) * uTexel).rgb;
  vec3 c = texture(tColor, vUv).rgb;
  vec3 d = texture(tColor, vUv + vec2(1, 0) * uTexel).rgb, e = texture(tColor, vUv + vec2(0, 1) * uTexel).rgb;
  vec3 mn = min(min(min(a, b), min(c, d)), e), mx = max(max(max(a, b), max(c, d)), e);
  vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
  vec3 w = -amp / mix(8.0, 5.0, uSharp);
  fragColor = vec4(clamp((c + (a + b + d + e) * w) / (1.0 + 4.0 * w), 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------- lens (distortion, CA, droplets, vignette, grain)
export const LENS_FS = HEAD + HASH + /* glsl */`
uniform sampler2D tColor; uniform sampler2D tDrops; uniform float uTime; uniform float uAspect;
uniform int uDist; uniform float uDistAmt; uniform int uCA; uniform float uCAStr; uniform int uDrops;
uniform int uVig; uniform float uVigStr; uniform int uGrain; uniform float uGrainStr;
void main(){
  vec2 uv = vUv;
  vec2 cc = uv - 0.5;
  if (uDist == 1) { float r2 = dot(cc * vec2(uAspect, 1.0), cc * vec2(uAspect, 1.0)); uv = 0.5 + cc * (1.0 - uDistAmt * r2) / (1.0 - uDistAmt * 0.25); }
  vec4 drop = vec4(0.0);
  if (uDrops == 1) {
    // slight radial blur from the centre: average taps toward the middle so drops smear outward
    vec2 rdir = (uv - 0.5) * 0.035;
    for (int k = 0; k < 5; k++) drop += texture(tDrops, uv - rdir * (float(k) / 4.0));
    drop /= 5.0;
    // only prominent toward the edges; the centre of the frame stays clean
    drop.b *= smoothstep(0.12, 0.5, length(cc * vec2(uAspect, 1.0)) / max(uAspect, 1.0) * 1.6);
    uv += (drop.xy * 2.0 - 1.0) * drop.b * 0.03;
  }
  vec3 col;
  if (uCA == 1) {
    vec2 o = (uv - 0.5) * uCAStr * 0.012;
    col = vec3(texture(tColor, uv + o).r, texture(tColor, uv).g, texture(tColor, uv - o).b);
  } else col = texture(tColor, uv).rgb;
  if (uDrops == 1) col = mix(col, col * 1.15 + 0.02, drop.b * 0.6);
  if (uVig == 1) { float v = smoothstep(0.85, 0.2, length(cc * vec2(uAspect * 0.8, 1.0))); col *= mix(1.0 - uVigStr, 1.0, v); }
  if (uGrain == 1) { float l = dot(col, vec3(0.3, 0.59, 0.11)); float g = hash12(gl_FragCoord.xy + fract(uTime * 13.7) * 431.0) - 0.5;
    col += g * uGrainStr * (1.0 - l * 0.7); }
  fragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- style (CRT, glitch, pixelate, dither) + final output
export const STYLE_FS = HEAD + HASH + /* glsl */`
uniform sampler2D tColor; uniform vec2 uOutRes; uniform float uTime;
uniform int uCRT; uniform float uScan; uniform float uCurve; uniform int uDither;
uniform float uGlitch; uniform int uPixel; uniform float uPixelSize;
void main(){
  vec2 uv = vUv;
  if (uCRT == 1) { vec2 c = uv * 2.0 - 1.0; c *= 1.0 + dot(c.yx, c.yx) * uCurve * 0.12; uv = c * 0.5 + 0.5; }
  if (uPixel == 1) { vec2 px = uOutRes / uPixelSize; uv = (floor(uv * px) + 0.5) / px; }
  vec3 col;
  if (uGlitch > 0.0) {
    float t = floor(uTime * 24.0);
    float band = floor(uv.y * (8.0 + hash11(t) * 30.0));
    float on = step(1.0 - 0.35 * uGlitch, hash12(vec2(band, t)));
    uv.x += on * (hash12(vec2(band, t + 1.0)) - 0.5) * 0.12 * uGlitch;
    vec2 blk = floor(uv * vec2(16.0, 9.0));
    float bOn = step(1.0 - 0.08 * uGlitch, hash12(blk + t));
    uv += bOn * (hash22(blk + t) - 0.5) * 0.05;
    float sp = 0.012 * uGlitch * (0.3 + on);
    col = vec3(texture(tColor, uv + vec2(sp, 0.0)).r, texture(tColor, uv).g, texture(tColor, uv - vec2(sp, 0.0)).b);
    col = mix(col, vec3(hash12(gl_FragCoord.xy * 0.1 + t)), bOn * 0.25);
  } else col = texture(tColor, uv).rgb;
  if (uCRT == 1) {
    float s = 0.5 + 0.5 * sin(gl_FragCoord.y * 3.14159 * 0.5);
    col *= 1.0 - uScan * (1.0 - s);
    float m = mod(gl_FragCoord.x, 3.0);
    col *= mix(vec3(1.0), vec3(m < 1.0 ? 1.2 : 0.9, (m >= 1.0 && m < 2.0) ? 1.2 : 0.9, m >= 2.0 ? 1.2 : 0.9), uScan * 0.5);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) col = vec3(0.0);
  }
  if (uDither == 1) {
    ivec2 p = ivec2(gl_FragCoord.xy) & 3;
    const float bayer[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
    col += (bayer[p.y * 4 + p.x] / 16.0 - 0.5) / 255.0 * 1.5;
  }
  fragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------- debug buffer view
export const DEBUG_FS = HEAD + DEPTH + NORMAL + /* glsl */`
uniform sampler2D tView; uniform int uMode; uniform mat4 uCamWorld; uniform mat4 uPrevVP;
void main(){
  vec3 c;
  if (uMode == 1) { float z = -viewPos(vUv).z; c = vec3(1.0 - clamp(log(z) / log(uNearFar.y), 0.0, 1.0)); }
  else if (uMode == 2) { c = texture(tNormal, vUv).xyz; }
  else if (uMode == 3) { vec3 wp = (uCamWorld * vec4(viewPosFrom(vUv, min(rawDepth(vUv), 0.9999)), 1.0)).xyz; vec4 pc = uPrevVP * vec4(wp, 1.0);
    vec2 v = (vUv - (pc.xy / pc.w * 0.5 + 0.5)) * 40.0; c = vec3(0.5 + v, 0.5); }
  else if (uMode == 5) c = texture(tView, vUv).rrr;
  else if (uMode == 7) { vec4 f = texture(tView, vUv); c = f.rgb * 4.0 + vec3(0.0, 0.0, 1.0 - f.a) * 0.3; }
  else { vec4 s = texture(tView, vUv); c = s.rgb / (1.0 + s.rgb); if (uMode == 6) c *= s.a; }
  fragColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

// ---------------------------------------------------------------- lens droplets (rendered into a small normal/mask target)
export const DROP_VS = /* glsl */`
attribute vec4 aDrop; // x, y (uv), radius (uv y units), stretch
uniform float uAspect;
varying vec2 vQ; varying float vStretch;
void main(){
  vQ = position.xy * 2.0; vStretch = aDrop.w;
  vec2 p = aDrop.xy + position.xy * vec2(aDrop.z / uAspect, aDrop.z * (1.0 + aDrop.w)) * 2.0 + vec2(0.0, aDrop.z * aDrop.w);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
export const DROP_FS = /* glsl */`
layout(location = 0) out highp vec4 fragColor;
varying vec2 vQ; varying float vStretch;
void main(){
  vec2 q = vQ;
  float r = length(q); if (r > 1.0) discard;
  float h = sqrt(1.0 - r * r);
  vec3 n = normalize(vec3(q, h + 0.3));
  float trail = vStretch > 0.01 ? smoothstep(-1.0, 1.0, q.y) : 1.0;
  fragColor = vec4(-n.xy * 0.5 + 0.5, smoothstep(1.0, 0.7, r) * trail, 1.0);
}`;

export const COPY_FS = HEAD + /* glsl */`
uniform sampler2D tColor;
void main(){ fragColor = texture(tColor, vUv); }`;
