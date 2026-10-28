import * as THREE from 'three';
import { Ball } from '../world/ball.js';

// Model-predictive autopilot (title-screen demo + Autoplay mode). It clones the
// real ball into a private sim ball and plays candidate input sequences through
// the actual game physics, then follows the one that survives longest and stays
// nearest the deck centre. A full plan (27 rollouts) costs ~1 ms, so think() plans
// in one go ~15×/s; spreading it over frames made the plans stale and the bot worse.
const SEGS = [-1, 0, 1];
const PLANS = [];
for (const a of SEGS) for (const b of SEGS) for (const c of SEGS) PLANS.push([a, b, c]);
const SEG_T = 0.3, HORIZON = 1.5, SIM_DT = 1 / 120;
const FIELDS = ['x', 'y', 'z', 'u', 'vu', 'speed', 'boost', 'vx', 'vy', 'grounded', 'pl', 'dead', 'deathCause', 'runTime', 'dist', 'bank', 'airHead', 'airIn'];

export class Autopilot {
  constructor(shared, course) {
    this.course = course;
    this.sim = new Ball(new THREE.Scene(), shared, course); // never rendered
    this.sim.mesh.visible = false;
    this.sim.isSim = true;
    this.snap = {};
    this.plan = [0]; this.planT = 0;
    this.next = 0; this.best = -1; this.bestPlan = PLANS[13];
    this.cooldown = 0;
  }

  reset() { this.plan = [0]; this.planT = 0; this.next = 0; this.best = -1; this.cooldown = 0; }

  rollout(plan) {
    const sim = this.sim, C = this.course;
    for (const f of FIELDS) sim[f] = this.snap[f];
    let t = 0;
    for (let i = 0, n = Math.round(HORIZON / SIM_DT); i < n; i++) {
      const seg = Math.min(plan.length - 1, Math.floor(t / SEG_T));
      sim.keys.clear();
      if (plan[seg] < 0) sim.keys.add('ArrowLeft'); else if (plan[seg] > 0) sim.keys.add('ArrowRight');
      sim.step(SIM_DT, false); t += SIM_DT;
      if (sim.dead) return t;
      if (!sim.grounded && sim.y < C.centreAt(sim.z, {}).cy - 1.5) return t + 0.2; // a fall in progress
    }
    return HORIZON + 1 - Math.min(1, Math.abs(sim.u) / 4);
  }

  // called once per rendered frame; evaluates `budget` candidate plans
  think(ball, dt, budget = PLANS.length) {
    this.cooldown -= dt;
    if (this.next === 0) {
      if (this.cooldown > 0) return;
      for (const f of FIELDS) this.snap[f] = ball[f];
      this.snapTime = ball.runTime; this.best = -1;
    }
    for (let k = 0; k < budget && this.next < PLANS.length; k++, this.next++) {
      const sc = this.rollout(PLANS[this.next]);
      if (sc > this.best) { this.best = sc; this.bestPlan = PLANS[this.next]; }
    }
    if (this.next >= PLANS.length) { this.plan = this.bestPlan; this.planT = this.snapTime; this.next = 0; this.cooldown = 0.08; }
  }

  // called every physics step before ball.step
  drive(ball) {
    ball.keys.clear();
    const seg = Math.min(this.plan.length - 1, Math.max(0, Math.floor((ball.runTime - this.planT) / SEG_T)));
    const a = this.plan[seg];
    if (a < 0) ball.keys.add('ArrowLeft'); else if (a > 0) ball.keys.add('ArrowRight');
  }
}
