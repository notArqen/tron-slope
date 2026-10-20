import * as THREE from 'three';
import { worldMaterial } from './shared.js';
import { BALL_R, G, STEER_ACC, STEER_DAMP, V_MIN, V_MAX, CENTRIFUGAL, accelAt, deckPoint } from '../game/course.js';

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
    this.x = 0; this.z = 0; this.u = 0; this.vu = 0;
    this.speed = V_MIN; this.minSpeed = V_MIN; this.maxSpeed = V_MAX;
    this.vx = 0; this.vy = 0;
    this.grounded = true; this.pl = null;
    this.dead = false; this.deathCause = null;
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
  get speedN() { return (this.speed - this.minSpeed) / (this.maxSpeed - this.minSpeed); }

  kill(cause) { if (!this.dead) { this.dead = true; this.deathCause = cause; } }

  step(dt, godMode) {
    if (this.dead) return;
    const k = this.keys, C = this.course;
    const t = C.clockAt(this.z); // course clock (see Course.clockAt)
    this.input = (k.has('ArrowLeft') || k.has('KeyA') ? -1 : 0) + (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0);
    this.runTime += dt;
    const px = this.x, py = this.y, pz = this.z;

    if (this.grounded) {
      const pl = this.pl, s = pl.sample(this.z, this.s);
      pl.bend(this.z, this.bd);
      const th = s.bank + pl.rollAt(t);
      this.bank = th;
      const a = this.input * STEER_ACC - CENTRIFUGAL * this.speed * this.speed * this.bd.kappa - G * Math.sin(th);
      this.vu += a * dt; this.vu *= Math.exp(-STEER_DAMP * dt);
      this.u += this.vu * dt;
      // speed curve: deck slope from the centreline samples
      // backward difference: at a lip end a forward probe would read past the platform
      const slopeTan = pl.sample(this.z + 1, {}).cy - pl.sample(this.z, {}).cy;
      this.speed = Math.max(V_MIN, Math.min(V_MAX, this.speed + accelAt(this.speed, slopeTan) * dt));
      this.z -= this.speed * dt;
      this.dist += this.speed * dt;

      // continue onto the next platform when this one ends
      let cur = pl;
      if (this.z < pl.z1) {
        const [wx] = deckPoint(s.cx, s.cy, pl.pivot, this.u, th);
        const n = C.surfaceAt(wx, this.z, t, this.y + 0.3, this.srf);
        if (n) { cur = n.pl; this.pl = cur; this.u = n.u; } else cur = null;
      }
      const s2 = cur ? cur.sample(this.z, this.s) : null;
      const th2 = cur ? s2.bank + cur.rollAt(C.clockAt(this.z)) : th;
      if (cur && Math.abs(this.u) <= s2.hw + BALL_R * 0.2) {
        const [wx, wy] = deckPoint(s2.cx, s2.cy, cur.pivot, this.u, th2);
        this.x = wx; this.y = wy + BALL_R;
        if (cur.tunnel && Math.abs(this.u) > s2.hw - BALL_R) {
          if (godMode) { this.u = Math.sign(this.u) * (s2.hw - BALL_R); this.vu = 0; } else this.kill('wall');
        }
      } else {
        // leave the deck: off the side, or off the end of a lip
        cur && cur.bend(this.z, this.bd);
        this.vx = this.vu * Math.cos(th) + this.speed * (this.bd.dcx || 0);
        // take off with the deck's own vertical velocity (descending lip = −v·slope)
        this.vy = -slopeTan * this.speed;
        const [wx] = deckPoint(s.cx, s.cy, pl.pivot, this.u, th);
        this.x = wx;
        this.y = py + this.vy * dt;
        this.grounded = false; this.pl = null;
      }
    } else {
      this.vy -= G * dt;
      this.y += this.vy * dt;
      this.x += this.vx * dt;
      this.z -= this.speed * dt;
      this.dist += this.speed * dt;
      const srf = C.surfaceAt(this.x, this.z, C.clockAt(this.z), this.y, this.srf);
      if (srf && this.y - BALL_R <= srf.y + 0.05 && py - BALL_R >= srf.y - 0.6) {
        this.grounded = true; this.pl = srf.pl; this.u = srf.u;
        this.vu = this.vx * Math.cos(srf.theta); this.vy = 0;
        this.y = srf.y + BALL_R;
      } else {
        const floor = C.centreAt(this.z, this.ctr).cy - 9;
        if (this.y < floor) {
          if (godMode) this.respawnOnDeck(); else this.kill('fell');
        }
      }
    }

    if (!this.dead && !godMode && C.hitObstacle(this.x, this.y, this.z, BALL_R * 0.95, C.clockAt(this.z))) this.kill('hit');

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
