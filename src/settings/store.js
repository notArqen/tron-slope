import { BY_KEY, PRESETS, QUALITY_KEYS, defaults } from './schema.js';

const LS_KEY = 'tron-slope.settings.v1';

// Tiny observable settings store with localStorage persistence.
export class Settings {
  constructor() {
    this.defaults = defaults();
    this.values = { ...this.defaults };
    this.listeners = new Set();
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        // defaults that changed since a save was made: move values still sitting on the
        // old default to the new one; anything the player changed themselves is kept
        if ((saved._v || 1) < 2) {
          for (const [k, oldDef] of Object.entries({ mbStrength: 0.6, radialStrength: 0.5, caStrength: 0.35 })) if (saved[k] === oldDef) delete saved[k];
        }
        if ((saved._v || 1) < 3) delete saved.curves; // v3: curvy sections now default off
        this.assign(saved, false);
      }
    } catch { /* private mode / corrupt — fall back to defaults */ }
  }

  get(k) { return this.values[k]; }

  // sanitize one incoming value against the schema
  coerce(k, v) {
    const s = BY_KEY[k];
    if (!s) return undefined;
    if (s.type === 'bool') return !!v;
    if (s.type === 'range') { const n = Number(v); return Number.isFinite(n) ? Math.min(s.max, Math.max(s.min, n)) : undefined; }
    if (s.type === 'select') return s.options.some(([o]) => o === String(v)) ? String(v) : undefined;
  }

  set(k, v, { fromPreset = false } = {}) {
    const c = this.coerce(k, v);
    if (c === undefined || this.values[k] === c) return;
    this.values[k] = c;
    if (k === 'preset' && c !== 'custom') { this.applyPreset(c); return; }
    if (!fromPreset && QUALITY_KEYS.includes(k) && this.values.preset !== 'custom') {
      this.values.preset = 'custom';
      this.emit('preset');
    }
    this.emit(k);
    this.save();
  }

  applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    this.values.preset = name;
    for (const [k, v] of Object.entries(p)) this.set(k, v, { fromPreset: true });
    this.emit('preset');
    this.save();
  }

  reset(k) {
    if (k === 'preset') { this.applyPreset('high'); return; }
    this.set(k, this.defaults[k]);
  }

  resetAll() {
    Object.assign(this.values, this.defaults); // mutate in place: consumers hold this object
    for (const k of Object.keys(this.values)) this.emit(k);
    this.save();
  }

  assign(obj, emit = true) {
    for (const [k, v] of Object.entries(obj || {})) {
      const c = this.coerce(k, v);
      if (c !== undefined) this.values[k] = c;
    }
    if (emit) { for (const k of Object.keys(this.values)) this.emit(k); this.save(); }
  }

  exportJSON() { return JSON.stringify({ ...this.values, _v: 3 }, null, 2); }

  save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => { try { localStorage.setItem(LS_KEY, JSON.stringify({ ...this.values, _v: 3 })); } catch { /* quota */ } }, 150);
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(k) { for (const fn of this.listeners) fn(k, this.values[k]); }
}
