import * as THREE from 'three';
import './ui/overlay.css';
import { Settings } from './settings/store.js';
import { Perf } from './core/perf.js';
import { Wind } from './world/wind.js';
import { WeatherDirector } from './world/weather.js';
import { createShared, PALETTES, SLOPE_TAN, trackY } from './world/shared.js';
import { Track, puddleMaskCPU } from './world/track.js';
import { Ball, BALL_R } from './world/ball.js';
import { Course } from './game/course.js';
import { CourseView } from './game/courseView.js';
import { seedToString, parseSeed, randomSeed } from './game/rng.js';
import { Hud } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { Autopilot } from './game/autopilot.js';
import { City } from './world/city.js';
import { Sky } from './world/sky.js';
import { Dystopia, LightPool, createVolumeUniforms } from './world/dystopia.js';
import { Particles } from './world/particles.js';
import { Floaters } from './world/floaters.js';
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
  cables: mkScene(), obstacles: mkScene(), ball: mkScene(), course: mkScene(), floaters: mkScene(),
};
const sky = new Sky(L.sky, shared);
L.skyline.add(sky.skyline); L.sky.remove(sky.skyline);
const track = new Track(L.track, shared);
L.track.remove(track.mesh); // the Phase 1 placeholder deck is replaced by the streamed course
const city = new City(L.city, shared);
const dys = new Dystopia(mkScene(), shared, vol);
L.drones.add(dys.drones); L.billboards.add(dys.billboards); L.cables.add(dys.cables);
const floaters = new Floaters(L.floaters, shared);
const course = new Course();
const courseView = new CourseView(L.course, L.obstacles, shared, course);
// seed: #seed=XXXXXXXX in the URL replays a run; otherwise random
const hashSeed = (location.hash.match(/seed=([^&]+)/) || [])[1];
let seed = parseSeed(hashSeed) ?? randomSeed();
course.minD = Math.min(1, Math.max(0, Number((location.hash.match(/[#&]d=([\d.]+)/) || [])[1]) || 0)); // debug/practice floor
course.reset(seed);
const ball = new Ball(L.ball, shared, course);
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
  { name: 'street + debug gate', scene: L.track, reflect: false, key: null },
  { name: 'course (decks + tunnels)', scene: L.course, reflect: false, key: null },
  { name: 'obstacles', scene: L.obstacles, reflect: true, key: null },
  { name: 'ball', scene: L.ball, reflect: true, key: null },
  { name: 'drones', scene: L.drones, reflect: true, key: 'drones' },
  { name: 'holo-billboards', scene: L.billboards, reflect: true, key: 'billboards' },
  { name: 'cables', scene: L.cables, reflect: true, key: 'cables' },
  { name: 'floating cubes', scene: L.floaters, reflect: true, key: 'floaters' },
];
for (const l of layers) l.visible = true;

const worldMaterials = [];
for (const l of layers) l.scene.traverse((o) => { if (o.material && !worldMaterials.includes(o.material)) worldMaterials.push(o.material); });
for (const mtl of courseView.materials) if (!worldMaterials.includes(mtl)) worldMaterials.push(mtl);

// ---------------------------------------------------------------- HUD + scores
const hud = new Hud();
const score = () => Math.floor(ball.dist / 4);

// ---------------------------------------------------------------- overlay
const overlay = new Overlay(settings, perf, { probe: (key) => startProbe(key) });

// ---------------------------------------------------------------- sizing / dynamic resolution
let dynScale = 1, dynCooldown = 0, camRoll = 0;
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
// menu (attract demo) → run ⇄ paused → dying (slow-mo, shards, glitch) → summary → run | menu
let simTime = 0, deathT = -1, glitch = 0, shakeImpact = 0, phase = 'menu';
const STEP = 1 / 120;
let acc = 0;
const tmpV = new THREE.Vector3();
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
const ctr = {};
const autopilot = new Autopilot(shared, course);
let playD = course.minD; // difficulty floor chosen for real runs
let autoplay = false;     // Autoplay: the autopilot drives a real run (scores not counted)

function startRun(newSeed, { attract = false } = {}) {
  if (newSeed !== undefined && newSeed !== null) seed = newSeed >>> 0;
  course.minD = attract ? 0.35 : playD;
  if (!attract) history.replaceState(null, '', '#seed=' + seedToString(seed) + (course.minD ? '&d=' + course.minD : ''));
  course.reset(seed);
  ball.reset();
  ball.mesh.visible = true;
  city.reset(0); dys.reset(0); floaters.reset(0);
  pipeline.historyValid = false;
  camPos.set(0, ball.y + 2.6, 7.2);
  deathT = -1; acc = 0;
  phase = attract ? 'menu' : 'run';
  if (!attract) { menu.hideTitle(); menu.hidePause(); hud.startRun(seedToString(seed)); hud.setAutoplay(autoplay); autopilot.reset(); }
}

function setAutoplay(on) {
  autoplay = on;
  hud.setAutoplay(on);
  if (on) autopilot.reset(); else ball.keys.clear();
}

function toMenu() {
  autoplay = false;
  menu.hidePause();
  document.getElementById('summary').hidden = true;
  history.replaceState(null, '', location.pathname);
  startRun(randomSeed(), { attract: true });
  menu.showTitle(hud.best);
}

function pause() {
  if (phase !== 'run') return;
  phase = 'paused'; ball.keys.clear();
  menu.showPause(seedToString(seed), autoplay);
}
function resume() { if (phase === 'paused') { phase = 'run'; menu.hidePause(); } }

function die(cause) {
  if (deathT >= 0) return;
  deathT = 0; glitch = 1; shakeImpact = 1; phase = 'dying';
  ball.mesh.visible = false;
  // shatter into grid shards
  particles.shardColor.copy(shared.uNeon.value);
  particles.emit('shard', ball.mesh.position, new THREE.Vector3(ball.vx || 0, 0, -ball.speed), 60);
  hud.crash(score(), seedToString(seed), cause);
}

function stepSim(dt) {
  if (phase === 'menu' || autoplay) autopilot.drive(ball); // attract demo / Autoplay
  ball.step(dt, S.godMode || phase === 'menu');
  if (ball.dead && deathT < 0) die(ball.deathCause);
}

const menu = new Menu({
  play: (seedText, d) => { autoplay = false; playD = d; const s = seedText ? parseSeed(seedText) : null; startRun(s ?? randomSeed()); },
  autoplay: (d) => { autoplay = true; playD = d; startRun(randomSeed()); },
  toggleAutoplay: () => { setAutoplay(!autoplay); menu.setAutoLabel(autoplay); },
  settings: () => overlay.toggle(true),
  resume, restart: () => startRun(seed), newSeed: () => startRun(randomSeed()), quit: toMenu,
});

const overlayOpen = () => !document.getElementById('overlay').hidden;
addEventListener('keydown', (e) => {
  if (e.defaultPrevented || overlayOpen() || e.target.closest?.('#overlay, #summary input, #menu input')) return;
  if (phase === 'run' && (e.code === 'Escape' || e.code === 'KeyP')) { e.preventDefault(); pause(); return; }
  if (phase === 'paused' && (e.code === 'Escape' || e.code === 'KeyP')) { e.preventDefault(); resume(); return; }
  // Autoplay: steering keys take the wheel back
  if (autoplay && phase === 'run' && ['ArrowLeft', 'ArrowRight', 'KeyA', 'KeyD'].includes(e.code)) { setAutoplay(false); return; }
  if (phase !== 'summary') return;
  if (['Space', 'Enter'].includes(e.code)) { e.preventDefault(); startRun(); }
  else if (e.code === 'KeyR') startRun(randomSeed());
  else if (e.code === 'KeyM' || e.code === 'Escape') toMenu();
});
// leaving the tab mid-run pauses it
addEventListener('blur', () => pause());
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
hud.onSeedSubmit = (txt) => { const s = parseSeed(txt); if (s !== null) startRun(s); };

// ---------------------------------------------------------------- main loop
let last = performance.now();
let fpsCapAcc = 0;
resize();
// a #seed=… link replays that run directly; otherwise start at the title screen
if (hashSeed) { menu.hideTitle(); startRun(seed); } else toMenu();

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
  // slow-mo for 0.4 s after death, frozen once the summary is up
  const timeScale = phase === 'paused' ? 0 : phase === 'dying' && deathT < 0.4 ? 0.25 : 1;
  const simDt = S.freezeTime ? 0 : dt * timeScale;
  simTime += simDt;

  // fixed-timestep physics
  acc += simDt;
  if ((phase === 'run' && autoplay) || phase === 'menu') autopilot.think(ball, simDt);
  while (acc >= STEP) { if (phase === 'run' || phase === 'menu') stepSim(STEP); acc -= STEP; }
  ball.sync();
  course.fill(ball.z, 1);
  courseView.update(course.clockAt(ball.z), ball.z);
  if (deathT >= 0) {
    deathT += dt;
    if (deathT > 1.2 && phase === 'dying') { phase = 'summary'; hud.showSummary(); }
    if (autoplay && phase === 'summary' && deathT > 3.2) startRun(randomSeed()); // ambience: keep rolling
  }
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
  course.centreAt(ball.z, ctr);
  const cxAhead = course.centreAt(ball.z - 14, {}).cx;
  const target = tmpV.set(ball.x * 0.6 + ctr.cx * 0.4, ball.y + 2.6, ball.z + 7.2);
  camPos.lerp(target, 1 - Math.exp(-dt * 10));
  camPos.z = target.z; // never lag behind along the run
  camera.position.copy(camPos);
  let shake = 0;
  if (S.shake) shake = S.shakeAmt * (sp * 0.02 + weather.lightningFlash * 0.03 * (S.lightning ? 1 : 0) + shakeImpact * 0.25);
  camera.position.x += (Math.sin(simTime * 37.1) + Math.sin(simTime * 23.3)) * shake;
  camera.position.y += (Math.sin(simTime * 41.7) + Math.sin(simTime * 19.9)) * shake;
  camLook.set(ball.x * 0.6 + cxAhead * 0.4, ball.y - 0.6, ball.z - 14);
  camera.lookAt(camLook);
  // roll with the deck bank (max 12°)
  camRoll += ((ball.grounded ? -ball.bank : 0) * 0.55 - camRoll) * (1 - Math.exp(-dt * 6));
  camera.rotateZ(Math.max(-0.21, Math.min(0.21, camRoll)));
  camera.fov = 62 + (S.fovKick ? S.fovKickAmt * sp : 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  u.uCamPos.value.copy(camera.position);

  // world systems
  track.update(ball.z, reactDist, S.showReaction);
  { const g = course.centreAt(ball.z - reactDist, {}); track.boundary.position.set(g.cx, g.cy, ball.z - reactDist); }
  city.update(ball.z, S.cityDensity);
  floaters.update(ball.z, S.floaters);
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
  if ((phase === 'run' || phase === 'menu') && ball.grounded && simDt > 0) {
    const bp = tmpV.set(ball.x, ball.y - BALL_R * 0.8, ball.z + 0.4);
    const vel = new THREE.Vector3(ball.vu, 0, -ball.speed);
    if (S.splashes && wp.wet > 0.2 && puddleMaskCPU(ball.x, ball.z, u.uPuddle.value, wp.wet) > 0.4 && Math.random() < 0.9) particles.emit('splash', bp, vel, 4);
    if (S.ballDust && Math.random() < 0.25 + sp * 0.6) particles.emit(wp.wet > 0.45 ? 'splash' : 'dust', bp, vel, 1);
  }
  particles.cpu.enabled = S.splashes || S.ballDust;
  particles.stepCPU(simDt, wind);
  depthU.uDepth.value = pipeline.t.scene.depthTexture;

  // TAA jitter, render
  pipeline.jitter(camera, S.aa === 'taa');
  const planeNormal = new THREE.Vector3(0, 1, -SLOPE_TAN).normalize();
  const planePoint = new THREE.Vector3(ball.x, ball.y - BALL_R, ball.z);
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
  hud.frame(score(), ball.speed, S.godMode);
  overlay.tick(now, { dynScale, size: pipeline.size, weather: weather.target, reactDist, timingMode: perf.timingMode, course: course.stats, seed: seedToString(seed) });
}
requestAnimationFrame(frame);

// expose for debugging / automated perf checks
window.__tron = { settings, perf, pipeline, ball, weather, track, layers, camera, course, hud, menu, startRun, toMenu, pause, resume, get phase() { return phase; }, get dynScale() { return dynScale; } };
