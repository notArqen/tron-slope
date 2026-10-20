import * as THREE from 'three';

// The single shared wind field. Every consumer (rain, dust, ash, debris, steam,
// fog drift, lens droplets, cables, splash, ball dust) reads these uniforms —
// the objects are shared by reference, so nothing keeps its own wind copy.
export class Wind {
  constructor() {
    this.uniforms = {
      uWindDir: { value: new THREE.Vector3(1, 0, 0) },
      uWindStrength: { value: 2 },
      uGust: { value: 0 },
      uGustDir: { value: new THREE.Vector3(1, 0, 0) },
      uTurbulence: { value: 1 },
      uTime: { value: 0 },
      uWindOffset: { value: new THREE.Vector3() }, // integrated base+gust advection (m)
    };
    this.gust = { t: 0, dur: 0, peak: 0, cooldown: 3 };
    this.gustiness = 0.5;
  }

  // dirDeg: compass-ish heading in degrees (0 = +x), strength m/s
  update(dt, time, { dirDeg, strength, gustiness, turbulence }) {
    const u = this.uniforms;
    u.uTime.value = time;
    const a = THREE.MathUtils.degToRad(dirDeg);
    u.uWindDir.value.set(Math.cos(a), 0, Math.sin(a));
    u.uWindStrength.value = strength;
    u.uTurbulence.value = turbulence;
    this.gustiness = gustiness;

    // integrate advection so consumers can displace by it without popping when wind changes
    const gs = u.uGust.value * strength * 1.5;
    u.uWindOffset.value.x += (u.uWindDir.value.x * strength + u.uGustDir.value.x * gs) * dt;
    u.uWindOffset.value.y += (u.uGustDir.value.y * gs) * dt;
    u.uWindOffset.value.z += (u.uWindDir.value.z * strength + u.uGustDir.value.z * gs) * dt;

    // random gust events: attack/decay envelope with a slightly veered direction
    const g = this.gust;
    if (g.dur > 0) {
      g.t += dt;
      const x = g.t / g.dur;
      u.uGust.value = x >= 1 ? 0 : g.peak * Math.sin(Math.PI * Math.pow(x, 0.6));
      if (x >= 1) { g.dur = 0; g.cooldown = 2 + Math.random() * 8 / Math.max(gustiness, 0.05); }
    } else {
      g.cooldown -= dt;
      if (g.cooldown <= 0 && gustiness > 0.01) {
        g.t = 0; g.dur = 1.5 + Math.random() * 3;
        g.peak = (0.4 + Math.random() * 0.6) * gustiness;
        const veer = a + (Math.random() - 0.5) * 1.2;
        u.uGustDir.value.set(Math.cos(veer), 0.05, Math.sin(veer)).normalize();
      }
    }
  }

  // exact CPU mirror of windAt() in glsl.js
  at(p, out = new THREE.Vector3()) {
    const u = this.uniforms, t = u.uTime.value;
    const pot = (x, y, z) => [
      Math.sin(y * 1.3 + t * 0.31) + Math.sin(z * 0.7 - t * 0.23),
      Math.sin(z * 1.1 + t * 0.27) + Math.sin(x * 0.9 + t * 0.19),
      Math.sin(x * 1.2 - t * 0.29) + Math.sin(y * 0.8 + t * 0.21)];
    const s = 0.035, e = 0.1, x = p.x * s, y = p.y * s, z = p.z * s;
    const px0 = pot(x - e, y, z), px1 = pot(x + e, y, z);
    const py0 = pot(x, y - e, z), py1 = pot(x, y + e, z);
    const pz0 = pot(x, y, z - e), pz1 = pot(x, y, z + e);
    const k = u.uTurbulence.value * (0.4 + u.uWindStrength.value * 0.25) / (2 * e);
    const ws = u.uWindStrength.value, g = u.uGust.value * ws * 1.5;
    out.set(
      u.uWindDir.value.x * ws + u.uGustDir.value.x * g + ((py1[2] - py0[2]) - (pz1[1] - pz0[1])) * k,
      u.uWindDir.value.y * ws + u.uGustDir.value.y * g + ((pz1[0] - pz0[0]) - (px1[2] - px0[2])) * k,
      u.uWindDir.value.z * ws + u.uGustDir.value.z * g + ((px1[1] - px0[1]) - (py1[0] - py0[0])) * k);
    return out;
  }
}
