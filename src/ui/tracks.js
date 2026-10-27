// Track library: the last 5 distinct seeds played (automatic) plus seeds you save
// (up to 20). Both persist in localStorage; the title screen lists them as chips.
const RECENT_KEY = 'tron-slope.recent.v1', SAVED_KEY = 'tron-slope.saved.v1';
const load = (k) => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export class Tracks {
  constructor() { this.recent = load(RECENT_KEY); this.saved = load(SAVED_KEY); }

  played(seed) {
    this.recent = [seed, ...this.recent.filter((s) => s !== seed)].slice(0, 5);
    store(RECENT_KEY, this.recent);
  }
  isSaved(seed) { return this.saved.includes(seed); }
  toggleSave(seed) {
    this.saved = this.isSaved(seed) ? this.saved.filter((s) => s !== seed) : [seed, ...this.saved].slice(0, 20);
    store(SAVED_KEY, this.saved);
    return this.isSaved(seed);
  }
}
