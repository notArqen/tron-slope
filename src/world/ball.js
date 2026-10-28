import * as THREE from 'three';
import { worldMaterial } from './shared.js';
import { BALL_R, G, STEER_ACC, STEER_DAMP, V_MIN, V_MAX, CENTRIFUGAL, accelAt, vmaxAt, crestLaunch, BOOST_ADD, BOOST_KEEP, BOOST_TAU, PIPE_F, PIPE_R, PIPE_LAUNCH } from '../game/course.js';

export { BALL_R };

const VS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vObj;
void main(){
  vObj = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz; vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FS = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW; varying vec3 vObj;
float ang(float a, float k){ return abs(fract(a * k / 6.2831853 + 0.5) - 0.5); }
void main(){
  vec3 n = normalize(vNormalW); vec3 o = normalize(vObj);
  float lon = atan(o.z, o.x);
  float lat = asin(clamp(o.y, -1.0, 1.0));
  float wl = fwidth(lon) * 1.2 + 0.004, wa = fwidth(lat) * 1.2 + 0.004;
  float dm = ang(lon, 4.0) * 1.5707963 * cos(lat);
  float mer = 1.0 - smoothstep(0.035, 0.035 + wl, dm);
  float par = 1.0 - smoothstep(0.02, 0.02 + wa, min(abs(lat), abs(abs(lat) - 0.62)));
  float seam = max(mer, par);
  vec3 V = normalize(uCamPos - vWorld);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  vec3 body = vec3(0.004, 0.012, 0.006) * (0.4 + poolLight(vWorld, n) * 0.6);
  vec3 col = body + uNeon * (seam * 4.0 + fres * 0.9);
  writeGBuffer(col, 0.1, (viewMatrix * vec4(n, 0.0)).xyz, max(seam, fres * 0.5));
}`;

// Player ball. Fixed-timestep physics against the streamed course (SPEC §1, §2, §5, §9).
// Grounded: state lives in deck space (u across the deck), so the ball follows the
// deck heading, feels partial centrifugal + bank pull, and can only steer here.
// Airborne: plain ballistic flight; lateral velocity is frozen (no air control).
export class Ball {
  constructor(scene, shared, course) {
    this.course = course;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 48, 32), worldMaterial({ uniforms: { ...shared }, vertexShader: VS, fragmentShader: FS }));
    scene.add(this.mesh);
    this.keys = new Set();
    addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('#overlay, #summary input')) return;
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    this.srf = {}; this.ctr = {}; this.bd = {}; this.s = {};
    this.reset();
  }

  reset() {
    // drop any held steering: the title-screen autopilot injects synthetic key presses
    // that never get a keyup, so a fresh run would otherwise inherit a stuck ← or →
    this.keys.clear();
    this.x = 0; this.z = 0; this.u = 0; this.vu = 0;
    this.speed = V_MIN; this.minSpeed = V_MIN; this.maxSpeed = V_MAX; this.boost = 0; this.airT = 0;
    this.vx = 0; this.vy = 0;
    this.grounded = true; this.pl = null;
    this.dead = false; this.deathCause = null; this.hitObj = null;
    this.dist = 0; this.runTime = 0;
    this.input = 0;
    this.q = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.bank = 0;
    const s = this.course.surfaceAt(0, 0, 0, 100, this.srf);
    this.pl = s ? s.pl : null;
    this.y = (s ? s.y : 0) + BALL_R;
  }

  get falling() { return !this.grounded; }
  get vt() { return this.speed + this.boost; }   // forward speed incl. boost surge
  get speedN() { return Math.min(1.3, (this.vt - this.minSpeed) / (this.maxSpeed - this.minSpeed)); }

  kill(cause) { if (!this.dead) { this.dead = true; this.deathCause = cause; } }

  step(dt, godMode) {
    if (this.dead) return;
    const k = this.keys, C = this.course;
    const t = C.clockAt(this.z); // course clock (see Course.clockAt)
    this.input = (k.has('ArrowLeft') || k.has('KeyA') ? -1 : 0) + (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0);
    this.runTime += dt;
    const px = this.x, py = this.y, pz = this.z;

    if (this.grounded) {
      const pl = this.pl, g = pl.geo(this.z, t, this.s), P = this.P || (this.P = {});
      pl.bend(this.z, this.bd);
      this.bank = g.th;
      pl.point(this.u, g, P);
      const vt = this.vt;
      // drift (Shift / ↓ / S, grounded only): brakes hard toward ~70% speed, and the slower it gets the tighter it turns
      this.drifting = !this.isSim && (k.has('ShiftLeft') || k.has('ShiftRight') || k.has('ArrowDown') || k.has('KeyS'));
      if (this.drifting) { if (!this.driftFrom) this.driftFrom = this.speed; this.speed = Math.max(this.driftFrom * 0.7, this.speed - 28 * dt); }
      else this.driftFrom = 0;
      const grip = this.drifting ? 1.8 + 4 * (1 - this.speed / this.driftFrom) : 1; // up to ~3×
      const a = this.input * STEER_ACC * grip - CENTRIFUGAL * vt * vt * this.bd.kappa + P.pull + pl.jetAt(this.z);
      this.vu += a * dt; this.vu *= Math.exp(-STEER_DAMP * (pl.pipe && Math.abs(this.u) > PIPE_F ? 0.35 : 1) * (this.drifting ? 0.6 : 1) * dt);
      const pu = this.u;
      this.u += this.vu * dt;
      // deck slope behind and ahead (probes continue past platform ends)
      const hB = pl.heightAt(this.z + 1), h0 = pl.heightAt(this.z), hF = pl.heightAt(this.z - 1);
      const slopeTan = hB - h0, slopeAhead = h0 - hF;
      const vmax = vmaxAt(this.z);
      if (!this.drifting) this.speed = Math.max(V_MIN, Math.min(vmax, this.speed + accelAt(this.speed, slopeTan, vmax) * dt));
      // boost pads: surge that decays + small permanent gain (Course.step mirrors this)
      const nz = this.z - vt * dt;
      for (const pz of pl.pads) if (this.z > pz && nz <= pz) { this.speed = Math.min(vmaxAt(this.z), this.speed + BOOST_KEEP); this.boost += BOOST_ADD; this.boosted = 0.6; }
      this.z = nz;
      this.dist += vt * dt;

      // continue onto the next platform when this one ends (or a blink tile switches off);
      // only onto a surface at about the same height, so a ramp end launches you
      let cur = pl;
      if (this.z < pl.z1 || !pl.solidAt(t)) {
        const n = this.z < pl.z1 ? C.surfaceAt(P.x, this.z, t, P.y + 0.3, this.srf) : null;
        if (n && Math.abs(n.y - P.y) < 0.6) { cur = n.pl; this.pl = cur; this.u = n.u; } else cur = null;
      } else {
        // step up onto a surface that starts flush with this one (rolling onto a ramp)
        const up = C.surfaceAt(P.x, this.z, t, P.y + 0.3, this.srf);
        if (up && up.pl !== pl && up.y > P.y + 0.002 && up.y < P.y + 0.3) { cur = up.pl; this.pl = cur; this.u = up.u; }
      }
      // crest: the deck drops away faster than gravity → fly (lateral speed freezes)
      const crest = cur && !cur.tunnel && crestLaunch(this.vt, slopeTan, slopeAhead, 1);
      // half-pipe lip: riding up past the top of a wall launches the ball straight up
      const pipeLaunch = cur && cur.pipe && Math.abs(this.u) - PIPE_F > PIPE_R * PIPE_LAUNCH && this.u * this.vu > 0;
      const g2 = cur ? cur.geo(this.z, t, this.s) : null;
      if (cur && !crest && !pipeLaunch && Math.abs(this.u) <= g2.hw + BALL_R * 0.2) {
        cur.point(this.u, g2, P);
        // sit on the surface along its normal (matters on half-pipe walls)
        const nlen = Math.hypot(P.slope, 1);
        this.x = P.x - (P.slope / nlen) * BALL_R * (cur.pipe ? 1 : 0); this.y = P.y + BALL_R / (cur.pipe ? nlen : 1);
        if (cur.tunnel && Math.abs(this.u) > g2.hw - BALL_R) {
          // normal tunnels: solid walls you can ride along; red tunnels: touching the wall kills
          if (cur.deadly && !godMode) this.kill('wall');
          else { this.u = Math.sign(this.u) * (g2.hw - BALL_R); if (this.u * this.vu > 0) this.vu = 0; }
        }
      } else {
        // leave the deck: off the side, off a lip, over a crest, out of a pipe, or a tile vanished
        cur && cur.bend(this.z, this.bd);
        const head = this.vt * (this.bd.dcx || 0);
        this.airHead = head;
        if (pipeLaunch) { this.vy = Math.abs(this.vu) * 0.95; this.vx = head; this.u = pu; }
        // hands off the keys = you fly straight: leftover sideways slip (bank pull, jets, curve) isn't carried into the jump
        else { this.vx = (this.input ? this.vu * Math.cos(g.th) : 0) + head; this.vy = -slopeTan * this.vt; }
        this.x = P.x;
        this.y = py + this.vy * dt;
        this.grounded = false; this.pl = null;
      }
    } else {
      this.vy -= G * dt;
      // weak, floaty air control: ~10% of ground steering, lagged so it feels vague
      this.airIn = (this.airIn || 0) + (this.input - (this.airIn || 0)) * Math.min(1, dt * 4);
      // air control scales with speed: barely any when slow, up to ~35% of ground steering when fast
      this.vx += this.airIn * STEER_ACC * (0.06 + 0.29 * Math.min(1, this.speedN)) * dt;
      // no input: sideways drift dies away so a straight jump stays straight
      if (!this.input) { this.airIn *= Math.exp(-dt * 10); this.vx += ((this.airHead || 0) - this.vx) * (1 - Math.exp(-dt * 3)); }
      this.y += this.vy * dt;
      this.x += this.vx * dt;
      this.airT += dt;
      this.z -= this.vt * dt;
      this.dist += this.vt * dt;
      const srf = C.surfaceAt(this.x, this.z, C.clockAt(this.z), this.y, this.srf);
      if (srf && this.y - BALL_R <= srf.y + 0.05 && py - BALL_R >= srf.y - 0.6) {
        if (!this.isSim) this.landed = Math.max(this.landed || 0, Math.min(1, (-this.vy - 4) / 16)); // landing impact 0..1 (feel)
        this.airT = 0;
        this.grounded = true; this.pl = srf.pl; this.u = srf.u;
        // world lateral velocity → deck-relative: remove the deck's own heading, or every
        // hop on a curve would add speed·heading to the sideways speed and fling the ball off
        srf.pl.bend(this.z, this.bd);
        this.vu = (this.vx - this.vt * this.bd.dcx) * Math.cos(srf.theta); this.vy = 0;
        this.y = srf.y + BALL_R;
      } else {
        const floor = C.centreAt(this.z, this.ctr).cy - 9;
        if (this.y < floor) {
          if (godMode) this.respawnOnDeck(); else this.kill('fell');
        }
      }
    }

    if (this.boost) { this.boost *= Math.exp(-dt / BOOST_TAU); if (this.boost < 0.05) this.boost = 0; }
    if (this.boosted) this.boosted = Math.max(0, this.boosted - dt);
    if (!this.dead && !godMode) {
      const tc = C.clockAt(this.z), hit = C.hitObstacle(this.x, this.y, this.z, BALL_R * 0.95, tc);
      if (hit || C.hitRampSide(this.x, this.y, this.z, this.pl, this.grounded)) { this.hitObj = hit || null; this.kill('hit'); }
    }

    // rolling: rotate about the axis perpendicular to world motion
    this.vel.set((this.x - px) / dt, (this.y - py) / dt, (this.z - pz) / dt);
    const v = this.vel.length();
    if (v > 1e-3) {
      const axis = new THREE.Vector3(0, 1, 0).cross(this.vel).normalize();
      this.q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, (v * dt) / BALL_R));
    }
  }

  respawnOnDeck() {
    const c = this.course.centreAt(this.z, this.ctr);
    const s = this.course.surfaceAt(c.cx, this.z, this.course.clockAt(this.z), 1e6, this.srf);
    if (s) { this.grounded = true; this.pl = s.pl; this.u = 0; this.vu = 0; this.vy = 0; this.y = s.y + BALL_R; this.x = c.cx; }
  }

  sync() {
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.quaternion.copy(this.q);
  }
}
