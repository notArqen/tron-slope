import * as THREE from 'three';
import './ui/overlay.css';
import { Settings } from './settings/store.js';
import { Perf } from './core/perf.js';
import { Wind } from './world/wind.js';
import { WeatherDirector } from './world/weather.js';
import { createShared, PALETTES, SLOPE_TAN, trackY } from './world/shared.js';
import { Track, TestObstacles, puddleMaskCPU } from './world/track.js';
import { Ball, BALL_R } from './world/ball.js';
import { City } from './world/city.js';
import { Sky } from './world/sky.js';
import { Dystopia, LightPool, createVolumeUniforms } from './world/dystopia.js';
import { Particles } from './world/particles.js';
import { Pipeline } from './post/pipeline.js';
import { Overlay } from './ui/overlay.js';

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
if (!renderer.capabilities.isWebGL2) throw new Error('WebGL2 required');
renderer.autoClear = false;
renderer.sortObjects = true;
const gl = renderer.getContext();
gl.getExtension('EXT_color_buffer_float');

const settings = new Settings();
const perf = new Perf(gl);
const S = settings.values;

// ---------------------------------------------------------------- world
const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 3000);
const wind = new Wind();
const weather = new WeatherDirector();
const shared = createShared(wind);
const vol = createVolumeUniforms();

const mkScene = () => new THREE.Scene();
const L = {
  sky: mkScene(), track: mkScene(), city: mkScene(), skyline: mkScene(), drones: mkScene(), billboards: mkScene(),
  cables: mkScene(), obstacles: mkScene(), ball: mkScene(),
};
const sky = new Sky(L.sky, shared);
L.skyline.add(sky.skyline); L.sky.remove(sky.skyline);
const track = new Track(L.track, shared);
const city = new City(L.city, shared);
const dys = new Dystopia(mkScene(), shared, vol);
L.drones.add(dys.drones); L.billboards.add(dys.billboards); L.cables.add(dys.cables);
const obstacles = new TestObstacles(L.obstacles, shared);
const ball = new Ball(L.ball, shared);
const pool = new LightPool(shared);
const depthU = { uDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNearFar: { value: new THREE.Vector2(0.1, 3000) } };
const particles = new Particles({ ...shared, ...vol }, depthU);
const pipeline = new Pipeline(renderer, perf, shared, vol);
const cones = { scene: dys.coneScene, visible: false };

// draw order + names used in the per-effect cost readout
const layers = [
  { name: 'sky', scene: L.sky, reflect: true, key: null },
  { name: 'skyline + strobes', scene: L.skyline, reflect: true, key: 'strobes' },
  { name: 'city (instanced)', scene: L.city, reflect: true, key: null },
  { name: 'track + street', scene: L.track, reflect: false, key: null },
  { name: 'obstacles (test)', scene: L.obstacles, reflect: true, key: 'testObstacles' },
  { name: 'ball', scene: L.ball, reflect: true, key: null },
  { name: 'drones', scene: L.drones, reflect: true, key: 'drones' },
  { name: 'holo-billboards', scene: L.billboards, reflect: true, key: 'billboards' },
  { name: 'cables', scene: L.cables, reflect: true, key: 'cables' },
];
for (const l of layers) l.visible = true;

const worldMaterials = [];
for (const l of layers) l.scene.traverse((o) => { if (o.material && !worldMaterials.includes(o.material)) worldMaterials.push(o.material); });

// ---------------------------------------------------------------- HUD
const hud = document.getElementById('hud');
const hudScore = hud.querySelector('.score');
const hudSpeed = hud.querySelector('.speed');
const hudMsg = hud.querySelector('.msg');

// ---------------------------------------------------------------- overlay
const overlay = new Overlay(settings, perf, { probe: (key) => startProbe(key) });

// ---------------------------------------------------------------- sizing / dynamic resolution
let dynScale = 1, dynCooldown = 0;
function internalSize() {
  const dpr = Math.min(devicePixelRatio || 1, S.maxDpr);
  const cw = innerWidth, ch = innerHeight;
  const ow = Math.round(cw * dpr), oh = Math.round(ch * dpr);
  const sc = S.renderScale * (S.dynRes ? dynScale : 1);
  return { cw, ch, dpr, ow, oh, w: Math.max(64, Math.round(ow * sc)), h: Math.max(36, Math.round(oh * sc)) };
}
function resize() {
  const z = internalSize();
  renderer.setPixelRatio(z.dpr);
  renderer.setSize(z.cw, z.ch, false);
  canvas.style.width = z.cw + 'px'; canvas.style.height = z.ch + 'px';
  camera.aspect = z.cw / z.ch;
  const pScale = S.particleCount < 0.75 ? 0.5 : 1;
  pipeline.setSize(z.w, z.h, z.ow, z.oh, { halfRes: S.halfResEffects, particleScale: pScale });
  depthU.uNearFar.value.set(camera.near, camera.far);
}
addEventListener('resize', resize);

function updateDynRes(dt) {
  dynCooldown -= dt;
  if (!S.dynRes || dynCooldown > 0 || !perf.avgMs) return;
  const budget = 1000 / S.targetFps;
  let next = dynScale;
  if (perf.avgMs > budget * 1.08) next = Math.max(0.5, dynScale - 0.05);
  else if (perf.avgMs < budget * 1.02 && dynScale < 1) next = Math.min(1, dynScale + 0.05);
  if (next !== dynScale) { dynScale = next; dynCooldown = 1.0; resize(); }
}

// ---------------------------------------------------------------- settings → engine
const SHADOW = { off: 0, blob: 1, soft: 2, ultra: 3 };
settings.on((k, v) => {
  if (['renderScale', 'maxDpr', 'halfResEffects', 'particleCount', 'dynRes'].includes(k)) { if (k === 'dynRes' && !v) dynScale = 1; resize(); }
  if (k === 'wireframe') for (const m of worldMaterials) m.wireframe = v;
  if (k === 'neonPalette') applyPalette();
});
function applyPalette() {
  const p = PALETTES[S.neonPalette];
  shared.uNeon.value.setRGB(...p.neon); shared.uNeon2.value.setRGB(...p.neon2); shared.uSmog.value.setRGB(...p.smog);
}
applyPalette();
for (const m of worldMaterials) m.wireframe = S.wireframe;

// ---------------------------------------------------------------- toggle-delta cost probes
let probeFrame = false;
function startProbe(key) {
  const before = S[key];
  const ok = perf.startProbe(key, (state) => { S[key] = state; }, before, 40);
  return ok;
}

// ---------------------------------------------------------------- game state
let simTime = 0, deathT = -1, glitch = 0, shakeImpact = 0;
const STEP = 1 / 120;
let acc = 0;
const tmpV = new THREE.Vector3();
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();

function resetRun() {
  ball.reset();
  obstacles.reset(0); city.reset(0); dys.reset(0);
  pipeline.historyValid = false;
  camPos.set(0, trackY(0) + 3.2, 8);
  deathT = -1;
  hudMsg.textContent = '';
}

function die() {
  if (S.godMode) return;
  if (deathT >= 0) return;
  ball.dead = true;
  deathT = 0; glitch = 1; shakeImpact = 1;
  hudMsg.textContent = 'crashed';
}

function stepSim(dt) {
  ball.step(dt);
  if (S.godMode && ball.falling) { ball.falling = false; ball.fallY = 0; ball.vy = 0; ball.x = Math.sign(ball.x) * 2.5; ball.dead = false; }
  if (ball.dead && deathT < 0) die();
  if (!ball.falling && obstacles.hit(ball.x, ball.z, BALL_R)) {
    if (S.godMode) { /* pass through */ } else die();
  }
}

// ---------------------------------------------------------------- main loop
let last = performance.now();
let fpsCapAcc = 0;
resize();
resetRun();

function frame(now) {
  requestAnimationFrame(frame);
  // fps cap: skip frames until enough time has passed
  if (S.fpsCap !== 'off') {
    const minDt = 1000 / Number(S.fpsCap);
    fpsCapAcc += now - last; last = now;
    if (fpsCapAcc < minDt - 1) return;
    fpsCapAcc = Math.min(fpsCapAcc - minDt, minDt);
  } else last = now;

  const frameStart = performance.now();
  const rawDt = perf.frame(now) / 1000;
  const dt = Math.min(rawDt, 1 / 20);
  const simDt = S.freezeTime ? 0 : dt;
  simTime += simDt;

  // fixed-timestep physics
  acc += simDt;
  while (acc >= STEP) { stepSim(STEP); acc -= STEP; }
  ball.sync();
  if (deathT >= 0) { deathT += dt; if (deathT > 1.3) resetRun(); }
  glitch = Math.max(0, glitch - dt * 0.9);
  shakeImpact = Math.max(0, shakeImpact - dt * 2.5);

  // weather + wind
  const wp = weather.update(simDt, { auto: S.weatherAuto, cycle: S.weatherCycle, intensity: S.weatherIntensity, runTime: ball.runTime, speedN: ball.speedN, manual: S.weatherState });
  if (S.weatherAuto && overlay.weatherLabel) overlay.weatherLabel(weather.target);
  wind.update(simDt, simTime, { dirDeg: S.windDir, strength: wp.wind * S.windStrength, gustiness: S.gustiness, turbulence: 0.5 + wp.wind * 0.08 });
  wind.uniforms.uTime.value = simTime;

  // shared uniforms
  const u = shared;
  u.uFogDensity.value = wp.fog * S.fogDensityMul;
  u.uMistDensity.value = wp.mist * S.fogDensityMul;
  u.uMistHeight.value = S.mistHeight;
  u.uFogColor.value.copy(wp.fogTint);
  u.uPower.value = wp.power;
  u.uFlicker.value = S.neonFlicker ? wp.flicker : 0;
  u.uSurge.value = S.surges ? 1 : 0;
  u.uWet.value = wp.wet;
  u.uRain.value = S.rain ? Math.min(1, wp.rain) : 0;
  u.uPuddle.value = S.puddles ? S.puddleCoverage : 0;
  u.uGrime.value = S.grime ? 1 : 0;
  u.uLightning.value = S.lightning ? weather.lightningFlash : 0;
  u.uLightningAz.value = weather.lightningAz;
  u.uShadowMode.value = SHADOW[S.shadowQuality];
  const reactDist = Math.max(25, ball.speed * S.reactionTime + 10);
  u.uReactDist.value = reactDist;
  u.uFogNearCap.value = S.fogNearCap;
  u.uBall.value.set(ball.x, ball.y, ball.z, BALL_R);

  // camera: chase cam with FOV kick + shake
  const sp = ball.speedN;
  const target = tmpV.set(ball.x * 0.6, ball.y + 2.6, ball.z + 7.2);
  camPos.lerp(target, 1 - Math.exp(-dt * 10));
  camPos.z = target.z; // never lag behind along the run
  camera.position.copy(camPos);
  let shake = 0;
  if (S.shake) shake = S.shakeAmt * (sp * 0.02 + weather.lightningFlash * 0.03 * (S.lightning ? 1 : 0) + shakeImpact * 0.25);
  camera.position.x += (Math.sin(simTime * 37.1) + Math.sin(simTime * 23.3)) * shake;
  camera.position.y += (Math.sin(simTime * 41.7) + Math.sin(simTime * 19.9)) * shake;
  camLook.set(ball.x * 0.85, ball.y - 0.6, ball.z - 14);
  camera.lookAt(camLook);
  camera.fov = 62 + (S.fovKick ? S.fovKickAmt * sp : 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  u.uCamPos.value.copy(camera.position);

  // world systems
  track.update(ball.z, reactDist, S.showReaction);
  city.update(ball.z, S.cityDensity);
  obstacles.update(ball.z, S.testObstacles);
  sky.update(camera, ball.z, wp.glow, wp.strobes, S.strobes);
  pool.begin();
  dys.update(simTime, simDt, ball.z, { drones: S.drones, billboards: S.billboards, cables: S.cables, power: wp.power, flicker: u.uFlicker.value, volumetric: S.volumetric }, pool);
  pool.push(ball.x, ball.y + 0.3, ball.z, 5, u.uNeon.value.r * 1.2, u.uNeon.value.g * 1.2, u.uNeon.value.b * 1.2);
  pool.end(tmpV.set(ball.x, ball.y, ball.z - 18), S.lightPool);
  cones.visible = S.drones && !S.volumetric;
  for (const l of layers) l.visible = l.key ? !!S[l.key] : true;

  // particles
  const storm = Math.max(0, Math.min(1, (wp.dust - 0.4) * 1.6));
  particles.update(camera, {
    rain: wp.rain * S.rainDensity, dust: (0.4 + wp.dust) * S.dustDensity, ash: wp.ash * S.ashDensity,
    debris: wp.debris * (0.35 + wind.uniforms.uGust.value) * S.debrisDensity, embers: wp.embers * S.emberDensity, steam: 0.7,
  }, { rain: S.rain, dust: S.dustMotes, ash: S.ash, debris: S.debris, embers: S.embers, steam: S.steam }, S.particleCount, storm);
  // ball-driven splash / dust
  if (!ball.dead && !ball.falling && simDt > 0) {
    const bp = tmpV.set(ball.x, ball.y - BALL_R * 0.8, ball.z + 0.4);
    const vel = new THREE.Vector3(ball.vx, 0, -ball.speed);
    if (S.splashes && wp.wet > 0.2 && puddleMaskCPU(ball.x, ball.z, u.uPuddle.value, wp.wet) > 0.4 && Math.random() < 0.9) particles.emit('splash', bp, vel, 4);
    if (S.ballDust && Math.random() < 0.25 + sp * 0.6) particles.emit(wp.wet > 0.45 ? 'splash' : 'dust', bp, vel, 1);
  }
  particles.cpu.enabled = S.splashes || S.ballDust;
  particles.stepCPU(simDt, wind);
  depthU.uDepth.value = pipeline.t.scene.depthTexture;

  // TAA jitter, render
  pipeline.jitter(camera, S.aa === 'taa');
  const planeNormal = new THREE.Vector3(0, 1, -SLOPE_TAN).normalize();
  const planePoint = new THREE.Vector3(0, trackY(ball.z), ball.z);
  perf.sync = S.syncTiming && !perf.ext;
  pipeline.render({
    camera, s: S, layers, particles, cones, dt, speedN: sp, glitch, ballPos: ball.mesh.position, wind,
    weather: { glow: wp.glow, lightning: S.lightning ? weather.lightningFlash : 0, lightningAz: weather.lightningAz },
    debugMode: S.debugView, dropletAmount: S.lensDroplets ? wp.droplets * (S.rain ? 1 : 0.3) : 0, planeNormal, planePoint,
  });
  // restore unjittered projection
  camera.projectionMatrix.copy(pipeline.unjitteredProj);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

  // perf bookkeeping
  perf.poll();
  if (perf.probe) {
    // synced work time for the probe: force GPU completion with a 1-px read
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    perf.probeSample(performance.now() - frameStart);
  }
  updateDynRes(dt);

  // HUD
  hudScore.textContent = Math.floor(ball.dist / 4);
  hudSpeed.textContent = (ball.speed * 3.6).toFixed(0) + ' km/h';
  overlay.tick(now, { dynScale, size: pipeline.size, weather: weather.target, reactDist, timingMode: perf.timingMode });
}
requestAnimationFrame(frame);

// expose for debugging / automated perf checks
window.__tron = { settings, perf, pipeline, ball, weather, track, layers, camera, get dynScale() { return dynScale; } };
