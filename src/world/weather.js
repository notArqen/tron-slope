import * as THREE from 'three';

// One parameter set; every state is just a point in this space and blending is
// a lerp between points. Downstream systems only ever read `params`.
const STATES = {
  clear:    { fog: 0.0035, mist: 0.012, wind: 2.5, rain: 0.0, droplets: 0.0, dust: 0.25, ash: 0.0, debris: 0.15, embers: 0.4, flicker: 0.15, glow: 0.8, lightning: 0.0, power: 1.0, wet: 0.25, strobes: 0.5, fogTint: [0.55, 0.32, 0.22] },
  drizzle:  { fog: 0.0055, mist: 0.02, wind: 4.0, rain: 0.35, droplets: 0.35, dust: 0.1, ash: 0.0, debris: 0.25, embers: 0.3, flicker: 0.25, glow: 0.85, lightning: 0.08, power: 1.0, wet: 0.7, strobes: 0.6, fogTint: [0.42, 0.33, 0.32] },
  storm:    { fog: 0.0075, mist: 0.03, wind: 9.0, rain: 1.0, droplets: 0.9, dust: 0.0, ash: 0.0, debris: 0.6, embers: 0.2, flicker: 0.45, glow: 0.9, lightning: 1.0, power: 0.9, wet: 1.0, strobes: 0.8, fogTint: [0.3, 0.3, 0.38] },
  dust:     { fog: 0.011, mist: 0.03, wind: 11.0, rain: 0.0, droplets: 0.0, dust: 1.0, ash: 0.0, debris: 1.0, embers: 0.3, flicker: 0.3, glow: 1.1, lightning: 0.0, power: 0.95, wet: 0.0, strobes: 0.5, fogTint: [0.75, 0.45, 0.22] },
  ash:      { fog: 0.0075, mist: 0.02, wind: 2.0, rain: 0.0, droplets: 0.0, dust: 0.3, ash: 1.0, debris: 0.2, embers: 1.0, flicker: 0.35, glow: 0.7, lightning: 0.0, power: 0.85, wet: 0.1, strobes: 0.7, fogTint: [0.42, 0.38, 0.36] },
  blackout: { fog: 0.006, mist: 0.025, wind: 4.0, rain: 0.25, droplets: 0.2, dust: 0.35, ash: 0.1, debris: 0.3, embers: 0.6, flicker: 1.0, glow: 0.3, lightning: 0.25, power: 0.12, wet: 0.5, strobes: 1.0, fogTint: [0.18, 0.2, 0.26] },
};
export const WEATHER_ORDER = ['clear', 'drizzle', 'storm', 'ash', 'dust', 'blackout'];

const SCALABLE = ['fog', 'mist', 'wind', 'rain', 'droplets', 'dust', 'ash', 'debris', 'embers', 'flicker', 'lightning'];

export class WeatherDirector {
  constructor() {
    this.from = { ...STATES.drizzle };
    this.target = 'drizzle';
    this.blend = 1;
    this.blendDur = 6;
    this.hold = 0;
    this.params = { ...STATES.drizzle, fogTint: new THREE.Color(...STATES.drizzle.fogTint) };
    this._cur = { ...STATES.drizzle };
    this.lightningFlash = 0;   // 0..1, read by sky + lights
    this.lightningAz = 0;
    this._nextBolt = 4;
  }

  setTarget(name) {
    if (!STATES[name] || name === this.target) return;
    this.from = { ...this._cur };
    this.target = name;
    this.blend = 0;
    this.hold = 0;
  }

  update(dt, { auto, cycle, intensity, runTime, speedN, manual }) {
    if (auto) {
      this.hold += dt;
      if (this.hold > cycle && this.blend >= 1) {
        const i = WEATHER_ORDER.indexOf(this.target);
        this.setTarget(WEATHER_ORDER[(i + 1) % WEATHER_ORDER.length]);
      }
    } else if (manual !== this.target) this.setTarget(manual);

    this.blend = Math.min(1, this.blend + dt / this.blendDur);
    const k = this.blend * this.blend * (3 - 2 * this.blend);
    const to = STATES[this.target];
    for (const key of Object.keys(to)) {
      if (key === 'fogTint') continue;
      this._cur[key] = THREE.MathUtils.lerp(this.from[key], to[key], k);
    }
    const tint = this.from.fogTint.map((v, i) => THREE.MathUtils.lerp(v, to.fogTint[i], k));
    this._cur.fogTint = tint;

    // slowly intensify with run time and speed
    const ramp = intensity * (1 + Math.min(runTime / 240, 0.5) + speedN * 0.35);
    for (const key of Object.keys(this._cur)) {
      if (key === 'fogTint') continue;
      this.params[key] = SCALABLE.includes(key) ? this._cur[key] * ramp : this._cur[key];
    }
    this.params.fogTint.setRGB(tint[0], tint[1], tint[2]);

    // lightning: random distant strikes, rate driven by `lightning`
    this.lightningFlash = Math.max(0, this.lightningFlash - dt * 3.5);
    this._nextBolt -= dt * Math.max(this.params.lightning, 0);
    if (this._nextBolt <= 0) {
      this.lightningFlash = 0.7 + Math.random() * 0.3;
      this.lightningAz = (Math.random() - 0.5) * 2.4;
      this._nextBolt = 2 + Math.random() * 7;
      this._restrike = Math.random() < 0.5 ? 0.12 + Math.random() * 0.15 : -1;
    }
    if (this._restrike > 0) {
      this._restrike -= dt;
      if (this._restrike <= 0) this.lightningFlash = Math.max(this.lightningFlash, 0.8);
    }
    return this.params;
  }
}
