// Fairness harness: a model-predictive autopilot that clones the real ball and
// plays candidate input sequences through the actual game physics (no renderer).
//   npm run test:fairness -- [seeds=20] [seconds=120]
// A run that dies means the autopilot could not find a line; replay a seed with
// DEEP=1 for a longer search before blaming the course.
import * as THREE from 'three';
import { Course } from '../src/game/course.js';
import { Ball } from '../src/world/ball.js';
import { createShared } from '../src/world/shared.js';
import { Wind } from '../src/world/wind.js';

globalThis.addEventListener ??= () => {};
const shared = createShared(new Wind());
const STEP = 1 / 120, SEGS = [-1, 0, 1], DEEP = !!process.env.DEEP;
const F = ['x', 'y', 'z', 'u', 'vu', 'speed', 'boost', 'vx', 'vy', 'grounded', 'pl', 'dead', 'deathCause', 'runTime', 'dist', 'bank'];
const plans = [];
for (const a of SEGS) for (const b of SEGS) for (const c of SEGS) { if (DEEP) for (const d of SEGS) plans.push([a, b, c, d]); else plans.push([a, b, c]); }
const [segT, horizon] = DEEP ? [0.25, 2.0] : [0.3, 1.5];

function rollout(sim, real, plan) {
  for (const f of F) sim[f] = real[f];
  let t = 0;
  for (let i = 0, n = Math.round(horizon / STEP); i < n; i++) {
    const seg = Math.min(plan.length - 1, Math.floor(t / segT));
    sim.keys.clear(); if (plan[seg] < 0) sim.keys.add('ArrowLeft'); else if (plan[seg] > 0) sim.keys.add('ArrowRight');
    sim.step(STEP, false); t += STEP;
    if (sim.dead) return t;
    if (!sim.grounded && sim.y < sim.course.centreAt(sim.z, {}).cy - 1.5) return t + 0.2; // fall in progress
  }
  return horizon + 1 - Math.min(1, Math.abs(sim.u) / 4);
}

const N = Number(process.argv[2] || 20), LIMIT = Number(process.argv[3] || 120), ONLY = process.env.SEED ? parseInt(process.env.SEED, 16) : null;
const rows = [];
for (let k = 1; k <= (ONLY ? 1 : N); k++) {
  const seed = ONLY ?? ((k * 2654435761) >>> 0);
  const course = new Course(); course.reset(seed);
  const ball = new Ball(new THREE.Scene(), shared, course), sim = new Ball(new THREE.Scene(), shared, course);
  sim.isSim = true;
  let t = 0, acc = 1, plan = [0];
  while (t < LIMIT && !ball.dead) {
    if ((acc += STEP) >= 1 / 15) { acc = 0; let best = -1; for (const p of plans) { const sc = rollout(sim, ball, p); if (sc > best) { best = sc; plan = p; } } }
    ball.keys.clear(); if (plan[0] < 0) ball.keys.add('ArrowLeft'); else if (plan[0] > 0) ball.keys.add('ArrowRight');
    ball.step(STEP, false); course.fill(ball.z, 1); t += STEP;
  }
  const r = { seed: seed.toString(16).padStart(8, '0'), dist: Math.round(ball.dist), t: +t.toFixed(1), difficulty: +course.difficulty(ball.z).toFixed(2),
    result: ball.dead ? `died (${ball.deathCause})` : 'survived', rejected: course.stats.rejected, fallbacks: course.stats.fallbacks };
  rows.push(r); console.log(JSON.stringify(r));
}
console.log(`survived ${LIMIT}s: ${rows.filter((r) => r.result === 'survived').length}/${rows.length}`);
