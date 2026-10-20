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
const LOOKAHEAD = 260, BEHIND = 40;

// validator lateral grid
const GX0 = -26, GDX = 0.05, GN = 1041;

// deck curving downward (slope steepening by dSlope over ds metres) faster than
// gravity can pull the ball along it → the ball leaves the surface
export function crestLaunch(v, slopeBefore, slopeAfter, ds) { return (v * v * (slopeAfter - slopeBefore)) / ds > G; }

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
  const pl = o.pl, s = pl.sample(o.z, o._s || (o._s = {}));
  const hc = pl.pivot, th = s.bank + pl.rollAt(t);
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
  { id: 'rottunnel', d: 0.75, w: 1.2 },
];
const OBSTACLES = [
  { id: 'block', d: 0, w: 3 }, { id: 'wall', d: 0.1, w: 2 }, { id: 'slider', d: 0.3, w: 2 },
  { id: 'gate', d: 0.45, w: 1.5 }, { id: 'pendulum', d: 0.6, w: 1.3 }, { id: 'rotor', d: 0.6, w: 1.2 },
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
  step(chunk, slopeTan, air = false) {
    const c = this.cur;
    const dt = DZ / c.v;
    // crests: where the deck falls away faster than gravity can follow, the ball
    // flies (same rule as Ball.step), so those steps are airborne for the validator
    let flying = false;
    if (!air) {
      const deckNext = c.cy - DZ * slopeTan;
      if (c.fly) {
        c.bvy -= G * dt; c.by += c.bvy * dt;
        if (c.by <= deckNext) c.fly = false; else flying = true;
      } else if (c.lastSlope !== undefined && crestLaunch(c.v, c.lastSlope, slopeTan, DZ)) {
        c.bvy = -c.lastSlope * c.v; c.by = c.cy + c.bvy * dt - 0.5 * G * dt * dt;
        c.fly = flying = c.by > deckNext;
      }
      c.lastSlope = slopeTan;
    }
    // the ball spawns at z = 0 with V_MIN: no acceleration on the runway behind the spawn
    if (!air && !flying && c.z <= 0) c.v = Math.max(V_MIN, Math.min(V_MAX, c.v + accelAt(c.v, slopeTan) * dt));
    c.t += dt; c.z -= DZ;
    if (!air) c.cy -= DZ * slopeTan;
    chunk.steps.push({ z: c.z, t: c.t, v: c.v, air: air || flying, cy: c.cy });
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
      if (i < n) this.step(chunk, s.slope ?? this.baseSlope());
    }
    return pl;
  }

  build(type, o = {}) {
    const r = this.rng, c = this.cur, d = o.d ?? this.difficulty(c.z);
    const chunk = this.newChunk(type, d);
    const ease = (from, to, dist, len) => lerp(from, to, smooth(dist / Math.min(8, len)));
    const deck = (opts) => { const p = new Platform('deck', c.z, opts); chunk.platforms.push(p); return p; };

    switch (type) {
      case 'straight': {
        const len = o.len ?? (o.breather ? Math.max(c.v * 1.6, 30) : r.range(Math.max(40, c.v * 2), Math.max(70, c.v * 3.5)));
        const w0 = c.hw, w1 = 3.5;
        const p = deck();
        this.run(chunk, p, len, (k, dist, L) => ({ hw: ease(w0, w1, dist, L) }));
        if (!o.breather) this.placeObstacles(chunk, p, d);
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
        const len = r.range(40, 80), B = r.sign() * r.range(8, 8 + 14 * (0.5 + 0.5 * d)) * DEG, w0 = c.hw;
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
        const len = r.range(50, 90), hw1 = lerp(1.25, 0.8, d), w0 = c.hw, cx0 = c.cx;
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
        if (d >= 0.55) this.placeObstacles(chunk, p, d, ['block'], 1.6);
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
        // take-off platform with a +6° lip
        const w0 = c.hw, lenA = r.range(18, 30);
        const A = deck();
        const lipTan = Math.tan(Math.atan(SLOPE_TAN) - 6 * DEG);
        this.run(chunk, A, lenA, (k, dist, L) => ({ hw: ease(w0, 3.5, dist, L), slope: dist > L - 4 ? lipTan : undefined }));
        A.lip = true; A.openEnd = true;
        // ballistic flight at the predicted take-off speed
        const v = c.v, th = Math.atan(lipTan); // lip direction: descending at θ below horizontal
        const drop = r.range(2, lerp(6, 10, d));
        const vy0 = -v * Math.sin(th) / Math.cos(th); // vertical speed when moving v horizontally along the lip
        // reach: horizontal distance until the ball has fallen `drop`
        const tReach = (vy0 + Math.sqrt(vy0 * vy0 + 2 * G * drop)) / G;
        const reach = v * tReach;
        const f = lerp(0.45, 0.8, d) * r.range(0.9, 1);
        const gapLen = Math.max(3, f * reach);
        // B surface starts at lip − drop and descends at base slope; find landing
        const yLip = c.cy, zLip = c.z;
        let x = 0, tf = 0;
        for (; tf < 4; tf += 0.002) {
          x = v * tf;
          const yb = yLip + vy0 * tf - 0.5 * G * tf * tf;
          const ys = x < gapLen ? -1e9 : yLip - drop - (x - gapLen) * SLOPE_TAN;
          if (yb <= ys) break;
        }
        const landX = x;
        // air steps (no speed change in flight), B begins at gapLen
        const nAir = Math.round(gapLen / DZ);
        const cyAir0 = c.cy;
        for (let i = 0; i < nAir; i++) { this.step(chunk, 0, true); chunk.steps[chunk.steps.length - 1].cy = lerp(cyAir0, yLip - drop, (i + 1) / nAir); }
        c.cy = yLip - drop;
        c.lastSlope = undefined; c.fly = false;
        // landing platform: offset reachable within frozen lateral speed
        const air = landX / v;
        const off = r.range(-1, 1) * Math.min(1.5, VLAT * air * 0.7 * 0.3);
        c.cx += off;
        const B = deck({ openStart: true });
        const landZ = zLip - landX;
        const lenB = Math.max(r.range(25, 40), (landX - gapLen) + 14);
        const wB = lerp(3.5, 1.25, d * r());
        this.run(chunk, B, lenB, () => ({ hw: wB }));
        if (d >= 0.35) this.placeObstacles(chunk, B, d, ['block', 'wall', 'slider']);
        // mark: steps between B start and touchdown are still airborne
        for (const s of chunk.steps) if (s.z < zLip - gapLen + 1e-6 && s.z > landZ) s.air = true;
        chunk.landZ = landZ;
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
        this.run(chunk, p, len, () => ({ hw: 3.5 }));
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
        pl0.sample(st.z, s); pl0.bend(st.z, bd); head = bd.dcx;
        const th = s.bank + pl0.rollAt(st.t);
        const a = -CENTRIFUGAL * st.v * st.v * bd.kappa - G * Math.sin(th);
        const dt = DZ / st.v;
        const shift = prevCx === null ? 0 : s.cx - prevCx;
        lo = ((a - STEER_FRAC * STEER_ACC) / STEER_DAMP) * dt + shift;
        hi = ((a + STEER_FRAC * STEER_ACC) / STEER_DAMP) * dt + shift;
        prevCx = s.cx;
      } else if (pl0) { pl0.sample(st.z, s); prevCx = s.cx; }
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
        pl.sample(st.z, s);
        let lo = -1e9, hi = 1e9;
        for (const dt of [-0.15, 0, 0.15]) {
          const th = s.bank + pl.rollAt(st.t + dt);
          const lim = (pl.tunnel ? s.hw - BALL_R : s.hw) - MARGIN;
          const x0 = s.cx + Math.cos(th) * -lim + pl.pivot * Math.sin(th), x1 = s.cx + Math.cos(th) * lim + pl.pivot * Math.sin(th);
          lo = Math.max(lo, x0); hi = Math.min(hi, x1);
        }
        for (let i = Math.max(0, Math.ceil((lo - GX0) / GDX)); i <= Math.min(GN - 1, Math.floor((hi - GX0) / GDX)); i++) safe[i] = 1;
      }
      // obstacles near this z, at the predicted arrival time ± 0.15 s
      for (const o of chunk.obstacles) {
        if (Math.abs(o.z - st.z) > 3.5) continue;
        const pl = o.pl; pl.sample(st.z, s);
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
              const th = s.bank + pl.rollAt(st.t + dt);
              const u = uFromX(x, s.cx, pl.pivot, th);
              const [, yd] = deckPoint(s.cx, s.cy, pl.pivot, u, th);
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
    const s = this._s;
    for (const c of this.chunks) {
      if (z > c.zStart + 1 || z < c.zEnd - 1) continue;
      for (const pl of c.platforms) {
        if (z > pl.z0 || z < pl.z1) continue;
        pl.sample(z, s);
        const th = s.bank + pl.rollAt(t);
        const u = uFromX(x, s.cx, pl.pivot, th);
        if (Math.abs(u) > s.hw + BALL_R * 0.2) continue;
        const [, y] = deckPoint(s.cx, s.cy, pl.pivot, u, th);
        if (y > refY + 0.8) continue;
        if (y > bestY) { bestY = y; best = pl; out.y = y; out.u = u; out.hw = s.hw; out.theta = th; out.cx = s.cx; out.cy = s.cy; }
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
