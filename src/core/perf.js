// Frame stats + per-pass GPU timing.
//  - EXT_disjoint_timer_query_webgl2 when the browser exposes it (async, accurate)
//  - optional "sync" mode: gl.finish() around each pass, CPU wall-clock (stalls, debug only)
//  - toggle probes: measure synced frame work time with an effect on vs off (fallback)
export class Perf {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.mode = this.ext ? 'timer-query' : 'none';
    this.sync = false;
    this.pending = [];
    this.costs = new Map();   // name → { ms (ema), src, t }
    this.frameMs = [];        // recent frame intervals for the graph
    this.fps = 0; this._acc = 0; this._n = 0; this._last = performance.now();
    this.active = null;
    this.probe = null;
    this.probeResults = new Map(); // effect key → { ms, at }
  }

  get timingMode() {
    if (this.ext) return 'timer-query';
    const base = this.sync ? 'sync' : 'toggle-delta';
    return this.unreliable ? base + ' (timer queries rejected)' : base;
  }

  // Some drivers (ANGLE→Metal on Apple GPUs) split the command buffer per query and
  // report wall time, so Σ(pass times) ≫ frame time. Detect that and stop using them.
  validate() {
    if (!this.ext || !this.avgMs || this.costs.size < 4) return;
    const sum = [...this.costs.values()].reduce((s, c) => s + c.ms, 0);
    this._bad = sum > this.avgMs * 1.5 ? (this._bad || 0) + 1 : 0;
    if (this._bad >= 3) {
      this.unreliable = { sum, frame: this.avgMs };
      for (const p of this.pending) this.gl.deleteQuery(p.q);
      this.pending.length = 0;
      this.ext = null;
      this.costs.clear();
      console.info(`[perf] timer queries rejected: Σ passes ${sum.toFixed(1)} ms vs ${this.avgMs.toFixed(1)} ms frame — using toggle-delta probes`);
    }
  }

  frame(now) {
    const dt = now - this._last; this._last = now;
    this.frameMs.push(dt); if (this.frameMs.length > 240) this.frameMs.shift();
    this._acc += dt; this._n++;
    if (this._acc > 500) { this.fps = (this._n * 1000) / this._acc; this.avgMs = this._acc / this._n; this._acc = 0; this._n = 0; this.validate(); }
    return dt;
  }

  begin(name) {
    if (this.ext) {
      if (this.active) return;
      const q = this.gl.createQuery();
      this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
      this.active = { name, q };
    } else if (this.sync) {
      this.gl.finish();
      this.active = { name, t0: performance.now() };
    }
  }

  end() {
    const a = this.active; if (!a) return;
    this.active = null;
    if (this.ext) { this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); this.pending.push(a); }
    else if (this.sync) { this.gl.finish(); this.record(a.name, performance.now() - a.t0, 'sync'); }
  }

  // wrap a function in a timed span
  time(name, fn) { this.begin(name); try { fn(); } finally { this.end(); } }

  poll() {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) {
        if (!disjoint) this.record(p.name, gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6, 'timer-query');
        gl.deleteQuery(p.q);
        this.pending.splice(i, 1);
      }
    }
    if (this.pending.length > 400) { for (const p of this.pending) gl.deleteQuery(p.q); this.pending.length = 0; }
  }

  record(name, ms, src) {
    const c = this.costs.get(name);
    if (c) { c.ms = c.ms * 0.9 + ms * 0.1; c.t = performance.now(); c.src = src; }
    else this.costs.set(name, { ms, src, t: performance.now() });
  }

  // forget passes that stopped running (effect turned off)
  prune() {
    const now = performance.now();
    for (const [k, c] of this.costs) if (now - c.t > 1500) this.costs.delete(k);
  }

  // ---- toggle-delta probe ------------------------------------------------------
  // flip(state) sets the effect on/off. We measure synced work time for `frames`
  // in the new state, then the old state, then restore the new state.
  startProbe(key, flip, newState, frames = 40) {
    if (this.probe) return false;
    this.probe = { key, flip, newState, frames, phase: 0, n: 0, sum: [0, 0] };
    return true;
  }

  // call once per frame with the synced CPU+GPU work time of that frame
  probeSample(workMs) {
    const p = this.probe; if (!p) return;
    if (p.n >= 4) p.sum[p.phase] += workMs; // skip a few warm-up frames per phase (shader compiles, RT allocs)
    p.n++;
    if (p.n >= p.frames + 4) {
      if (p.phase === 0) { p.phase = 1; p.n = 0; p.flip(!p.newState); }
      else {
        p.flip(p.newState);
        const on = p.newState ? p.sum[0] : p.sum[1], off = p.newState ? p.sum[1] : p.sum[0];
        this.probeResults.set(p.key, { ms: (on - off) / p.frames, at: performance.now() });
        this.probe = null;
        this.onProbeDone && this.onProbeDone(p.key);
      }
    }
  }
}
