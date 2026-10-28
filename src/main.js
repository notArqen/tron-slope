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
import { Tracks } from './ui/tracks.js';
import { Autopilot } from './game/autopilot.js';
import { City } from './world/city.js';
import { Sky } from './world/sky.js';
import { Dystopia, LightPool, createVolumeUniforms } from './world/dystopia.js';
import { Particles } from './world/particles.js';
import { Floaters } from './world/floaters.js';
import { LightCycle } from './world/cycle.js';
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
const cycle = new LightCycle(L.ball, shared);
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
for (const mtl of [...courseView.materials, ...cycle.materials]) if (!worldMaterials.includes(mtl)) worldMaterials.push(mtl);

// ---------------------------------------------------------------- camera rigs
const CAMS = {
  chase: { back: 7.2, up: 2.6, look: 18, lookUp: -0.6, rate: 6 },
  close: { back: 4.2, up: 1.5, look: 14, lookUp: -0.2, rate: 9 },
  far: { back: 13, up: 5.5, look: 26, lookUp: -1.2, rate: 4 },
  cinema: { back: 6, up: 2.2, look: 16, lookUp: -0.4, rate: 2.5, swing: 5 },
  drone: { back: 8, up: 12, look: 8, lookUp: -2, rate: 3 },
  first: { back: 0.05, up: 0.35, look: 30, lookUp: 0.1, rate: 25, inside: true },
  cockpit: { back: 0.9, up: 1.15, look: 30, lookUp: 0.2, rate: 25, inside: true },
};
let camMsgT = 0;
const CAM_ORDER = ['chase', 'close', 'far', 'cinema', 'drone', 'first', 'cockpit'];
addEventListener('keydown', (e) => {
  if (phase !== 'run' || e.defaultPrevented || e.target.closest?.('#overlay, input')) return;
  let i = -1;
  if (e.code === 'KeyC') i = (CAM_ORDER.indexOf(S.camera) + 1) % CAM_ORDER.length;
  else if (/^Digit[1-7]$/.test(e.code)) i = Number(e.code.slice(5)) - 1;
  if (i >= 0) {
    settings.set('camera', CAM_ORDER[i]);
    const label = ['chase', 'close chase', 'far chase', 'cinematic', 'drone', 'first person', 'cockpit'][i];
    hud.msgEl.textContent = `camera · ${label}`; hud.msgEl.className = 'msg newbest';
    clearTimeout(camMsgT); camMsgT = setTimeout(() => { if (hud.msgEl.textContent.startsWith('camera')) hud.msgEl.textContent = ''; }, 900);
  }
});

// ---------------------------------------------------------------- HUD + scores
const hud = new Hud();
const tracks = new Tracks();
const score = () => Math.floor(ball.dist / 4);

// ---------------------------------------------------------------- overlay
const overlay = new Overlay(settings, perf, { probe: (key) => startProbe(key) });

// ---------------------------------------------------------------- sizing / dynamic resolution
let dynScale = 1, dynCooldown = 0, camRoll = 0;
let idleFrameDone = false;
const camSurf = {};
let airDip = 0, hideRider = false, topSpeed = 0, lookX = 0, lookY = 0, heldBank = 0, surgeT = 0, landDip = 0, boostPunch = 0, lastHundred = 0; // feel: landing dip, boost jolt, score milestones // paused: draw once, then stop until something changes
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
addEventListener('resize', () => { idleFrameDone = false; resize(); });

function overlayInfo(reactDist = 0) {
  return { dynScale, size: pipeline.size, weather: weather.target, reactDist, timingMode: perf.timingMode, course: course.stats, seed: seedToString(seed) };
}

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
  idleFrameDone = false;
  if (['renderScale', 'maxDpr', 'halfResEffects', 'particleCount', 'dynRes'].includes(k)) { if (k === 'dynRes' && !v) dynScale = 1; resize(); }
  if (k === 'wireframe') for (const m of worldMaterials) m.wireframe = v;
  if (k === 'neonPalette') applyPalette();
  if (k === 'vehicle') { menu?.setVehicle(v); cycle.reset(); }
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
let wreck = null; // tumbling crash body (cosmetic; the run already ended)
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
  course.noCurves = !S.curves; // Game → Curvy sections
  if (!attract) history.replaceState(null, '', '#seed=' + seedToString(seed) + (course.minD ? '&d=' + course.minD : ''));
  course.reset(seed);
  ball.reset();
  ball.mesh.visible = true;
  city.reset(0); dys.reset(0); floaters.reset(0); cycle.reset();
  pipeline.historyValid = false;
  camPos.set(0, ball.y + 2.6, 7.2); lookY = ball.y - 0.6; lookX = ball.x; heldBank = 0;
  deathT = -1; wreck = null; acc = 0; lastHundred = 0; topSpeed = 0;
  phase = attract ? 'menu' : 'run';
  if (!attract) { tracks.played(seed); menu.hideTitle(); menu.hidePause(); hud.startRun(seedToString(seed)); hud.setAutoplay(autoplay); autopilot.reset(); }
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
  menu.renderTracks(tracks, seedToString, (s) => hud.S.manual.bySeed[seedToString(s)] || 0);
  menu.showTitle(hud.S.manual.best, hud.S.auto.best);
}

let quickPaused = false;
function pause(quick = false) {
  if (phase !== 'run') return;
  phase = 'paused'; ball.keys.clear(); idleFrameDone = false; quickPaused = quick;
  // Space: quick pause, just the word on screen; Esc/P: the full pause menu
  if (quick) hud.msgEl.textContent = 'paused', hud.msgEl.className = 'msg newbest';
  else menu.showPause(seedToString(seed), autoplay, tracks.isSaved(seed));
}
function resume() { if (phase === 'paused') { phase = 'run'; menu.hidePause(); if (quickPaused) { hud.msgEl.textContent = ''; quickPaused = false; } } }

function die(cause) {
  if (deathT >= 0) return;
  deathT = 0; glitch = 1; shakeImpact = 1; phase = 'dying';
  const v = ball.vel;
  if (cause === 'hit' || cause === 'wall') {
    // the obstacle breaks; we keep most of our momentum and tumble on
    if (ball.hitObj) {
      ball.hitObj.smashed = true;
      particles.shardColor.copy(shared.uNeon2.value);
      particles.emit('shard', ball.mesh.position, new THREE.Vector3(v.x, 4, v.z * 0.7), 70);
    }
    const r = () => Math.random() * 2 - 1;
    wreck = { vx: v.x + r() * 3, vy: Math.max(v.y, 0) + 5 + Math.random() * 3, vz: v.z * 0.55,
      rx: 0, ry: 0, rz: 0, wx: 8 + r() * 4, wy: r() * 6, wz: r() * 9, still: 0 };
  } else {
    ball.mesh.visible = false;
    particles.shardColor.copy(shared.uNeon.value);
    particles.emit('shard', ball.mesh.position, new THREE.Vector3(ball.vx || 0, 0, -ball.speed), 60);
  }
  hud.crash(score(), seedToString(seed), cause, { dist: ball.dist, top: topSpeed, time: ball.runTime });
}

// first person / cockpit: bolted to the vehicle, so the view pitches, yaws, leans and drifts with it
const neck = { lead: 0, yaw: 0, vyaw: 0, pitch: 0, vpitch: 0, roll: 0, vroll: 0, sx: 0, vsx: 0, sy: 0, vsy: 0, pvx: 0, pvy: 0 };
const head = { yaw: 0, pitch: 0, roll: 0 }, _mq = new THREE.Vector3();
function mountCamera(rig, shake, simDt) {
  let yaw, pitch, roll, base, off;
  if (S.vehicle === 'cycle') {
    yaw = cycle.yaw + cycle.slide; pitch = cycle.pitch; roll = cycle.lean;
    const h = wreckHull(); let top = -1e9, front = 1e9, back = -1e9;
    for (const c of h) { top = Math.max(top, c.y); front = Math.min(front, c.z); back = Math.max(back, c.z); }
    base = _v3.set(ball.x, ball.y - 0.55, ball.z); // where cycle.update parks the bike
    off = S.camera === 'cockpit' ? _mq.set(0, top + 0.12, front + (back - front) * 0.55) : _mq.set(0, top * 0.62, front - 0.05);
  } else {
    // the ball spins, so the head follows its heading + deck bank instead
    const v = ball.vel, sp = Math.hypot(v.x, v.z), k = 1 - Math.exp(-simDt * 10);
    if (sp > 0.5) { head.yaw += (Math.atan2(-v.x, -v.z) - head.yaw) * k; head.pitch += (Math.atan2(v.y, sp) - head.pitch) * k; }
    head.roll += ((ball.grounded ? -ball.bank : 0) - (ball.vu || 0) * 0.03 - head.roll) * k;
    yaw = head.yaw; pitch = head.pitch; roll = head.roll;
    base = _v3.set(ball.x, ball.y, ball.z);
    off = S.camera === 'cockpit' ? _mq.set(0, 0.75, 0.6) : _mq.set(0, 0.3, -0.45);
  }
  // a rider's head, not a GoPro: it lags the bike on a soft neck spring, only slightly steadies the tilt,
  // and sways against the bike's sideways/vertical acceleration before settling back
  const dt = Math.min(simDt, 1 / 30), n = neck;
  if (dt > 0) {
    const spring = (key, target, k, c) => { n['v' + key] += ((target - n[key]) * k - n['v' + key] * c) * dt; n[key] += n['v' + key] * dt; };
    let dy = yaw - n.yaw; dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2; // shortest way round
    // riders look where they're going: eyes lead into a turn instead of trailing it
    let yawRate = yaw - (n.lastYaw ?? yaw); yawRate = (yawRate - Math.round(yawRate / (Math.PI * 2)) * Math.PI * 2) / dt; n.lastYaw = yaw;
    n.lead += (Math.max(-0.14, Math.min(0.14, yawRate * 0.12)) - n.lead) * (1 - Math.exp(-dt * 4));
    spring('yaw', n.yaw + dy + n.lead, 300, 34);   // stiff + critically damped: a beat of lag, no wobble
    spring('pitch', pitch * 0.85 - landDip * 0.06, 260, 32); // small nod when the suspension takes a landing
    spring('roll', roll * 0.7, 240, 31);   // follows the tilt, a bit steadier than the bike itself
    const ax = (ball.vel.x - n.pvx) / dt, ay = (ball.vel.y - n.pvy) / dt; n.pvx = ball.vel.x; n.pvy = ball.vel.y;
    spring('sx', Math.max(-0.12, Math.min(0.12, -ax * 0.002)), 120, 22);
    spring('sy', Math.max(-0.1, Math.min(0.1, -ay * 0.0015)) - landDip * 0.12, 120, 22);
  }
  // the head balances over the wheels' contact patch: the bike leans fully underneath, but the head only drifts
  // a third as far sideways, so in view the canopy swings through the turn instead of the whole world rolling
  _eul.set(pitch, yaw, roll * 0.35, 'YXZ');
  camera.position.copy(off.applyEuler(_eul).add(base));
  camera.position.x += n.sx; camera.position.y += n.sy;
  // faint road buzz through the frame, rising with speed (not a wobble — a hum)
  const buzz = ball.grounded ? Math.min(1, ball.vt / 40) * 0.0025 : 0;
  _eul.set(n.pitch + (S.camera === 'cockpit' ? -0.09 : -0.03) + Math.sin(simTime * 53) * buzz, n.yaw + Math.sin(simTime * 47.3) * buzz * 0.6, n.roll + Math.sin(simTime * 61.7) * buzz, 'YXZ');
  camera.quaternion.setFromEuler(_eul);
  camera.position.x += (Math.sin(simTime * 37.1) + Math.sin(simTime * 23.3)) * shake;
  camera.position.y += (Math.sin(simTime * 41.7) + Math.sin(simTime * 19.9)) * shake;
}

// crash from an inside cam: hard cut to a fixed camera bolted to a building beside the track, which pans
// to keep the wreck in shot; ~1.1 s in it cuts once more to a lower angle from the other side
const _crashLook = new THREE.Vector3();
function crashCam(shake, dt) {
  const w = wreck, t = deathT;
  const shot = t < 1.1 ? 0 : 1;
  if (w.shot !== shot) {
    const g = course.centreAt(ball.z - 14, {}), side = shot === 0 ? (Math.random() < 0.5 ? -1 : 1) : -(w.side || 1);
    w.side = side; w.shot = shot;
    w.cam = shot === 0
      ? new THREE.Vector3(g.cx + side * (12 + Math.random() * 6), ball.y + 6 + Math.random() * 4, ball.z - 12 - Math.random() * 10)
      : new THREE.Vector3(ball.x + side * 7, ball.y + 1.5, ball.z - 9);
    _crashLook.set(ball.x, ball.y, ball.z);
  }
  _crashLook.lerp(_v3.set(ball.x, ball.y, ball.z), 1 - Math.exp(-dt * 8)); // a camera operator panning, slightly behind
  camera.position.copy(w.cam);
  camera.position.x += Math.sin(simTime * 37.1) * shake * 0.3;
  camera.position.y += Math.sin(simTime * 41.7) * shake * 0.3;
  camera.up.set(0, 1, 0);
  camera.lookAt(_crashLook);
}

// crash tumble: ballistic body that bounces along whatever deck is under it
const _surf = {}, _eul = new THREE.Euler(), _v3 = new THREE.Vector3(), WRECK_DY = -0.3;
let _hull = null;
// corners of the bike's bounding box in its own frame (measured once, unrotated)
function wreckHull() {
  if (_hull) return _hull;
  const g = cycle.group, r = g.rotation.clone(), pr = cycle.pivot.rotation.clone(), p = g.position.clone();
  g.rotation.set(0, 0, 0); cycle.pivot.rotation.set(0, 0, 0); g.position.set(0, 0, 0); g.updateMatrixWorld(true);
  const bx = new THREE.Box3().setFromObject(g);
  g.rotation.copy(r); cycle.pivot.rotation.copy(pr); g.position.copy(p); g.updateMatrixWorld(true);
  _hull = [];
  for (const x of [bx.min.x, bx.max.x]) for (const y of [bx.min.y, bx.max.y]) for (const z of [bx.min.z, bx.max.z]) _hull.push(new THREE.Vector3(x, y, z));
  return _hull;
}
function stepWreck(dt, isCycle) {
  const w = wreck;
  if (dt > 0 && !w.fell) {
    w.vy -= 30 * dt;
    ball.x += w.vx * dt; ball.y += w.vy * dt; ball.z += w.vz * dt;
    w.rx += w.wx * dt; w.ry += w.wy * dt; w.rz += w.wz * dt;
    // the bike collides with its whole tumbling hull, not just its centre: lowest rotated corner sits on the deck
    let low = 0.4;
    if (isCycle) {
      _eul.set(w.rx, cycle.yaw + w.ry, w.rz, 'YXZ');
      low = 0;
      for (const c of wreckHull()) low = Math.max(low, -(_v3.copy(c).applyEuler(_eul).y + WRECK_DY));
    }
    const pl = course.surfaceAt(ball.x, ball.z, course.clockAt(ball.z), ball.y + 0.5 + low, _surf);
    const floor = pl ? _surf.y + low : -1e9;
    if (ball.y < floor) {
      ball.y = floor;
      if (w.vy < 0) { w.vy = -w.vy * 0.35; if (isCycle) { w.wx *= 0.6; w.wz *= 0.6; } } // the hull scrapes, so tumbling bleeds faster
      if (isCycle) {
        // gravity wins: a bike can't balance on a wheel, so on the deck it falls onto its side and slides
        const k = 1 - Math.exp(-dt * 7), tx = Math.round(w.rx / Math.PI) * Math.PI, tz = (Math.floor(w.rz / Math.PI) + 0.5) * Math.PI;
        w.rx += (tx - w.rx) * k; w.rz += (tz - w.rz) * k;
        const a = Math.exp(-dt * 8); w.wx *= a; w.wz *= a; w.wy *= Math.exp(-dt * 2);
        const f = Math.exp(-dt * 1.1); w.vx *= f; w.vz *= f;  // metal on grid: a long slide
        const sp = Math.hypot(w.vx, w.vz);
        if (sp > 4) { particles.shardColor.setRGB(1, 0.55, 0.15); particles.emit('shard', _v3.set(ball.x, _surf.y + 0.1, ball.z), new THREE.Vector3(-w.vx * 0.3, 2, -w.vz * 0.3), 2); }
      } else {
        const f = Math.exp(-dt * 2.5);
        w.vx *= f; w.vz *= f; w.wx *= f; w.wy *= f; w.wz *= f;
      }
      if (Math.abs(w.vy) > 3) shakeImpact = Math.max(shakeImpact, 0.25);
    }
    if (Math.hypot(w.vx, w.vy, w.vz) < 1.5) w.still += dt;
    if (!pl && ball.y < course.centreAt(ball.z, {}).cy - 25) w.fell = true;
  }
  if (isCycle) {
    const g = cycle.group;
    g.visible = true;
    g.position.set(ball.x, ball.y + WRECK_DY, ball.z);
    g.rotation.set(w.rx, cycle.yaw + w.ry, w.rz, 'YXZ');
  } else {
    ball.mesh.position.set(ball.x, ball.y, ball.z);
    ball.mesh.rotation.set(w.rx, w.ry, w.rz);
  }
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
  vehicle: (v) => settings.set('vehicle', v),
  saveTrack: () => menu.setSaveLabel(tracks.toggleSave(seed)),
  settings: () => overlay.toggle(true),
  resume, restart: () => startRun(seed), newSeed: () => startRun(randomSeed()), quit: toMenu,
});

menu.setVehicle(S.vehicle);
const overlayOpen = () => !document.getElementById('overlay').hidden;
addEventListener('keydown', (e) => {
  if (e.defaultPrevented || overlayOpen() || e.target.closest?.('#overlay, #summary input, #menu input')) return;
  if (phase === 'run' && e.code === 'Space') { e.preventDefault(); pause(true); return; }
  if (phase === 'paused' && quickPaused && (e.code === 'Space' || e.code === 'Escape')) { e.preventDefault(); resume(); return; }
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
// summary: save / unsave the track you just died on
const sSave = document.querySelector('#summary .s-save');
sSave.onclick = () => { const on = tracks.toggleSave(seed); sSave.textContent = on ? '★ saved' : 'save track'; sSave.classList.toggle('on', on); };
const _showSummary = hud.showSummary.bind(hud);
hud.showSummary = () => { _showSummary(); const on = tracks.isSaved(seed); sSave.textContent = on ? '★ saved' : 'save track'; sSave.classList.toggle('on', on); };
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

  // paused: the world is frozen, so after one frame there is nothing new to draw —
  // skip the whole pipeline (this is what kept the GPU near 90% while paused)
  if (phase === 'paused' && idleFrameDone) { last = now; perf._last = now; overlay.tick(now, overlayInfo()); return; }
  if (phase === 'paused') idleFrameDone = true;
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
  if (phase === 'run') topSpeed = Math.max(topSpeed, ball.vt);
  // feel: hard landings dip the camera, shake it, and spark; boosts punch the FOV
  // drift sparks off the rear + a touch more camera roll
  if (phase === 'run' && ball.drifting && ball.grounded && simDt > 0) {
    particles.shardColor.setRGB(1, 0.55, 0.15);
    particles.emit('shard', new THREE.Vector3(ball.x - Math.sign(ball.vu || 1) * 0.3, ball.y - 0.45, ball.z + 0.6), new THREE.Vector3(-(ball.vu || 0) * 0.4, 0, -ball.vt * 0.6), 2);
  }
  if (ball.landed) {
    landDip = Math.max(landDip, ball.landed * 0.6); shakeImpact = Math.max(shakeImpact, ball.landed * 0.35);
    particles.shardColor.copy(shared.uNeon.value);
    particles.emit('shard', new THREE.Vector3(ball.x, ball.y - 0.5, ball.z), new THREE.Vector3(0, 0, -ball.vt * 0.5), Math.round(6 + ball.landed * 18));
    ball.landed = 0;
  }
  landDip *= Math.exp(-dt * 6);
  if (ball.boosted > 0.55 && boostPunch < 0.1) { boostPunch = 1; shakeImpact = Math.max(shakeImpact, 0.4); }
  boostPunch *= Math.exp(-dt * 3);
  // every 100 points: a power surge races down the grid and the score flashes
  if (phase === 'run') { const h = Math.floor(score() / 100); if (h > lastHundred) { lastHundred = h; surgeT = 1; hud.pulse(); } }
  surgeT = Math.max(0, surgeT - dt);
  {
    const alive = phase !== 'dying' && phase !== 'summary', isCycle = S.vehicle === 'cycle';
    const fp = hideRider && S.camera === 'first';
    ball.mesh.visible = (alive || !!wreck) && !isCycle && !hideRider;
    cycle.update(ball, simDt, isCycle, alive && !fp);
    if (wreck) stepWreck(simDt, isCycle);
  }
  course.fill(ball.z, 1);
  courseView.update(course.clockAt(ball.z), ball.z);
  if (deathT >= 0) {
    deathT += dt;
    if (phase === 'dying' && (wreck ? deathT > 2 || wreck.still > 0.4 || wreck.fell : deathT > 1.2)) { phase = 'summary'; hud.showSummary(); }
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
  u.uSurge.value = (S.surges ? 1 : 0) + surgeT * 4;
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
  // camera follows the ball only, never the track geometry: centreline lookups jump
  // between lane platforms (splits/forks/hole grids) and that was the snapping
  // camera rigs (C cycles, 1–7 pick): back/up offsets, look-ahead, smoothing; never track geometry
  const rig = (wreck && CAMS[S.camera]?.inside) ? CAMS.chase : (CAMS[S.camera] || CAMS.chase); // no riding inside a tumbling wreck
  // falling from a jump: chase rigs dip and pull back so the landing zone stays visible
  // only big drops: dip under the bike once it's well above whatever deck it will land on (small hops stay put)
  let bigAir = 0;
  if (!ball.grounded && !rig.inside) {
    const below = course.surfaceAt(ball.x, ball.z, course.clockAt(ball.z), ball.y, camSurf);
    bigAir = below ? Math.max(0, Math.min(1, (ball.y - camSurf.y - 4) / 6)) : 1;
  }
  const fallDip = Math.max(0, Math.min(1.6, -ball.vy * 0.07)) * bigAir;
  airDip += (fallDip - airDip) * (1 - Math.exp(-dt * 5));
  const swing = rig.swing ? Math.sin(simTime * 0.35) * rig.swing : 0;
  const target = tmpV.set(ball.x + swing, ball.y + rig.up - landDip - airDip, ball.z + rig.back + airDip * 0.8);
  camPos.x += (target.x - camPos.x) * (1 - Math.exp(-dt * rig.rate));
  const vLead = rig.inside ? 0 : Math.max(-3, Math.min(1.5, (ball.grounded ? 0 : ball.vy) * 0.08));
  camPos.y += (target.y + vLead - camPos.y) * (1 - Math.exp(-dt * (rig.inside ? 30 : 12)));
  lookY += (ball.y + rig.lookUp + vLead - lookY) * (1 - Math.exp(-dt * (rig.inside ? 30 : 14)));
  camPos.z = target.z;
  camera.position.copy(camPos);
  let shake = 0;
  if (S.shake) shake = S.shakeAmt * (sp * 0.02 + weather.lightningFlash * 0.03 * (S.lightning ? 1 : 0) + shakeImpact * 0.25) * (rig.inside ? 0.5 : 1);
  camera.position.x += (Math.sin(simTime * 37.1) + Math.sin(simTime * 23.3)) * shake;
  camera.position.y += (Math.sin(simTime * 41.7) + Math.sin(simTime * 19.9)) * shake;
  lookX += (ball.x - lookX) * (1 - Math.exp(-dt * (rig.inside ? 20 : 5)));
  camLook.set(lookX, lookY, ball.z - rig.look);
  camera.lookAt(camLook);
  hideRider = !!rig.inside;
  // roll with the deck bank (max 12°)
  camRoll += (0 - (ball.vu || 0) * (ball.drifting ? 0.02 : 0.012) - camRoll) * (1 - Math.exp(-dt * 6)); // lean into steering
  camera.rotateZ(Math.max(-0.21, Math.min(0.21, camRoll)));
  if (rig.inside) mountCamera(rig, shake, simDt);
  if (wreck && CAMS[S.camera]?.inside) crashCam(shake, dt);
  // debug: window.__camOverride = (cam, ball) => {...} lets tooling place the camera (e.g. bike side view)
  if (window.__camOverride) window.__camOverride(camera, ball);
  camera.fov = 62 + (S.fovKick ? S.fovKickAmt * Math.min(1.15, sp) + boostPunch * 7 : 0);
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
  hud.frame(score(), ball.vt, S.godMode);
  overlay.tick(now, overlayInfo(reactDist));
}
requestAnimationFrame(frame);

// expose for debugging / automated perf checks
window.__tron = { settings, perf, pipeline, city, ball, weather, track, layers, camera, course, hud, menu, startRun, toMenu, pause, resume, get phase() { return phase; }, get dynScale() { return dynScale; } };
