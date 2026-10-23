import { mulberry32 } from './rng.js';
import { SLOPE_TAN, trackY } from '../world/shared.js';

// Seeded, streamed course built from SPEC.md. Everything is parameterised by
// world z (forward = −z), sampled every DZ metres. The generator integrates the
// same speed curve the ball uses, so arrival time t(z) at any obstacle is known
// in advance and moving hazards can be validated against their real phase.

export const DZ = 0.5;
export const GRID = { X0: -26, DX: 0.05, N: 1041 };
export const G = 28;               // gameplay gravity (m/s²)
export const BALL_R = 0.55;
export const STEER_ACC = 46, STEER_DAMP = 6.5;
export const V_MIN = 14, V_MAX = 62, K_ACC = 4.8;
export const CENTRIFUGAL = 0.1;   // fraction of v²κ felt on curves (the ball mostly follows the deck heading)
export const KAPPA_MAX = 1 / 25;  // tightest bend the generator builds; clamps finite-difference spikes at joins
const TAN_STEEP = Math.tan((14 * Math.PI) / 180);
const TAN_FLAT = Math.tan((7 * Math.PI) / 180);
const TAN_RECOVER = Math.tan((7.5 * Math.PI) / 180);
const DEG = Math.PI / 180;
const VLAT = (STEER_ACC / STEER_DAMP) * 0.7;   // lateral speed budget used by the validator
const MARGIN = 0.4;                             // per side → surviving corridor ≥ 0.8 m (spec minimum 0.6)
const STEER_FRAC = 0.5;                         // share of terminal lateral speed the validator assumes (covers the ~0.15 s steering lag)
const TUBE_H = 5;
export const BOOST_ADD = 22, BOOST_KEEP = 4, BOOST_TAU = 1.6; // surge (m/s), permanent gain, surge decay (s)
// half-pipe cross-section: flat floor ±PIPE_F, quarter-circle walls of radius PIPE_R
export const PIPE_F = 2.0, PIPE_R = 2.2, PIPE_LAUNCH = 0.95;
const LOOKAHEAD = 260, BEHIND = 40;

// validator lateral grid
const GX0 = -26, GDX = 0.05, GN = 1041;

// deck curving downward (slope steepening by dSlope over ds metres) faster than
// gravity can pull the ball along it → the ball leaves the surface
export function crestLaunch(v, slopeBefore, slopeAfter, ds) { return (v * v * (slopeAfter - slopeBefore)) / ds > G; }

// half-pipe wall height and slope at lateral u (e = 0..1 entry/exit envelope)
export function pipeProfile(u, e) {
  const a = Math.abs(u) - PIPE_F;
  if (a <= 0 || e <= 0) return { h: 0, dh: 0 };
  const q = Math.min(a, PIPE_R * 0.985);
  const root = Math.sqrt(PIPE_R * PIPE_R - q * q);
  return { h: (PIPE_R - root) * e, dh: (q / root) * Math.sign(u) * e };
}

export function accelAt(v, slopeTan) {
  let a = K_ACC * (1 - v / V_MAX);
  if (slopeTan > TAN_STEEP) a += 2.5; else if (slopeTan < TAN_FLAT) a -= 3;
  return a;
}
const smooth = (x) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const lerp = (a, b, k) => a + (b - a) * k;

// --------------------------------------------------------------- platforms
class Platform {
  constructor(kind, z0, opts = {}) {
    this.kind = kind;            // 'deck' | 'thin' | 'lane'
    this.z0 = z0;
    this.cx = []; this.cy = []; this.hw = []; this.bank = [];
    this.tunnel = !!opts.tunnel;
    this.pivot = opts.tunnel ? TUBE_H / 2 : 0;
    this.rot = opts.rot || null; // { amp, omega, phase }
    this.openStart = !!opts.openStart; this.openEnd = false;
    this.lip = false;
    this.pipe = !!opts.pipe;   // half-pipe: bank[] holds the wall envelope instead of a bank angle
    this.pads = [];            // boost pad start z values
    this.slide = opts.slide || null;  // { amp, omega, phase } shuttle: deck slides sideways
    this.blink = opts.blink || null;  // { omega, phase, duty } blink tile: solid only part of each cycle
    this.jets = [];            // side-wind zones { zA, zB, a } (lateral accel, m/s²)
  }
  solidAt(t) { if (!this.blink) return true; const b = this.blink; const f = ((b.omega * t + b.phase) / (2 * Math.PI)) % 1; return (f < 0 ? f + 1 : f) < b.duty; }
  slideAt(t) { return this.slide ? this.slide.amp * Math.sin(this.slide.omega * t + this.slide.phase) : 0; }
  jetAt(z) { for (const j of this.jets) if (z <= j.zA && z >= j.zB) return j.a; return 0; }
  // full deck state at (z, t): centre (incl. slide), roll, half-width, pipe envelope
  geo(z, t, out) {
    this.sample(z, out);
    out.cx += this.slideAt(t);
    out.th = this.pipe ? 0 : out.bank + this.rollAt(t);
    out.env = this.pipe ? out.bank : 0;
    return out;
  }
  uFromX(x, g) { return this.pipe ? x - g.cx : (x - g.cx - this.pivot * Math.sin(g.th)) / Math.cos(g.th); }
  // surface point + lateral gravity pull for deck coordinate u
  point(u, g, out) {
    if (this.pipe) { const p = pipeProfile(u, g.env); out.x = g.cx + u; out.y = g.cy + p.h; out.pull = -G * p.dh / Math.sqrt(1 + p.dh * p.dh); out.slope = p.dh; }
    else { const [x, y] = deckPoint(g.cx, g.cy, this.pivot, u, g.th); out.x = x; out.y = y; out.pull = -G * Math.sin(g.th); out.slope = 0; }
    return out;
  }
  get n() { return this.cx.length; }
  get z1() { return this.z0 - (this.n - 1) * DZ; }
  push(cx, cy, hw, bank) { this.cx.push(cx); this.cy.push(cy); this.hw.push(hw); this.bank.push(bank); }
  freeze() { for (const k of ['cx', 'cy', 'hw', 'bank']) this[k] = Float32Array.from(this[k]); }
  // heading dcx/ds and curvature d²cx/ds² (s = forward distance) at z
  bend(z, out) {
    const a = this.sample(z + 1, {}).cx, b = this.sample(z, {}).cx, c = this.sample(z - 1, {}).cx;
    out.dcx = (c - a) / 2; out.kappa = Math.max(-KAPPA_MAX, Math.min(KAPPA_MAX, c - 2 * b + a));
    return out;
  }
  // deck centre height at z, extrapolated past the ends (entry slope behind, own slope ahead)
  heightAt(z) {
    if (z > this.z0) {
      const sl = this.entrySlope ?? (this.n > 1 ? (this.cy[0] - this.cy[1]) / DZ : 0);
      return this.cy[0] + (z - this.z0) * sl;
    }
    if (z < this.z1) { const n = this.n; return this.cy[n - 1] - (this.z1 - z) * (n > 1 ? (this.cy[n - 2] - this.cy[n - 1]) / DZ : 0); }
    return this.sample(z, {}).cy;
  }
  roll(t, bank) { return this.pipe ? 0 : bank + this.rollAt(t); }
  rollAt(t) { return this.rot ? this.rot.amp * Math.sin(this.rot.omega * t + this.rot.phase) : 0; }
  // interpolated sample → out { cx, cy, hw, bank }
  sample(z, out) {
    const f = Math.min(this.n - 1, Math.max(0, (this.z0 - z) / DZ));
    const i = Math.min(this.n - 2, Math.floor(f)), k = f - i;
    out.cx = lerp(this.cx[i], this.cx[i + 1], k); out.cy = lerp(this.cy[i], this.cy[i + 1], k);
    out.hw = lerp(this.hw[i], this.hw[i + 1], k); out.bank = lerp(this.bank[i], this.bank[i + 1], k);
    return out;
  }
}

// deck point for lateral u, rotated by θ about the pivot (cx, cy + hc)
export function deckPoint(cx, cy, hc, u, th) {
  const c = Math.cos(th), s = Math.sin(th);
  return [cx + u * c + hc * s, cy + hc + u * s - hc * c];
}
function uFromX(x, cx, hc, th) { return (x - cx - hc * Math.sin(th)) / Math.cos(th); }

// --------------------------------------------------------------- obstacles
// Every obstacle resolves to ≤ 3 oriented boxes at time t. Boxes flagged
// `ghost` are visual only (pendulum arm).
function box(o) { return o || { x: 0, y: 0, z: 0, hx: 0, hy: 0, hz: 0, yaw: 0, roll: 0, ghost: false }; }

export function obstacleBoxes(o, t, out) {
  const pl = o.pl, s = pl.geo(o.z, t, o._s || (o._s = {}));   // includes shuttle slide + tunnel roll
  const hc = pl.pivot, th = s.th;
  let n = 0;
  const put = (u, yUp, hx, hy, hz, yaw = 0, ghost = false) => {
    // place in deck space then rotate with the deck (tunnels / banks)
    const c = Math.cos(th), sn = Math.sin(th);
    const lx = u, ly = -hc + yUp;               // relative to pivot
    const b = out[n] = box(out[n]);
    b.x = s.cx + lx * c - ly * sn; b.y = s.cy + hc + lx * sn + ly * c; b.z = o.z;
    b.hx = hx; b.hy = hy; b.hz = hz; b.yaw = yaw; b.roll = th; b.ghost = ghost;
    n++;
  };
  const ph = o.omega * t + o.phase;
  switch (o.type) {
    case 'block': put(o.u, o.h / 2, o.w / 2, o.h / 2, o.d / 2); break;
    case 'wall': {
      const l0 = -s.hw, l1 = o.u - o.gap / 2, r0 = o.u + o.gap / 2, r1 = s.hw;
      if (l1 - l0 > 0.05) put((l0 + l1) / 2, o.h / 2, (l1 - l0) / 2, o.h / 2, 0.3);
      if (r1 - r0 > 0.05) put((r0 + r1) / 2, o.h / 2, (r1 - r0) / 2, o.h / 2, 0.3);
      break;
    }
    case 'slider': put(o.u + o.amp * Math.sin(ph), o.h / 2, o.w / 2, o.h / 2, o.d / 2); break;
    case 'gate': {
      const lift = 3.4 * Math.min(1, Math.max(0, Math.sin(ph) * 1.6 + 0.4));
      put(0, 0.35 + lift, s.hw, 0.35, 0.3);
      break;
    }
    case 'pendulum': {
      const a = Math.sin(ph);
      const u = o.amp * a, y = o.h / 2 + 0.7 * a * a;
      put(u, y, o.w / 2, o.h / 2, o.d / 2);
      const top = 9, armLen = top - y;
      put(u / 2, y + armLen / 2, 0.06, armLen / 2, 0.06, 0, true);
      break;
    }
    case 'rotor': {
      const yaw = o.rate * t + o.phase;
      put(o.u, 0.5, o.len / 2, 0.35, 0.22, yaw);
      put(o.u, 0.5, o.len / 2, 0.35, 0.22, yaw + Math.PI / 2);
      break;
    }
    case 'pistons': {
      // three blocks spanning the deck, each rising and falling on its own phase
      const w = (2 * s.hw) / 3;
      for (let i = 0; i < 3; i++) {
        const lift = 2.6 * Math.min(1, Math.max(0, Math.sin(ph + o.offs[i]) * 1.6 + 0.4));
        put(-s.hw + w * (i + 0.5), 0.8 + lift, w / 2 - 0.04, 0.8, 0.4);
      }
      break;
    }
    case 'lasers': {
      // thin vertical beams across the deck, each pulsing on/off on its own phase
      for (let i = 0; i < o.n; i++) {
        if (Math.sin(ph + o.offs[i]) > 0.15) put(-s.hw + (2 * s.hw) * (i + 0.5) / o.n, 1.3, 0.05, 1.3, 0.05);
      }
      break;
    }
    case 'fin': {
      const side = o.side, L = o.len;
      put(side * (s.hw - L / 2), o.h / 2, L / 2, o.h / 2, 0.2);
      break;
    }
  }
  return n;
}

// sphere vs oriented box (R = Ry(yaw)·Rz(roll))
export function sphereHitsBox(px, py, pz, r, b) {
  let dx = px - b.x, dy = py - b.y, dz = pz - b.z;
  if (b.yaw) { const c = Math.cos(-b.yaw), s = Math.sin(-b.yaw); const x = c * dx + s * dz, z = -s * dx + c * dz; dx = x; dz = z; }
  if (b.roll) { const c = Math.cos(-b.roll), s = Math.sin(-b.roll); const x = c * dx - s * dy, y = s * dx + c * dy; dx = x; dy = y; }
  const qx = Math.max(Math.abs(dx) - b.hx, 0), qy = Math.max(Math.abs(dy) - b.hy, 0), qz = Math.max(Math.abs(dz) - b.hz, 0);
  return qx * qx + qy * qy + qz * qz < r * r;
}

// --------------------------------------------------------------- course
const TYPES = [
  { id: 'straight', d: 0, w: 3 }, { id: 'narrow', d: 0, w: 2 },
  { id: 'banked', d: 0.1, w: 2 }, { id: 'steep', d: 0.1, w: 1.5 },
  { id: 'gap', d: 0.2, w: 2.5 }, { id: 'tunnel', d: 0.3, w: 1.6 },
  { id: 'thin', d: 0.45, w: 2 }, { id: 'split', d: 0.45, w: 1.4 },
  { id: 'winding', d: 0.25, w: 3 },
  { id: 'halfpipe', d: 0.3, w: 1.8 }, { id: 'strips', d: 0.4, w: 1.6 },
  { id: 'kicker', d: 0.15, w: 1.6 }, { id: 'blink', d: 0.35, w: 1.4 }, { id: 'shuttle', d: 0.5, w: 1.3 },
  { id: 'rottunnel', d: 0.75, w: 1.2 },
];
const OBSTACLES = [
  { id: 'block', d: 0, w: 3 }, { id: 'wall', d: 0.1, w: 2 }, { id: 'slider', d: 0.3, w: 2 },
  { id: 'gate', d: 0.45, w: 1.5 }, { id: 'pistons', d: 0.4, w: 2.4 }, { id: 'lasers', d: 0.35, w: 2.2 }, { id: 'pendulum', d: 0.6, w: 1.3 }, { id: 'rotor', d: 0.6, w: 1.2 },
];

export class Course {
  constructor() {
    this.chunks = [];
    this.listeners = { add: [], remove: [] };
    this.stats = { generated: 0, rejected: 0, fallbacks: 0 };
    this._s = {}; this._boxes = [];
  }
  on(ev, fn) { this.listeners[ev].push(fn); }

  reset(seed) {
    for (const c of this.chunks) for (const fn of this.listeners.remove) fn(c);
    this.chunks = [];
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    this.stats = { generated: 0, rejected: 0, fallbacks: 0 };
    const R = new Uint8Array(GN);
    for (let i = 0; i < GN; i++) { const x = GX0 + i * GDX; R[i] = Math.abs(x) <= 0.5 ? 1 : 0; }
    this.cur = { z: 12, cx: 0, cy: trackY(12), hw: 3.5, v: V_MIN, t: -12 / V_MIN, R, hist: [], sinceBreather: 0, nextBreather: 5, chunkId: 0, landedAt: null };
    // opening runway: breather straight
    const first = this.build('straight', { len: 70, breather: true });
    this.cur.R = this.validate(first, R) || R;
    this.addChunk(first);
    this.fill(0);
  }

  // stream: keep LOOKAHEAD metres generated ahead, drop chunks behind
  fill(ballZ, budget = 8) {
    while (budget-- > 0 && this.cur.z > ballZ - LOOKAHEAD) this.generateChunk();
    while (this.chunks.length && this.chunks[0].zEnd > ballZ + BEHIND) {
      const c = this.chunks.shift();
      for (const fn of this.listeners.remove) fn(c);
    }
  }

  // minD: debug/practice floor (URL &d=0.8)
  difficulty(z) { return Math.max(this.minD || 0, smooth(Math.min(1, Math.max(0, -z) / 3000))); }

  chooseType(d) {
    const c = this.cur, r = this.rng;
    if (c.sinceBreather >= c.nextBreather) return 'breather';
    const last2 = c.hist.slice(-2);
    const pool = TYPES.filter((t) => t.d <= d && !(last2.length === 2 && last2[0] === t.id && last2[1] === t.id));
    let sum = pool.reduce((s, t) => s + t.w, 0), x = r() * sum;
    for (const t of pool) { x -= t.w; if (x <= 0) return t.id; }
    return pool[pool.length - 1].id;
  }

  generateChunk() {
    const d = this.difficulty(this.cur.z);
    for (let attempt = 0; attempt < 8; attempt++) {
      const type = this.chooseType(d);
      const snap = this.snapshot();
      const chunk = type === 'breather' ? this.build('straight', { breather: true, len: null }) : this.build(type, { d });
      const R = this.validate(chunk, snap.R);
      if (R) { this.cur.R = R; this.commit(chunk, type); return; }
      this.stats.rejected++;
      this.restore(snap);
    }
    // fallback: a wide breather straight is always survivable from any entry inside the previous deck
    this.stats.fallbacks++;
    const snap = this.snapshot();
    const chunk = this.build('straight', { breather: true, len: 50, wide: true });
    let R = this.validate(chunk, snap.R);
    if (!R) {
      // the fallback is a wide straight: assume the player is somewhere on its exit deck
      R = new Uint8Array(GN); const pl = chunk.platforms[chunk.platforms.length - 1], s = pl.sample(pl.z1, {});
      for (let i = 0; i < GN; i++) { const x = GX0 + i * GDX; if (Math.abs(x - s.cx) <= s.hw - MARGIN) R[i] = 1; }
      chunk.exitHead = 0;
    }
    this.cur.R = R;
    this.commit(chunk, 'breather');
  }

  snapshot() { const c = this.cur; return { ...c, R: c.R, hist: c.hist.slice() }; }
  restore(s) { Object.assign(this.cur, s); }

  commit(chunk, type) {
    const c = this.cur;
    c.hist.push(type === 'breather' ? 'straight' : type); if (c.hist.length > 4) c.hist.shift();
    if (type === 'breather') { c.sinceBreather = 0; c.nextBreather = this.rng.int(4, 6); } else c.sinceBreather++;
    this.cur.head = chunk.exitHead || 0;
    this.addChunk(chunk);
    this.stats.generated++;
  }

  addChunk(chunk) {
    chunk.id = this.cur.chunkId++;
    for (const p of chunk.platforms) p.freeze();
    this.chunks.push(chunk);
    for (const fn of this.listeners.add) fn(chunk);
  }

  // ---------------------------------------------------------------- building
  // Advance the cursor one DZ step, integrating predicted speed/time.
  step(chunk, slopeTan, air = false, boost = false) {
    const c = this.cur;
    // boost pad: big surge that decays, plus a small permanent gain (same rule as Ball.step)
    if (boost && !air) { c.v = Math.min(V_MAX, c.v + BOOST_KEEP); c.boost = (c.boost || 0) + BOOST_ADD; }
    const vt = c.v + (c.boost || 0);
    const dt = DZ / vt;
    if (c.boost) { c.boost *= Math.exp(-dt / BOOST_TAU); if (c.boost < 0.05) c.boost = 0; }
    // crests: where the deck falls away faster than gravity can follow, the ball
    // flies (same rule as Ball.step), so those steps are airborne for the validator
    let flying = false;
    if (!air) {
      const deckNext = c.cy - DZ * slopeTan;
      if (c.fly) {
        c.bvy -= G * dt; c.by += c.bvy * dt;
        if (c.by <= deckNext) c.fly = false; else flying = true;
      } else if (c.lastSlope !== undefined && crestLaunch(vt, c.lastSlope, slopeTan, DZ)) {
        c.bvy = -c.lastSlope * vt; c.by = c.cy + c.bvy * dt - 0.5 * G * dt * dt;
        c.fly = flying = c.by > deckNext;
      }
      c.lastSlope = slopeTan;
    }
    // the ball spawns at z = 0 with V_MIN: no acceleration on the runway behind the spawn
    if (!air && !flying && c.z <= 0) c.v = Math.max(V_MIN, Math.min(V_MAX, c.v + accelAt(c.v, slopeTan) * dt));
    c.t += dt; c.z -= DZ;
    if (!air) c.cy -= DZ * slopeTan;
    chunk.steps.push({ z: c.z, t: c.t, v: vt, air: air || flying, cy: c.cy });
  }

  // slope that pulls the course back toward the nominal baseline
  baseSlope() {
    const debt = trackY(this.cur.z) - this.cur.cy; // >0: we are below the baseline
    if (debt > 0) return Math.max(TAN_RECOVER, SLOPE_TAN - debt * 0.01);
    return SLOPE_TAN + Math.min(-debt * 0.01, 0.06);
  }

  newChunk(type, d) { return { type, d, platforms: [], obstacles: [], steps: [{ z: this.cur.z, t: this.cur.t, v: this.cur.v, air: false, cy: this.cur.cy }], zStart: this.cur.z }; }

  // generic deck run: per-step callbacks give target hw / cx / bank / slope
  run(chunk, pl, len, f) {
    const c = this.cur, n = Math.max(2, Math.round(len / DZ));
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const s = f(k, i * DZ, n * DZ);
      if (s.hw !== undefined) c.hw = s.hw;
      if (s.cx !== undefined) c.cx = s.cx;
      if (pl.n === 0) pl.entrySlope = c.lastSlope;
      pl.push(c.cx, c.cy, c.hw, s.bank || 0);
      if (i < n) this.step(chunk, s.slope ?? this.baseSlope(), false, !!s.boost);
    }
    return pl;
  }

  build(type, o = {}) {
    const r = this.rng, c = this.cur, d = o.d ?? this.difficulty(c.z);
    const chunk = this.newChunk(type, d);
    const ease = (from, to, dist, len) => lerp(from, to, smooth(dist / Math.min(8, len)));
    const deck = (opts) => { const p = new Platform('deck', c.z, opts); chunk.platforms.push(p); return p; };
    // take-off run ending in a +6° lip
    const lipTan = Math.tan(Math.atan(SLOPE_TAN) - 6 * DEG);
    const lipRun = (pl, len, hw) => {
      const w0 = c.hw;
      this.run(chunk, pl, len, (k, dist, L) => ({ hw: ease(w0, hw, dist, L), slope: dist > L - 4 ? lipTan : undefined }));
      pl.lip = true; pl.openEnd = true;
    };
    // ballistic flight off the lip onto a new lower platform B (optionally ending in its own lip)
    const fly = ({ drop, reach: f, hwB, lenB, lipLen = 0, offMax = 1.5 }) => {
      const v = c.v + (c.boost || 0), th = Math.atan(lipTan);
      const vy0 = -v * Math.sin(th) / Math.cos(th);
      const tReach = (vy0 + Math.sqrt(vy0 * vy0 + 2 * G * drop)) / G;
      const gapLen = Math.max(3, f * v * tReach);
      const yLip = c.cy, zLip = c.z;
      let x = 0;
      for (let tf = 0; tf < 4; tf += 0.002) {
        x = v * tf;
        const yb = yLip + vy0 * tf - 0.5 * G * tf * tf;
        const ys = x < gapLen ? -1e9 : yLip - drop - (x - gapLen) * SLOPE_TAN;
        if (yb <= ys) break;
      }
      const landX = x, nAir = Math.round(gapLen / DZ), cyAir0 = c.cy;
      for (let i = 0; i < nAir; i++) { this.step(chunk, 0, true); chunk.steps[chunk.steps.length - 1].cy = lerp(cyAir0, yLip - drop, (i + 1) / nAir); }
      c.cy = yLip - drop;
      c.lastSlope = undefined; c.fly = false;
      c.cx += r.range(-1, 1) * Math.min(offMax, VLAT * (landX / v) * 0.7 * 0.3);
      c.hw = hwB;
      const B = deck({ openStart: true });
      const landRun = Math.max(lenB, (landX - gapLen) + (lipLen ? 6 : 14));
      if (lipLen) lipRun(B, landRun + lipLen, hwB);
      else this.run(chunk, B, landRun, () => ({ hw: hwB }));
      const landZ = zLip - landX;
      for (const st of chunk.steps) if (st.z < zLip - gapLen + 1e-6 && st.z > landZ) st.air = true;
      return { B, landZ };
    };

    switch (type) {
      case 'straight': {
        const len = o.len ?? (o.breather ? Math.max(c.v * 1.6, 30) : r.range(Math.max(40, c.v * 2), Math.max(70, c.v * 3.5)));
        const w0 = c.hw, w1 = 3.5;
        const p = deck();
        this.run(chunk, p, len, (k, dist, L) => ({ hw: ease(w0, w1, dist, L) }));
        if (!o.breather) this.placeObstacles(chunk, p, d);
        // (A13) side-wind jets: a zone that shoves you sideways
        if (!o.breather && d >= 0.25 && r() < 0.6) {
          const zA = p.z0 - r.range(8, len * 0.5), zB = zA - r.range(10, 20);
          p.jets.push({ zA, zB, a: r.sign() * r.range(14, 24) });
        }
        break;
      }
      case 'narrow': {
        const len = r.range(Math.max(35, c.v * 1.5), Math.max(70, c.v * 2.8)), w0 = c.hw, w1 = r.range(3.5, 5) / 2;
        const p = deck();
        this.run(chunk, p, len, (k, dist, L) => ({ hw: ease(w0, w1, dist, L) }));
        this.placeObstacles(chunk, p, d, ['block', 'slider']);
        break;
      }
      case 'banked': {
        // owner request: some banks tilt much further (~1 in 4: 28–38°)
        const steepBank = d >= 0.2 && r() < 0.25;
        const len = r.range(40, 80), B = r.sign() * (steepBank ? r.range(28, 38) : r.range(8, 8 + 14 * (0.5 + 0.5 * d))) * DEG, w0 = c.hw;
        const p = deck();
        this.run(chunk, p, len, (k, dist, L) => ({ hw: ease(w0, 3.5, dist, L), bank: B * smooth(dist / 10) * smooth((L - dist) / 10) }));
        if (d >= 0.3) this.placeObstacles(chunk, p, d, ['block', 'slider'], 1.3);
        break;
      }
      case 'steep': {
        const len = r.range(15, 30), w0 = c.hw;
        const p = deck();
        this.run(chunk, p, len + 20, (k, dist, L) => ({ hw: ease(w0, 3.5, dist, L), slope: dist > 6 && dist < len + 6 ? Math.tan(25 * DEG) : undefined }));
        break;
      }
      case 'thin': {
        // owner feedback: the original 1.6–2.5 m was too hard → 2.2–3.2 m (SPEC amendment A3)
        const len = r.range(50, 90), hw1 = lerp(1.6, 1.1, d), w0 = c.hw, cx0 = c.cx;
        // amplitude limited by minimum radius 35 m (S-curve: A·k² ≤ 1/35)
        const k2 = (2 * Math.PI / len) ** 2, Amax = Math.min(6, 1 / (35 * k2));
        const A = r.range(0.4, 1) * Amax * (r() < 0.5 ? 1 : -1), sCurve = r() < 0.6;
        // a single bend ends offset: steer the sign back toward the canyon centre
        const Aa = sCurve ? A : -Math.sign(cx0 || r.sign()) * Math.abs(A) * 0.6;
        const p = new Platform('thin', c.z); chunk.platforms.push(p);
        this.run(chunk, p, len, (k, dist, L) => ({
          hw: lerp(w0, hw1, smooth(dist / 6)),
          // eased so the section starts and ends pointing straight down the slope
          // (an angled join is a kink, and a kink reads as a huge sideways shove)
          cx: cx0 + (sCurve ? Aa * Math.sin(2 * Math.PI * k) * smooth(k * 5) * smooth((1 - k) * 5) : Aa * (1 - Math.cos(Math.PI * k)) / 2),
        }));
        break;
      }
      case 'winding': {
        // owner request (SPEC amendment A1): long sweeping S-bends that also roll up and
        // down. Rolls crest hard enough at speed to throw the ball into short hops.
        const len = r.range(120, 220), cycles = r() < 0.5 ? 1 : 2, lam = len / cycles;
        const Amax = Math.min(9, (lam * lam) / (25 * 4 * Math.PI * Math.PI)); // min radius 25 m
        const A = r.sign() * r.range(0.5, 1) * Amax, w0 = c.hw, hw1 = lerp(2.5, 1.5, d) * r.range(0.9, 1.1);
        // vertical rolls twice per lateral cycle, phased so every crest sits on an
        // inflection of the bend: the ball only hops where the track runs straight
        // roll height sized to the predicted speed: crest curvature ≈ 1.5·G/v² gives a
        // short consistent hop (~0.2–0.3 s) instead of a long flight off a bending track
        const vc = 2 * cycles, kv = (2 * Math.PI * vc) / len;
        const H = Math.min(3, (r.range(1.3, 1.7) * G) / (c.v * c.v) / (kv * kv)), cx0 = c.cx;
        const p = deck();
        this.run(chunk, p, len, (k, dist, L) => {
          const env = smooth(k * 6) * smooth((1 - k) * 6);
          return {
            hw: lerp(w0, hw1, smooth(dist / 10)),
            cx: cx0 + A * Math.sin(2 * Math.PI * cycles * k) * env,
            slope: this.baseSlope() + H * (2 * Math.PI * vc / L) * Math.sin(2 * Math.PI * vc * k) * env, // h = H·cos → crests at bend inflections
          };
        });
        this.run(chunk, p, 18, () => ({})); // flat run-out: land before the next section
        break;
      }
      case 'split': {
        // ease to full width, then two lanes over a void, then merge
        const pre = deck();
        const w0 = c.hw;
        this.run(chunk, pre, 8, (k, dist, L) => ({ hw: ease(w0, 3.5, dist, L) }));
        const len = r.range(20, 40), g = r.range(0.6, 1.5), lhw = 1.25, cx = c.cx;
        const zStart = c.z, cyStart = c.cy;
        const L = new Platform('lane', zStart), Rr = new Platform('lane', zStart);
        chunk.platforms.push(L, Rr);
        const n = Math.round(len / DZ);
        for (let i = 0; i <= n; i++) {
          if (i === 0) L.entrySlope = Rr.entrySlope = c.lastSlope;
          L.push(cx - lhw - g, c.cy, lhw, 0); Rr.push(cx + lhw + g, c.cy, lhw, 0);
          if (i < n) this.step(chunk, this.baseSlope());
        }
        c.hw = 3.5;
        if (d > 0.5 && r() < 0.6) {
          const lane = r() < 0.5 ? L : Rr, oz = zStart - r.range(0.4, 0.7) * len;
          chunk.obstacles.push(this.obst('block', lane, oz, { u: 0, w: 1.0, h: 1.2, d: 0.9 }));
        }
        const post = deck();
        this.run(chunk, post, 10, () => ({ hw: 3.5 }));
        void cyStart;
        break;
      }
      case 'gap': {
        const A = deck();
        lipRun(A, r.range(18, 30), 3.5);
        const { B } = fly({ drop: r.range(2, lerp(6, 10, d)), reach: lerp(0.45, 0.8, d) * r.range(0.9, 1), hwB: lerp(3.5, 1.25, d * r()), lenB: r.range(25, 40) });
        if (d >= 0.35) this.placeObstacles(chunk, B, d, ['block', 'wall', 'slider']);
        break;
      }
      case 'strips': {
        // owner request (A7): a chain of 3 m strips, each ending in a lip onto the next
        const A = deck();
        lipRun(A, r.range(16, 24), 3.5);
        const n = r.int(3, 5);
        for (let i = 0; i < n; i++) {
          const last = i === n - 1;
          const { B } = fly({ drop: r.range(1.5, 3), reach: r.range(0.45, 0.6), hwB: last ? 3.5 : 1.5, lenB: last ? 22 : 0, lipLen: last ? 0 : r.range(6, 9), offMax: 0.8 });
          void B;
        }
        break;
      }
      case 'kicker': {
        // (A10) launch ramp on a straight: a short uphill kicker, then the crest throws you
        const w0 = c.hw, lead = r.range(20, 35), up = Math.tan(r.range(8, 14) * DEG);
        const p = deck();
        this.run(chunk, p, lead + 6 + 40, (k, dist, L) => ({ hw: ease(w0, 3.5, dist, L), slope: dist > lead && dist < lead + 6 ? -up : undefined }));
        if (d >= 0.3) this.placeObstacles(chunk, p, d, ['block'], 1.4);
        break;
      }
      case 'blink': {
        // (A11) blink tiles: a run of short deck tiles that switch off and on; time the crossing
        const pre = deck(); const w0 = c.hw;
        this.run(chunk, pre, 8, (k, dist, L) => ({ hw: ease(w0, 3.5, dist, L) }));
        const n = r.int(4, 7), period = r.range(1.4, 2.2);
        for (let i = 0; i < n; i++) {
          const duty = r.range(0.6, 0.75), omega = (2 * Math.PI) / period;
          const tl = deck({ blink: { omega, phase: 0, duty } });
          tl.openStart = tl.openEnd = true;
          const tIn = c.t;
          this.run(chunk, tl, r.range(5, 8), () => ({ hw: 3.5 }));
          // phase each tile so it is solid around the predicted crossing (it still blinks
          // the rest of the cycle — you have to trust the rhythm)
          const tMid = (tIn + c.t) / 2;
          tl.blink.phase = 2 * Math.PI * duty * r.range(0.4, 0.6) - omega * tMid;
        }
        const post = deck(); post.openStart = true;
        this.run(chunk, post, 10, () => ({ hw: 3.5 }));
        break;
      }
      case 'shuttle': {
        // (A12) shuttle platform: a deck section sliding side to side over the void
        const pre = deck(); const w0 = c.hw;
        this.run(chunk, pre, 8, (k, dist, L) => ({ hw: ease(w0, 2.2, dist, L) }));
        const sl = deck({ slide: { amp: r.range(1.2, 2.4), omega: (2 * Math.PI) / r.range(2.5, 4), phase: r.range(0, 6.28) } });
        sl.openStart = sl.openEnd = true;
        this.run(chunk, sl, r.range(25, 45), () => ({ hw: 2.2 }));
        c.hw = 2.2;
        const post = deck(); post.openStart = true;
        this.run(chunk, post, 10, (k, dist, L) => ({ hw: ease(2.2, 3.5, dist, L) }));
        break;
      }
      case 'halfpipe': {
        // owner request (A8): flat floor with quarter-pipe ramp walls; steer into a wall to
        // ride up it, and fast enough you launch out of the top and drop back in
        const pre = deck(); const w0 = c.hw;
        this.run(chunk, pre, 8, (k, dist, L) => ({ hw: ease(w0, 3.5, dist, L) }));
        const len = r.range(70, 130);
        const p = deck({ pipe: true });
        this.run(chunk, p, len, (k, dist, L) => ({ hw: PIPE_F + PIPE_R, bank: smooth(dist / 10) * smooth((L - dist) / 10) }));
        c.hw = 3.5;
        const post = deck();
        this.run(chunk, post, 8, () => ({ hw: 3.5 }));
        break;
      }
      case 'tunnel':
      case 'rottunnel': {
        const rot = type === 'rottunnel' ? { amp: r.range(12, 25) * DEG, omega: (2 * Math.PI) / r.range(3, 5), phase: r.range(0, 6.28) } : null;
        // lead-in to full width first so the tunnel mouth is clean
        const pre = deck(); const w0 = c.hw;
        this.run(chunk, pre, 10, (k, dist, L) => ({ hw: ease(w0, 3.5, dist, L) }));
        const len = r.range(40, 120);
        const p = deck({ tunnel: true, rot });
        // boost pads (A9): full-width, so every run takes them and timing stays predictable
        const padAt = d >= 0.3 && !rot ? [r.range(10, Math.max(12, len * 0.4))] : [];
        if (padAt.length && len > 70 && r() < 0.5) padAt.push(r.range(len * 0.6, len - 12));
        let pi = 0;
        this.run(chunk, p, len, (k, dist) => {
          const hit = pi < padAt.length && dist >= padAt[pi];
          if (hit) { p.pads.push(c.z); pi++; }
          return { hw: 3.5, boost: hit };
        });
        const kinds = ['block', 'slider'];
        if (d >= 0.6) kinds.push('fin', 'rotor');
        if (d >= 0.3) this.placeObstacles(chunk, p, d, kinds, rot ? 1.3 : 1);
        break;
      }
    }
    chunk.zEnd = c.z;
    // (A14) shards: score pickups, often on the risky line (walls, strips, edges)
    chunk.shards = [];
    for (const pl of chunk.platforms) {
      if (pl.blink || pl.n < 12 || r() > 0.3) continue;
      const k = r.int(3, 6), i0 = r.int(2, Math.max(3, pl.n - k * 6 - 2)), u = r.range(-1, 1) * Math.max(0, pl.hw[i0] - 0.6);
      for (let j = 0; j < k; j++) { const i = Math.min(pl.n - 1, i0 + j * 6); chunk.shards.push({ pl, z: pl.z0 - i * DZ, u: pl.pipe ? u * 1.6 : u, taken: false }); }
    }
    return chunk;
  }

  obst(type, pl, z, extra) {
    return { type, pl, z, u: 0, w: 1, h: 1, d: 1, omega: 0, phase: 0, ...extra };
  }

  placeObstacles(chunk, pl, d, kinds = null, spacingMul = 1) {
    const r = this.rng;
    const allowed = OBSTACLES.filter((o) => o.d <= d && (!kinds || kinds.includes(o.id)));
    if (kinds?.includes('fin') && d >= 0.6) allowed.push({ id: 'fin', d: 0.6, w: 1.5 });
    if (!allowed.length) return;
    // walk the platform by predicted travel time
    const steps = chunk.steps;
    const tAt = (z) => { for (let i = 1; i < steps.length; i++) if (steps[i].z <= z) return [steps[i].t, steps[i].v]; const s = steps[steps.length - 1]; return [s.t, s.v]; };
    const zA = pl.z0, zB = pl.z1;
    const [tStart] = tAt(zA - 0.01), [tEnd] = tAt(zB + 0.01);
    const cur = this.cur;
    const gapT = () => lerp(0.9, 0.45, d) * (1 + r() * 0.6) * spacingMul;
    // decision spacing carries across chunks (no reset at chunk boundaries)
    let t = Math.max(tStart + 0.2, (cur.lastObsT ?? -1e9) + gapT());
    if (pl.openStart) t = Math.max(t, tStart + 1.2); // no obstacle within 1.2 s after landing
    const tLast = pl.lip ? tEnd - 0.6 : tEnd - 0.3;
    while (t < tLast) {
      // convert time → z on this platform
      let z = zA;
      for (let i = 1; i < steps.length; i++) if (steps[i].t >= t) { z = steps[i].z; break; }
      if (z < zB) break;
      if (r() < 0.85) {
        const s = pl.sample(z, {});
        const kind = this.pickWeighted(allowed);
        const o = this.obst(kind, pl, z, {});
        const hw = s.hw;
        switch (kind) {
          case 'block': o.w = r.range(0.8, Math.min(2.6, hw * 2 - 1.8)); o.h = r.range(1, 2.5); o.d = r.range(0.8, 1.2); o.u = r.range(-hw + o.w / 2, hw - o.w / 2); break;
          case 'wall': o.gap = r.range(1.6, 2.5); o.h = r.range(1.6, 2.4); o.u = r.range(-hw + o.gap / 2 + 0.2, hw - o.gap / 2 - 0.2); break;
          case 'slider': o.w = r.range(1.2, 2); o.h = r.range(1, 1.8); o.d = 0.9; o.amp = Math.max(0.2, hw - o.w / 2 - 0.05); o.u = 0; o.omega = (2 * Math.PI) / r.range(1.6, 3.5); o.phase = r.range(0, 6.28); break;
          case 'gate': o.omega = (2 * Math.PI) / r.range(1.8, 3.2); o.phase = r.range(0, 6.28); break;
          case 'lasers': o.n = Math.max(3, Math.round(hw * 1.4)); o.omega = (2 * Math.PI) / r.range(1.6, 2.6); o.phase = r.range(0, 6.28); o.offs = Array.from({ length: o.n }, (_, i) => i * r.range(0.6, 1.4)); break;
          case 'pistons': o.omega = (2 * Math.PI) / r.range(1.8, 3.0); o.phase = r.range(0, 6.28); o.offs = [0, r.range(1.5, 2.6), r.range(3.2, 4.6)]; break;
          case 'pendulum': o.w = r.range(1.2, 1.8); o.h = 1.4; o.d = 0.9; o.amp = Math.max(0.3, hw - o.w / 2); o.omega = (2 * Math.PI) / r.range(2, 4); o.phase = r.range(0, 6.28); break;
          case 'rotor': o.len = hw * 2 * 0.8; o.rate = r.sign() * r.range(40, 90) * DEG; o.phase = r.range(0, 6.28); o.u = 0; break;
          case 'fin': o.side = r.sign(); o.len = r.range(1.5, 2.5); o.h = r() < 0.5 ? TUBE_H : 2.2; break;
        }
        chunk.obstacles.push(o);
        cur.lastObsT = t;
      }
      t += gapT();
    }
  }

  pickWeighted(list) { const r = this.rng; let s = list.reduce((a, b) => a + b.w, 0), x = r() * s; for (const o of list) { x -= o.w; if (x <= 0) return o.id; } return list[0].id; }

  // ---------------------------------------------------------------- validator
  // Sweeps a lateral "ghost" grid through the chunk using the predicted speed and
  // arrival times. Returns the reachable exit set, or null if no corridor ≥ 0.6 m survives.
  validate(chunk, entry) {
    let R = Uint8Array.from(entry), N = new Uint8Array(GN);
    const trace = this.keepTrace ? [] : null; // debug: per-step reachable sets for the oracle test
    const s = {}, boxes = this._boxes;
    let wasAir = false, prevCx = null, Lacc = 0, Hacc = 0, head = this.cur.head || 0, airAcc = 0;
    const bd = {};
    for (let k = 1; k < chunk.steps.length; k++) {
      const st = chunk.steps[k];
      if (st.air) {
        // in flight the ball keeps its take-off heading: drift the whole set with it
        wasAir = true; prevCx = null; Lacc = Hacc = 0;
        airAcc += (head * DZ) / GDX;
        const sh = Math.trunc(airAcc);
        if (sh) {
          airAcc -= sh; N.fill(0);
          for (let i = 0; i < GN; i++) if (R[i]) { const j = i + sh; if (j >= 0 && j < GN) N[j] = 1; }
          [R, N] = [N, R];
        }
        if (trace) trace.push({ z: st.z, air: true, sh });
        continue;
      }
      airAcc = 0;
      // lateral dynamics for this step: ghosts follow the deck heading, feel partial
      // centrifugal + bank pull, and can steer at 70% of terminal lateral speed
      let pl0 = null;
      for (const pl of chunk.platforms) if (st.z <= pl.z0 + 1e-6 && st.z >= pl.z1 - 1e-6) { pl0 = pl; break; }
      let lo = 0, hi = 0;
      if (pl0 && !wasAir) {
        pl0.geo(st.z, st.t, s); pl0.bend(st.z, bd); head = bd.dcx;
        const a = -CENTRIFUGAL * st.v * st.v * bd.kappa + (pl0.pipe ? 0 : -G * Math.sin(s.th)) + pl0.jetAt(st.z);
        const dt = DZ / st.v;
        const shift = prevCx === null ? 0 : s.cx - prevCx;
        lo = ((a - STEER_FRAC * STEER_ACC) / STEER_DAMP) * dt + shift;
        hi = ((a + STEER_FRAC * STEER_ACC) / STEER_DAMP) * dt + shift;
        prevCx = s.cx;
      } else if (pl0) { pl0.geo(st.z, st.t, s); prevCx = s.cx; }
      // sub-cell motion carries over between steps (rounding outward here would
      // roughly double the lateral speed the validator believes the ball has)
      Lacc += lo / GDX; Hacc += hi / GDX;
      let cLo = Math.ceil(Lacc), cHi = Math.floor(Hacc);
      if (cLo > cHi) { cLo = cHi = 0; } else { Lacc -= cLo; Hacc -= cHi; }
      N.fill(0);
      for (let i = 0; i < GN; i++) if (R[i]) { const a = Math.max(0, i + cLo), b = Math.min(GN - 1, i + cHi); for (let j = a; j <= b; j++) N[j] = 1; }
      wasAir = false;
      // safe: on some platform (eroded), for all t in the window
      const safe = new Uint8Array(GN);
      for (const pl of chunk.platforms) {
        if (st.z > pl.z0 + 1e-6 || st.z < pl.z1 - 1e-6) continue;
        let lo = -1e9, hi = 1e9;
        for (const dt of [-0.15, 0, 0.15]) {
          if (!pl.solidAt(st.t + dt)) { lo = 1e9; break; }      // blink tile off at some point in the window
          pl.geo(st.z, st.t + dt, s);
          const lim = (pl.tunnel ? s.hw - BALL_R : s.hw) - MARGIN;
          if (pl.pipe) { lo = Math.max(lo, s.cx - lim); hi = Math.min(hi, s.cx + lim); continue; }
          const x0 = s.cx + Math.cos(s.th) * -lim + pl.pivot * Math.sin(s.th), x1 = s.cx + Math.cos(s.th) * lim + pl.pivot * Math.sin(s.th);
          lo = Math.max(lo, x0); hi = Math.min(hi, x1);
        }
        for (let i = Math.max(0, Math.ceil((lo - GX0) / GDX)); i <= Math.min(GN - 1, Math.floor((hi - GX0) / GDX)); i++) safe[i] = 1;
      }
      // obstacles near this z, at the predicted arrival time ± 0.15 s
      for (const o of chunk.obstacles) {
        if (Math.abs(o.z - st.z) > 3.5) continue;
        const pl = o.pl;
        for (const dt of [-0.15, 0, 0.15]) {
          const nb = obstacleBoxes(o, st.t + dt, boxes);
          for (let bi = 0; bi < nb; bi++) {
            const b = boxes[bi]; if (b.ghost) continue;
            const ext = Math.hypot(b.hx, b.hz) + BALL_R + MARGIN;
            if (Math.abs(b.z - st.z) > ext) continue;
            const i0 = Math.max(0, Math.floor((b.x - ext - GX0) / GDX)), i1 = Math.min(GN - 1, Math.ceil((b.x + ext - GX0) / GDX));
            for (let i = i0; i <= i1; i++) {
              if (!safe[i]) continue;
              const x = GX0 + i * GDX;
              pl.geo(st.z, st.t + dt, s);
              const yd = pl.point(pl.uFromX(x, s), s, this._p || (this._p = {})).y;
              if (sphereHitsBox(x, yd + BALL_R, st.z, BALL_R + MARGIN, b)) safe[i] = 0;
            }
          }
        }
      }
      let any = 0;
      for (let i = 0; i < GN; i++) { N[i] = N[i] & safe[i]; any |= N[i]; }
      if (!any) return null;
      if (trace) trace.push({ z: st.z, R: Uint8Array.from(N), cLo, cHi });
      [R, N] = [N, R];
    }
    if (trace) chunk.trace = trace;
    chunk.exitHead = head;
    return R;
  }

  // ---------------------------------------------------------------- queries
  // Deck under (x, z) at time t, nearest at/below refY. → { y, u, hw, theta, pl } | null
  surfaceAt(x, z, t, refY, out = {}) {
    let best = null, bestY = -1e9;
    const g = this._s, P = this._p || (this._p = {});
    for (const c of this.chunks) {
      if (z > c.zStart + 1 || z < c.zEnd - 1) continue;
      for (const pl of c.platforms) {
        if (z > pl.z0 || z < pl.z1 || !pl.solidAt(t)) continue;
        pl.geo(z, t, g);
        const u = pl.uFromX(x, g);
        if (Math.abs(u) > g.hw + BALL_R * 0.2) continue;
        pl.point(u, g, P);
        if (P.y > refY + 0.8) continue;
        if (P.y > bestY) { bestY = P.y; best = pl; out.y = P.y; out.u = u; out.hw = g.hw; out.theta = g.th; out.cx = g.cx; out.cy = g.cy; }
      }
    }
    if (!best) return null;
    out.pl = best;
    return out;
  }

  // Course clock: the generator's predicted arrival time at z. Moving hazards and
  // rotating tunnels run on this clock (driven by the ball's position), so what the
  // player meets at any obstacle is exactly the phase the validator checked, even if
  // real speed drifts from the prediction by a few tenths of a second over a long run.
  clockAt(z) {
    for (const c of this.chunks) {
      if (z > c.zStart || z < c.zEnd) continue;
      const st = c.steps;
      const i = Math.min(st.length - 1, Math.max(1, Math.ceil((c.zStart - z) / DZ)));
      const a = st[i - 1], b = st[i];
      const k = Math.min(1, Math.max(0, (a.z - z) / (a.z - b.z || 1)));
      return a.t + (b.t - a.t) * k;
    }
    return 0;
  }

  // centreline + nominal height at z (for camera, death floor, debug gate)
  centreAt(z, out = {}) {
    for (const c of this.chunks) {
      if (z > c.zStart || z < c.zEnd) continue;
      for (const pl of c.platforms) if (z <= pl.z0 && z >= pl.z1) { pl.sample(z, this._s); out.cx = this._s.cx; out.cy = this._s.cy; out.bank = this._s.bank; out.pl = pl; return out; }
      // in a gap: interpolate the step record
      const st = c.steps; for (let i = 1; i < st.length; i++) if (st[i].z <= z) { out.cx = out.cx ?? 0; out.cy = st[i].cy; out.bank = 0; out.pl = null; return out; }
    }
    out.cy = trackY(z); out.bank = 0; out.pl = null; out.cx = out.cx ?? 0;
    return out;
  }

  // pickups within reach of the ball; returns bonus points collected
  collectShards(x, y, z) {
    let pts = 0;
    for (const c of this.chunks) {
      if (z > c.zStart + 2 || z < c.zEnd - 2 || !c.shards) continue;
      for (const sh of c.shards) {
        if (sh.taken || Math.abs(sh.z - z) > 1.3) continue;
        const g = sh.pl.geo(sh.z, this.clockAt(sh.z), this._s), P = sh.pl.point(sh.u, g, this._p || (this._p = {}));
        if (Math.hypot(P.x - x, P.y + 0.8 - y) < 1.25) { sh.taken = true; pts += 10; this.shardsTaken = (this.shardsTaken || 0) + 1; }
      }
    }
    return pts;
  }

  hitObstacle(x, y, z, r, t) {
    const boxes = this._boxes;
    for (const c of this.chunks) {
      if (z > c.zStart + 4 || z < c.zEnd - 4) continue;
      for (const o of c.obstacles) {
        if (Math.abs(o.z - z) > 4) continue;
        const n = obstacleBoxes(o, t, boxes);
        for (let i = 0; i < n; i++) if (!boxes[i].ghost && sphereHitsBox(x, y, z, r, boxes[i])) return true;
      }
    }
    return false;
  }
}
