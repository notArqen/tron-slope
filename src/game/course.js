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
export const STEER_ACC = 70, STEER_DAMP = 10; // same top lateral speed (7 m/s), reached ~1.5× faster
export const V_MIN = 14, V_MAX = 72, K_ACC = 4.8; // owner: top speed raised from 62 (≈260 km/h)
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
  const put = (u, yUp, hx, hy, hz, yaw = 0, ghost = false) => { // returns the new box count
    // place in deck space then rotate with the deck (tunnels / banks)
    const c = Math.cos(th), sn = Math.sin(th);
    const lx = u, ly = -hc + yUp;               // relative to pivot
    const b = out[n] = box(out[n]);
    b.x = s.cx + lx * c - ly * sn; b.y = s.cy + hc + lx * sn + ly * c; b.z = o.z;
    b.hx = hx; b.hy = hy; b.hz = hz; b.yaw = yaw; b.roll = th; b.ghost = ghost;
    return ++n;
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
      // pop-up blocks: chunky blocks rising out of glowing floor pads on a timer
      for (let i = 0; i < o.n; i++) {
        const u = -s.hw + (2 * s.hw) * (i + 0.5) / o.n, w = Math.min(0.6, s.hw / o.n - 0.15);
        put(u, 0.04, w + 0.1, 0.04, 0.7, 0, true); // pad: always visible, shows where a block lives
        const h = 1.4 * Math.max(0, Math.min(1, Math.sin(ph + o.offs[i]) * 1.6 + 0.2));
        if (h > 0.08) put(u, h / 2, w, h / 2, 0.6);
      }
      break;
    }
    case 'crusher': {        // heavy slab over half the deck: slow lift, fast slam
      const f = ((ph / (2 * Math.PI)) % 1 + 1) % 1, lift = f < 0.7 ? f / 0.7 : 1 - (f - 0.7) / 0.08;
      put(o.side * s.hw / 2, 0.9 + 3.2 * Math.max(0, Math.min(1, lift)), s.hw / 2 - 0.05, 0.9, 0.9);
      break;
    }
    case 'sweeper': {        // low arm on an edge post sweeping across the deck
      const a = o.side * (0.5 + 0.5 * Math.sin(ph)) * Math.PI * 0.5;
      const L = s.hw * 1.6, cxu = o.side * -s.hw;
      put(cxu + (-o.side) * Math.cos(a) * L / 2, 0.45, L / 2, 0.22, 0.18, -o.side * a);
      put(cxu, 1.0, 0.18, 1.0, 0.18, 0, true);
      break;
    }
    case 'zipper': {         // block shuttling along the track toward you and away
      const n = put(o.u, o.h / 2, o.w / 2, o.h / 2, 0.6);
      out[n - 1].z = o.z + o.amp * Math.sin(ph);
      break;
    }
    case 'orbiters': {       // two blocks circling a point on the deck
      for (let i = 0; i < 2; i++) { const a = ph + i * Math.PI; const k = put(o.u + Math.cos(a) * o.rad, 0.5, 0.45, 0.5, 0.45); out[k - 1].z = o.z + Math.sin(a) * o.rad; }
      break;
    }
    case 'wave': {           // pillar row rising in a travelling wave: the gap moves across
      for (let i = 0; i < o.n; i++) {
        const h = 2.4 * Math.max(0, Math.min(1, Math.sin(ph - i * o.k) * 1.4 + 0.3));
        if (h > 0.05) put(-s.hw + (2 * s.hw) * (i + 0.5) / o.n, h / 2, s.hw / o.n - 0.05, h / 2, 0.35);
      }
      break;
    }
    case 'slalom': {         // staggered static blocks: weave through
      const n = put(o.u, 0.7, 0.7, 0.7, 0.45); out[n - 1].z = o.z;
      const m = put(-o.u, 0.7, 0.7, 0.7, 0.45); out[m - 1].z = o.z - o.gapZ;
      break;
    }
    case 'twinrotor': {      // two counter-rotating crosses side by side
      for (const sd of [-1, 1]) { const yaw = sd * o.rate * t + o.phase; put(sd * s.hw / 2, 0.5, s.hw / 2 * 0.85, 0.3, 0.2, yaw); put(sd * s.hw / 2, 0.5, s.hw / 2 * 0.85, 0.3, 0.2, yaw + Math.PI / 2); }
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
// keep it simple and consistent like the original: a small core of section types
// carries the run; everything else is a rare curveball (never two in a row)
const CURVEBALLS = new Set(['halfpipe', 'strips', 'blink', 'shuttle', 'megajump', 'stairs', 'islands', 'coaster', 'corkscrew', 'fork', 'split', 'rottunnel']);
const RARE_OBSTACLES = new Set(['pendulum', 'rotor', 'lasers', 'crusher', 'sweeper', 'zipper', 'orbiters', 'wave', 'slalom', 'twinrotor', 'gate']);
const TYPES = [
  { id: 'straight', d: 0, w: 3 }, { id: 'narrow', d: 0, w: 2 },
  { id: 'banked', d: 0.1, w: 2 }, { id: 'steep', d: 0.1, w: 1.5 },
  { id: 'gap', d: 0.2, w: 2.5 }, { id: 'tunnel', d: 0.3, w: 1.6 },
  { id: 'thin', d: 0.45, w: 2 }, { id: 'split', d: 0.45, w: 1.4 },
  { id: 'winding', d: 0.25, w: 3 },
  { id: 'halfpipe', d: 0.3, w: 1.8 }, { id: 'strips', d: 0.4, w: 1.6 },
  { id: 'kicker', d: 0.15, w: 1.6 },
  { id: 'megajump', d: 0.3, w: 1.2 }, { id: 'stairs', d: 0.2, w: 1.4 }, { id: 'islands', d: 0.45, w: 1.3 },
  { id: 'coaster', d: 0.2, w: 1.5 }, { id: 'corkscrew', d: 0.35, w: 1.3 }, { id: 'fork', d: 0.3, w: 1.3 }, { id: 'blink', d: 0.35, w: 1.4 }, { id: 'shuttle', d: 0.5, w: 1.3 },
  { id: 'rottunnel', d: 0.75, w: 1.2 },
];
const OBSTACLES = [
  { id: 'block', d: 0, w: 3 }, { id: 'wall', d: 0.1, w: 2 }, { id: 'slider', d: 0.3, w: 2 },
  { id: 'gate', d: 0.45, w: 1.5 }, { id: 'pistons', d: 0.4, w: 2.4 }, { id: 'lasers', d: 0.35, w: 2.2 },
  { id: 'crusher', d: 0.3, w: 2 }, { id: 'sweeper', d: 0.35, w: 1.8 }, { id: 'zipper', d: 0.25, w: 1.8 }, { id: 'orbiters', d: 0.45, w: 1.6 },
  { id: 'wave', d: 0.5, w: 1.8 }, { id: 'slalom', d: 0.15, w: 2 }, { id: 'twinrotor', d: 0.6, w: 1.4 }, { id: 'pendulum', d: 0.6, w: 1.3 }, { id: 'rotor', d: 0.6, w: 1.2 },
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
    const last2 = c.hist.slice(-2), lastCurve = CURVEBALLS.has(c.hist[c.hist.length - 1]);
    const curvy = (id) => this.noCurves && (id === 'thin' || id === 'winding' || id === 'corkscrew');
    const pool = TYPES.filter((t) => t.d <= d && !curvy(t.id) && !(last2.length === 2 && last2[0] === t.id && last2[1] === t.id) && !(lastCurve && CURVEBALLS.has(t.id)));
    // curveballs share ~14% of the weight between them, however many are unlocked
    const core = pool.filter((t) => !CURVEBALLS.has(t.id)), curve = pool.filter((t) => CURVEBALLS.has(t.id));
    const coreW = core.reduce((s, t) => s + t.w, 0), curveW = curve.reduce((s, t) => s + t.w, 0);
    const wOf = (t) => (CURVEBALLS.has(t.id) ? (t.w / (curveW || 1)) * coreW * 0.24 : t.w);
    let sum = pool.reduce((s, t) => s + wOf(t), 0), x = r() * sum;
    for (const t of pool) { x -= wOf(t); if (x <= 0) return t.id; }
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
    let lipTan = Math.tan(Math.atan(SLOPE_TAN) - 6 * DEG);
    const lipRun = (pl, len, hw, kick = 6) => {
      const w0 = c.hw;
      lipTan = Math.tan(Math.atan(SLOPE_TAN) - kick * DEG);
      this.run(chunk, pl, len, (k, dist, L) => ({ hw: ease(w0, hw, dist, L), slope: dist > L - 4 ? lipTan : undefined }));
      pl.lip = true; pl.openEnd = true;
    };
    // superelevation: tilt a curved deck into its bends so the bank cancels ~80% of the
    // outward push (G·sinθ = 0.8·C·v²κ) — curves feel like roads, not conveyor belts
    const autoBank = (pl, i0) => {
      const n = pl.cx.length, st = chunk.steps;
      for (let i = 1; i < n - 1; i++) {
        const kappa = (pl.cx[i + 1] - 2 * pl.cx[i] + pl.cx[i - 1]) / (DZ * DZ);
        const v = (st[Math.min(st.length - 1, i0 + i)] || st[st.length - 1]).v;
        const sn = Math.max(-0.26, Math.min(0.26, (-0.6 * CENTRIFUGAL * v * v * Math.max(-KAPPA_MAX, Math.min(KAPPA_MAX, kappa))) / G)); // ≤15°, cancels ~60%
        pl.bank[i] += Math.asin(sn);
      }
    };
    // optional side ramp riding on an existing deck: rises from flush to H over [iA, iB]
    // samples, then ends in a lip (shape 'kick' launches up, 'flat' levels off to sail onto a roof)
    const ramp = (base, iA, iB, side, H, shape = 'kick', rhw = 1.2) => {
      const p = new Platform('ramp', base.z0 - iA * DZ); p.optional = true; p.openEnd = true; p.lip = true;
      p.wall = [];
      for (let i = iA; i <= iB; i++) {
        const k = (i - iA) / (iB - iA), h = shape === 'flat' ? H * smooth(k) : H * Math.pow(k, 1.6);
        p.push(base.cx[i] + side * Math.max(0, base.hw[i] - rhw), base.cy[i] + h, rhw, 0);
        p.wall.push(h + 0.05);
      }
      p.entrySlope = base.cy[iA] - base.cy[iA + 1];
      chunk.platforms.push(p);
      return p;
    };
    // ballistic flight off the lip onto a new lower platform B (optionally ending in its own lip)
    const fly = ({ drop, reach: f, hwB, lenB, lipLen = 0, offMax = 1.5, offset = null, kick = 6 }) => {
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
      c.cx += offset ?? r.range(-1, 1) * Math.min(offMax, VLAT * (landX / v) * 0.7 * 0.3);
      c.hw = hwB;
      const B = deck({ openStart: true });
      const landRun = Math.max(lenB, (landX - gapLen) + (lipLen ? 6 : 14));
      if (lipLen) lipRun(B, landRun + lipLen, hwB, kick);
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
        // boost pad on some straights (full width, so timing stays predictable)
        const padD = !o.breather && d >= 0.15 && r() < 0.35 ? r.range(12, len * 0.5) : -1;
        let padDone = false;
        this.run(chunk, p, len, (k, dist, L) => {
          const hit = !padDone && padD > 0 && dist >= padD;
          if (hit) { p.pads.push(c.z); padDone = true; }
          return { hw: ease(w0, w1, dist, L), boost: hit };
        });
        // optional side ramp, decided before obstacles so none spawn inside it
        let rampZone = null;
        if (!o.breather && r() < 0.4) {
          // runway after the lip: the whole flight (~1.3 s) plus a second to recentre before the deck changes
          const v = c.v + (c.boost || 0), need = Math.ceil((v * 2.3 + 15) / DZ), span = r.int(24, 36);
          if (p.cx.length > 20 + span + need) {
            const iA = r.int(20, p.cx.length - span - need), side = r.sign(), rp = ramp(p, iA, iA + span, side, r.range(1.6, 2.4));
            const hwR = p.hw[iA + span], uA = side > 0 ? hwR - 2.4 : -hwR, uB = side > 0 ? hwR : -hwR + 2.4;
            rampZone = { zA: rp.z0 + 1, zB: rp.z1 - 1, uA, uB };
            // something to jump: a low block in the ramp's lane, past the lip under its arc
            const zT = rp.z1 - r.range(10, Math.min(22, v * 0.4));
            if (zT > p.z1 + 5) chunk.obstacles.push(this.obst('block', p, zT, { u: side * (hwR - 1.2), w: 1.6, h: 1.1, d: 0.9 }));
          }
        }
        if (!o.breather) this.placeObstacles(chunk, p, d, null, 1, { avoid: rampZone ? [rampZone] : [] });
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
        const i0 = chunk.steps.length - 1;
        this.run(chunk, p, len, (k, dist, L) => ({
          hw: lerp(w0, hw1, smooth(dist / 6)),
          // eased so the section starts and ends pointing straight down the slope
          // (an angled join is a kink, and a kink reads as a huge sideways shove)
          cx: cx0 + (sCurve ? Aa * Math.sin(2 * Math.PI * k) * smooth(k * 5) * smooth((1 - k) * 5) : Aa * (1 - Math.cos(Math.PI * k)) / 2),
        }));
        autoBank(p, i0);
        break;
      }
      case 'winding': {
        // owner request (SPEC amendment A1): long sweeping S-bends that also roll up and
        // down. Rolls crest hard enough at speed to throw the ball into short hops.
        const len = r.range(120, 220), cycles = r() < 0.5 ? 1 : 2, lam = len / cycles;
        const Amax = Math.min(9, (lam * lam) / (25 * 4 * Math.PI * Math.PI)); // min radius 25 m
        const A = r.sign() * r.range(0.5, 1) * Math.min(Amax, 6), w0 = c.hw, hw1 = lerp(3.0, 2.2, d) * r.range(0.95, 1.05); // wider, gentler
        // vertical rolls twice per lateral cycle, phased so every crest sits on an
        // inflection of the bend: the ball only hops where the track runs straight
        // roll height sized to the predicted speed: crest curvature ≈ 1.5·G/v² gives a
        // short consistent hop (~0.2–0.3 s) instead of a long flight off a bending track
        const vc = 2 * cycles, kv = (2 * Math.PI * vc) / len;
        const H = Math.min(3, (r.range(1.3, 1.7) * G) / (c.v * c.v) / (kv * kv)), cx0 = c.cx;
        const p = deck(), i0w = chunk.steps.length - 1;
        this.run(chunk, p, len, (k, dist, L) => {
          const env = smooth(k * 6) * smooth((1 - k) * 6);
          return {
            hw: lerp(w0, hw1, smooth(dist / 10)),
            cx: cx0 + A * Math.sin(2 * Math.PI * cycles * k) * env,
            // no rolls: airborne on a bending strip = flying off it (hops live in 'coaster' instead)
          };
        });
        autoBank(p, i0w);
        this.run(chunk, p, 18, () => ({})); // flat run-out: land before the next section
        break;
      }
      case 'split': {
        // ease to full width, then two lanes over a void, then merge
        const pre = deck();
        const w0 = c.hw;
        this.run(chunk, pre, 22, (k, dist, L) => ({ hw: ease(w0, 3.5, dist, L) })); // time to pick a lane
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
        // sized to the predicted speed: airtime T = 2v(up + base)/G → ~0.8–1.1 s at any speed,
        // and the landing run-out covers the whole predicted flight (v·T) plus margin
        const w0 = c.hw, lead = r.range(20, 35), v = c.v + (c.boost || 0), T = r.range(0.8, 1.1);
        const up = Math.min(0.25, Math.max(0.05, (T * G) / (2 * v) - SLOPE_TAN));
        const flight = (2 * v * v * (up + SLOPE_TAN)) / G;
        const p = deck();
        this.run(chunk, p, lead + 6 + flight * 1.2 + 20, (k, dist, L) => ({ hw: ease(w0, 3.5, dist, L), slope: dist > lead && dist < lead + 6 ? -up : SLOPE_TAN }));
        // no obstacles: the flight path and landing stay clear
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
      case 'megajump': {
        // big launch ramp over a void onto a lower deck
        const A = deck();
        lipRun(A, r.range(30, 45), 3.5, r.range(16, 22));
        fly({ drop: r.range(5, 10), reach: r.range(0.55, 0.75), hwB: 3.5, lenB: 30 });
        break;
      }
      case 'stairs': {
        // full-width steps dropping away: a run of short hops
        const A = deck();
        lipRun(A, 14, 3.5, 2);
        const n = r.int(4, 7);
        for (let i = 0; i < n; i++) {
          const { B } = fly({ drop: r.range(1.2, 2.2), reach: r.range(0.3, 0.45), hwB: 3.5, lenB: 0, lipLen: i < n - 1 ? r.range(12, 18) : 0, kick: 2, offset: 0 });
          // a block mid-step on most steps (the validator still demands a way through)
          if (i > 0 && r() < 0.7) { const zm = (B.z0 + B.z1) / 2, w = r.range(1.2, 2.2); chunk.obstacles.push(this.obst('block', B, zm, { u: r.range(-3.5 + w / 2 + 0.2, 3.5 - w / 2 - 0.2), w, h: r.range(1, 1.8), d: 0.9 })); }
        }
        break;
      }
      case 'islands': {
        // island hop: short pads zig-zagging left and right; line up before each lip
        const A = deck();
        lipRun(A, 18, 2.6);
        const n = r.int(3, 5); let sd = r.sign();
        for (let i = 0; i < n; i++) {
          const last = i === n - 1;
          const { B } = fly({ drop: r.range(1.5, 2.5), reach: r.range(0.45, 0.6), hwB: last ? 3.5 : 1.9, lenB: last ? 20 : 0, lipLen: last ? 0 : r.range(16, 22), offset: last ? -c.cx * 0.5 : sd * r.range(1.6, 2.6) });
          if (!last && r() < 0.6) { const zm = (B.z0 + B.z1) / 2; chunk.obstacles.push(this.obst('block', B, zm, { u: r.sign() * 0.9, w: 1.0, h: 1.2, d: 0.9 })); }
          sd = -sd;
        }
        break;
      }
      case 'coaster': {
        // straight rollercoaster: several crests, each sized to throw a short hop
        const n = r.int(3, 5), lam = r.range(30, 45), len = n * lam, w0 = c.hw, kv = (2 * Math.PI) / lam;
        const H = Math.min(3, (r.range(1.4, 1.8) * G) / (c.v * c.v) / (kv * kv));
        const p = deck();
        this.run(chunk, p, len, (k, dist) => ({ hw: ease(w0, 3.5, dist, len), slope: this.baseSlope() + H * kv * Math.sin(kv * dist) * smooth(dist / lam) }));
        this.run(chunk, p, 15, () => ({}));
        break;
      }
      case 'corkscrew': {
        // the bank sweeps hard from one side to the other and back
        const len = r.range(70, 110), B = r.range(24, 34) * DEG, cyc = r() < 0.5 ? 1 : 1.5, w0 = c.hw;
        const p = deck();
        this.run(chunk, p, len, (k, dist, L) => ({ hw: ease(w0, 3.5, dist, L), bank: B * Math.sin(2 * Math.PI * cyc * k) * smooth(dist / 12) * smooth((L - dist) / 12) }));
        break;
      }
      case 'fork': {
        // the track forks into two wide lanes that drift apart and rejoin; one may hold a block
        const pre = deck(); const w0 = c.hw;
        this.run(chunk, pre, 8, (k, dist, L) => ({ hw: ease(w0, 3.5, dist, L) }));
        const len = r.range(50, 80), lhw = 1.8, cx = c.cx, spread = r.range(2, 4.5);
        const L = new Platform('lane', c.z), R2 = new Platform('lane', c.z);
        chunk.platforms.push(L, R2);
        L.entrySlope = R2.entrySlope = c.lastSlope;
        const nS = Math.round(len / DZ);
        for (let i = 0; i <= nS; i++) {
          const k = i / nS, off = 1.75 + spread * Math.sin(Math.PI * k);
          L.push(cx - off, c.cy, lhw, 0); R2.push(cx + off, c.cy, lhw, 0);
          if (i < nS) this.step(chunk, this.baseSlope());
        }
        if (d > 0.4) { const lane = r() < 0.5 ? L : R2; chunk.obstacles.push(this.obst('block', lane, L.z0 - len * r.range(0.35, 0.65), { u: 0, w: 1.6, h: 1.4, d: 0.9 })); }
        c.hw = 3.5;
        const post = deck();
        this.run(chunk, post, 10, () => ({ hw: 3.5 }));
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
        const withRoof = !rot && r() < 0.75;
        this.run(chunk, pre, withRoof ? 34 : 10, (k, dist, L) => ({ hw: ease(w0, 3.5, dist, L) }));
        // optional ramp up to the tunnel roof: ride the roof, or stay low and take the tunnel
        if (withRoof) ramp(pre, pre.cx.length - 46, pre.cx.length - 2, r.sign(), TUBE_H + 0.8, 'flat', 1.5);
        const len = r.range(40, 120);
        const p = deck({ tunnel: true, rot });
        // boost pads (A9): full-width, so every run takes them and timing stays predictable
        const padAt = d >= 0.15 && !rot ? [r.range(10, Math.max(12, len * 0.4))] : [];
        if (padAt.length && len > 60 && r() < 0.6) padAt.push(r.range(len * 0.6, len - 12));
        let pi = 0;
        this.run(chunk, p, len, (k, dist) => {
          const hit = pi < padAt.length && dist >= padAt[pi];
          if (hit) { p.pads.push(c.z); pi++; }
          return { hw: 3.5, boost: hit };
        });
        if (withRoof) {
          const roof = new Platform('roof', p.z0); roof.optional = true; roof.openStart = roof.openEnd = true; roof.wall = [];
          for (let i = 0; i < p.cx.length; i++) { roof.push(p.cx[i], p.cy[i] + TUBE_H + 0.05, p.hw[i], 0); roof.wall.push(0.3); }
          roof.entrySlope = p.cy[0] - p.cy[1];
          chunk.platforms.push(roof);
          // red blocks + sliders up on the roof too (doesn't disturb deck obstacle spacing)
          const keep = c.lastObsT; c.lastObsT = -1e9;
          this.placeObstacles(chunk, roof, Math.max(d, 0.3), ['block', 'slider'], 1.2);
          c.lastObsT = keep;
          // landing runout: rolling off the roof end drops TUBE_H; land on deck, not in whatever comes next
          const v = c.v + (c.boost || 0), drop = (v * Math.sqrt((2 * (TUBE_H + 1)) / G)) * 1.3 + 15;
          const out = deck();
          this.run(chunk, out, drop, () => ({ hw: 3.5 }));
        }
        const kinds = ['block', 'slider'];
        if (d >= 0.6) kinds.push('fin', 'rotor');
        if (d >= 0.3) this.placeObstacles(chunk, p, d, kinds, rot ? 1.3 : 1);
        break;
      }
    }
    chunk.zEnd = c.z;
    return chunk;
  }

  obst(type, pl, z, extra) {
    return { type, pl, z, u: 0, w: 1, h: 1, d: 1, omega: 0, phase: 0, ...extra };
  }

  placeObstacles(chunk, pl, d, kinds = null, spacingMul = 1, { avoid = [], postLand = 1.2 } = {}) {
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
    if (pl.openStart) t = Math.max(t, tStart + postLand); // no obstacle right after a landing
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
          case 'lasers': o.n = Math.max(2, Math.round(hw * 0.8)); o.omega = (2 * Math.PI) / r.range(1.6, 2.6); o.phase = r.range(0, 6.28); o.offs = Array.from({ length: o.n }, (_, i) => i * r.range(0.6, 1.4)); break;
          case 'crusher': o.side = r.sign(); o.omega = (2 * Math.PI) / r.range(1.6, 2.6); o.phase = r.range(0, 6.28); break;
          case 'sweeper': o.side = r.sign(); o.omega = (2 * Math.PI) / r.range(2, 3.4); o.phase = r.range(0, 6.28); break;
          case 'zipper': o.w = r.range(1.2, 2); o.h = r.range(1, 1.8); o.u = r.range(-hw + o.w / 2, hw - o.w / 2); o.amp = r.range(1.5, 3); o.omega = (2 * Math.PI) / r.range(1.2, 2.2); o.phase = r.range(0, 6.28); break;
          case 'orbiters': o.u = r.range(-0.6, 0.6) * hw; o.rad = Math.min(1.6, hw * 0.5); o.omega = r.sign() * (2 * Math.PI) / r.range(1.6, 2.8); o.phase = r.range(0, 6.28); break;
          case 'wave': o.n = Math.max(4, Math.round(hw * 2)); o.k = r.range(0.5, 0.9); o.omega = (2 * Math.PI) / r.range(1.8, 2.8); o.phase = r.range(0, 6.28); break;
          case 'slalom': o.u = r.sign() * Math.max(0.5, hw * 0.45); o.gapZ = r.range(5, 9); break;
          case 'twinrotor': o.rate = r.range(50, 90) * DEG; o.phase = r.range(0, 6.28); break;
          case 'pistons': o.omega = (2 * Math.PI) / r.range(1.8, 3.0); o.phase = r.range(0, 6.28); o.offs = [0, r.range(1.5, 2.6), r.range(3.2, 4.6)]; break;
          case 'pendulum': o.w = r.range(1.2, 1.8); o.h = 1.4; o.d = 0.9; o.amp = Math.max(0.3, hw - o.w / 2); o.omega = (2 * Math.PI) / r.range(2, 4); o.phase = r.range(0, 6.28); break;
          case 'rotor': o.len = hw * 2 * 0.8; o.rate = r.sign() * r.range(40, 90) * DEG; o.phase = r.range(0, 6.28); o.u = 0; break;
          case 'fin': o.side = r.sign(); o.len = r.range(1.5, 2.5); o.h = r() < 0.5 ? TUBE_H : 2.2; break;
        }
        // never inside a ramp: skip candidates whose footprint overlaps an avoid zone
        const span = o.type === 'block' || o.type === 'zipper' ? [o.u - o.w / 2, o.u + o.w / 2] : [-hw, hw];
        const blocked = avoid.some((a) => z <= a.zA + 2 && z >= a.zB - 2 && span[1] > a.uA - 0.3 && span[0] < a.uB + 0.3);
        if (!blocked) { chunk.obstacles.push(o); cur.lastObsT = t; }
      }
      t += gapT();
    }
  }

  pickWeighted(list) {
    // rare obstacles are occasional curveballs; the common set does most of the work
    const r = this.rng, w = (o) => (RARE_OBSTACLES.has(o.id) ? o.w * 0.2 : o.w);
    let s = list.reduce((a, b) => a + w(b), 0), x = r() * s;
    for (const o of list) { x -= w(o); if (x <= 0) return o.id; }
    return list[0].id;
  }

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
      for (const pl of chunk.platforms) if (!pl.optional && st.z <= pl.z0 + 1e-6 && st.z >= pl.z1 - 1e-6) { pl0 = pl; break; }
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
        if (pl.optional || st.z > pl.z0 + 1e-6 || st.z < pl.z1 - 1e-6) continue;
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
      // optional ramps: once they rise above step height their sides are solid walls
      for (const pl of chunk.platforms) {
        if (pl.kind !== 'ramp' || st.z > pl.z0 || st.z < pl.z1) continue;
        const i = Math.min(pl.wall.length - 1, Math.max(0, Math.round((pl.z0 - st.z) / DZ)));
        if (pl.wall[i] < 0.35) continue;
        pl.sample(st.z, s);
        const lo = s.cx - s.hw - BALL_R - MARGIN, hi = s.cx + s.hw + BALL_R + MARGIN;
        for (let k = Math.max(0, Math.ceil((lo - GX0) / GDX)); k <= Math.min(GN - 1, Math.floor((hi - GX0) / GDX)); k++) safe[k] = 0;
      }
      // obstacles near this z, at the predicted arrival time ± 0.15 s
      for (const o of chunk.obstacles) {
        if (Math.abs(o.z - st.z) > 12) continue;
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

  // did the ball run into the side of a raised ramp (rather than rolling onto it)?
  hitRampSide(x, y, z, onPl, grounded) {
    const s = this._s;
    for (const c of this.chunks) {
      if (z > c.zStart + 1 || z < c.zEnd - 1) continue;
      for (const pl of c.platforms) {
        if (pl.kind !== 'ramp' || pl === onPl || z > pl.z0 || z < pl.z1) continue;
        pl.sample(z, s);
        // rolling along the deck: touching the side counts; airborne (e.g. dropping off a
        // ramp edge) only counts if the ball is well inside the ramp body
        if (Math.abs(x - s.cx) > (grounded ? s.hw : s.hw - 0.25)) continue;
        if (s.cy > y - BALL_R + 0.35) return true; // ramp top well above the ball's underside
      }
    }
    return false;
  }

  hitObstacle(x, y, z, r, t) {
    const boxes = this._boxes;
    for (const c of this.chunks) {
      if (z > c.zStart + 4 || z < c.zEnd - 4) continue;
      for (const o of c.obstacles) {
        if (Math.abs(o.z - z) > 12) continue;
        const n = obstacleBoxes(o, t, boxes);
        for (let i = 0; i < n; i++) if (!boxes[i].ghost && sphereHitsBox(x, y, z, r, boxes[i])) return o;
      }
    }
    return false;
  }
}
