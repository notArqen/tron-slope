import { SCHEMA, SECTIONS, BY_KEY } from '../settings/schema.js';

// Settings overlay. Built once from the schema; after that it only touches the
// DOM on user input, plus a ~15 Hz graph redraw and a 2 Hz stats/cost refresh
// while open — so it costs ~nothing when closed and very little when open.
const PROFILE_KEYS = ['ao', 'reflections', 'gi', 'fog', 'volumetric', 'godrays', 'haze', 'bloom', 'streaks', 'flare', 'halation', 'dirt', 'dof', 'ca',
  'distortion', 'vignette', 'grain', 'motionBlur', 'radialBlur', 'heatHaze', 'scanlines', 'dither', 'pixelate', 'cas', 'rain', 'dustMotes', 'ash',
  'debris', 'embers', 'steam', 'splashes', 'ballDust', 'lensDroplets', 'cables', 'floaters', 'drones', 'billboards', 'strobes', 'lightning', 'neonFlicker',
  'surges', 'puddles', 'grime'];

export class Overlay {
  constructor(settings, perf, hooks) {
    this.s = settings; this.perf = perf; this.hooks = hooks;
    this.open = false;
    this.controls = new Map(); // key → [{ input, out }]
    this.build();
    settings.on((k) => this.sync(k));
    addEventListener('keydown', (e) => {
      if (e.code === 'Backquote' || e.key === '`' || e.key === '~') { e.preventDefault(); this.toggle(); }
      else if (e.code === 'Escape' && this.open) { e.preventDefault(); this.toggle(false); }
    });
    perf.onProbeDone = (key) => { this.flash(`${BY_KEY[key]?.label || key}: ${fmt(perf.probeResults.get(key).ms)} ms`); this.nextProfile(); };
    this._lastGraph = 0; this._lastStats = 0;
  }

  el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  build() {
    const root = this.el('aside'); root.id = 'overlay'; root.setAttribute('aria-label', 'Settings'); root.hidden = true;
    this.root = root;

    // ---- header: live stats + graph
    const head = this.el('div', 'ov-head');
    const stats = this.el('div', 'ov-stats');
    this.fpsEl = this.el('span', 'ov-fps', '--');
    const fpsLbl = this.el('span', 'ov-unit', 'fps');
    this.msEl = this.el('span', 'ov-ms', '');
    this.resEl = this.el('div', 'ov-res', '');
    stats.append(this.fpsEl, fpsLbl, this.msEl);
    this.graph = this.el('canvas', 'ov-graph'); this.graph.width = 300; this.graph.height = 54;
    this.g2 = this.graph.getContext('2d');
    head.append(stats, this.resEl, this.graph);
    root.append(head);

    // ---- sections
    const body = this.el('div', 'ov-body');
    this.sections = {};
    for (const name of SECTIONS) {
      const det = this.el('details', 'ov-sec');
      if (name === 'Performance' || name === 'Game') det.open = true;
      const sum = this.el('summary', null, name);
      if (name === 'Weather') { this.wxBadge = this.el('span', 'ov-badge', ''); sum.append(this.wxBadge); }
      det.append(sum);
      const list = this.el('div', 'ov-list');
      det.append(list);
      body.append(det);
      this.sections[name] = list;
    }
    for (const spec of SCHEMA) {
      this.addControl(spec, this.sections[spec.section]);
      if (spec.alsoIn) this.addControl(spec, this.sections[spec.alsoIn]);
    }

    // per-effect cost readout lives in Performance
    const costWrap = this.el('div', 'ov-costs');
    const costHead = this.el('div', 'ov-costhead');
    this.modeEl = this.el('span', 'ov-mode', '');
    const prof = this.el('button', 'ov-btn', 'Profile all');
    prof.title = 'Measure every effect by toggling it off/on and timing synced frames (takes ~1 min).';
    prof.onclick = () => this.profileAll();
    costHead.append(this.el('span', 'ov-costtitle', 'Per-effect cost'), this.modeEl, prof);
    this.costList = this.el('div', 'ov-costlist');
    costWrap.append(costHead, this.costList);
    this.sections.Performance.append(costWrap);

    // footer actions
    const foot = this.el('div', 'ov-foot');
    const exp = this.el('button', 'ov-btn', 'Export');
    exp.onclick = () => {
      const blob = new Blob([this.s.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'tron-slope-settings.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    const imp = this.el('button', 'ov-btn', 'Import');
    const file = this.el('input'); file.type = 'file'; file.accept = 'application/json'; file.hidden = true;
    file.onchange = async () => {
      try { this.s.assign(JSON.parse(await file.files[0].text())); this.flash('Settings imported'); }
      catch { this.flash('Import failed: not a settings JSON'); }
      file.value = '';
    };
    imp.onclick = () => file.click();
    const rst = this.el('button', 'ov-btn ov-danger', 'Reset all');
    rst.onclick = () => { this.s.resetAll(); this.flash('All settings reset'); };
    foot.append(exp, imp, rst, file);
    this.tipEl = this.el('div', 'ov-tip', 'Backtick toggles · Tab moves · arrows adjust');
    root.append(body, foot, this.tipEl);
    document.body.append(root);
  }

  addControl(spec, parent) {
    const row = this.el('div', 'ov-row');
    const id = `ov-${spec.key}-${parent.childElementCount}`;
    const label = this.el('label', 'ov-label', spec.label); label.htmlFor = id; label.title = spec.tip;
    let input, out = null;
    if (spec.type === 'bool') {
      input = this.el('input', 'ov-switch'); input.type = 'checkbox'; input.role = 'switch';
      input.onchange = () => {
        this.s.set(spec.key, input.checked);
        // no GPU timer queries → measure the toggle as a synced frame-time delta
        if (!this.perf.ext && PROFILE_KEYS.includes(spec.key)) this.hooks.probe(spec.key);
      };
    } else if (spec.type === 'range') {
      input = this.el('input', 'ov-range'); input.type = 'range';
      input.min = spec.min; input.max = spec.max; input.step = spec.step;
      out = this.el('output', 'ov-val');
      input.oninput = () => { this.s.set(spec.key, Number(input.value)); };
    } else {
      input = this.el('select', 'ov-select');
      for (const [v, txt] of spec.options) { const o = this.el('option', null, txt); o.value = v; input.append(o); }
      input.onchange = () => this.s.set(spec.key, input.value);
    }
    input.id = id; input.title = spec.tip;
    input.setAttribute('aria-description', spec.tip);
    const showTip = () => { this.tipEl.textContent = spec.tip; };
    input.addEventListener('focus', showTip); row.addEventListener('pointerenter', showTip);
    const reset = this.el('button', 'ov-reset', '↺');
    reset.title = `Reset ${spec.label} to default`; reset.setAttribute('aria-label', reset.title);
    reset.onclick = () => this.s.reset(spec.key);
    row.append(label, input);
    if (out) row.append(out);
    row.append(reset);
    parent.append(row);
    if (!this.controls.has(spec.key)) this.controls.set(spec.key, []);
    this.controls.get(spec.key).push({ input, out, spec, row });
    this.sync(spec.key);
  }

  sync(k) {
    const list = this.controls.get(k); if (!list) return;
    const v = this.s.get(k);
    for (const { input, out, spec, row } of list) {
      if (spec.type === 'bool') input.checked = v;
      else input.value = v;
      if (out) out.textContent = fmtVal(v, spec.step);
      row.classList.toggle('ov-changed', v !== this.s.defaults[k]);
    }
  }

  toggle(force) {
    this.open = force ?? !this.open;
    this.root.hidden = !this.open;
    if (this.open) { (this.root.querySelector('summary') || this.root).focus(); this._lastStats = 0; }
    else if (this.root.contains(document.activeElement)) document.activeElement.blur();
  }

  weatherLabel(name) { if (this.wxBadge && this._wx !== name) { this._wx = name; this.wxBadge.textContent = name; } }

  flash(msg) { this.tipEl.textContent = msg; }

  profileAll() {
    this.queue = PROFILE_KEYS.filter((k) => this.s.get(k) === true);
    this.flash(`Profiling ${this.queue.length} enabled effects…`);
    this.nextProfile();
  }
  nextProfile() {
    if (!this.queue || !this.queue.length) { if (this.queue) this.flash('Profiling done'); this.queue = null; return; }
    const k = this.queue.shift();
    if (!this.hooks.probe(k)) this.queue.unshift(k);
  }

  tick(now, info) {
    if (!this.open) return;
    if (now - this._lastGraph > 66) { this._lastGraph = now; this.drawGraph(); }
    if (now - this._lastStats > 500) {
      this._lastStats = now;
      const p = this.perf;
      this.fpsEl.textContent = p.fps ? p.fps.toFixed(0) : '--';
      this.msEl.textContent = p.avgMs ? `${p.avgMs.toFixed(1)} ms` : '';
      this.resEl.textContent = `${info.size.w}×${info.size.h} → ${info.size.ow}×${info.size.oh} · dyn ${(info.dynScale * 100).toFixed(0)}% · reaction ${info.reactDist.toFixed(0)} m · seed ${info.seed} · chunks ${info.course.generated} (rejected ${info.course.rejected}, fallback ${info.course.fallbacks})`;
      this.modeEl.textContent = info.timingMode;
      this.renderCosts();
    }
  }

  drawGraph() {
    const g = this.g2, W = this.graph.width, H = this.graph.height, d = this.perf.frameMs;
    g.clearRect(0, 0, W, H);
    const max = 50;
    const y = (ms) => H - Math.min(ms, max) / max * H;
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
    for (const ms of [16.7, 33.3]) { g.beginPath(); g.moveTo(0, y(ms) + 0.5); g.lineTo(W, y(ms) + 0.5); g.stroke(); }
    g.strokeStyle = '#7dffa0'; g.beginPath();
    const n = d.length, step = W / 240;
    for (let i = 0; i < n; i++) { const x = W - (n - i) * step; i ? g.lineTo(x, y(d[i])) : g.moveTo(x, y(d[i])); }
    g.stroke();
  }

  renderCosts() {
    this.perf.prune();
    const rows = [];
    for (const [name, c] of this.perf.costs) rows.push({ name, ms: c.ms, src: c.src === 'timer-query' ? 'gpu' : 'sync' });
    for (const [key, r] of this.perf.probeResults) rows.push({ name: BY_KEY[key]?.label || key, ms: r.ms, src: 'Δ toggle' });
    rows.sort((a, b) => b.ms - a.ms);
    const total = rows.filter((r) => r.src !== 'Δ toggle').reduce((s, r) => s + r.ms, 0);
    const html = [];
    if (!rows.length) html.push(`<div class="ov-empty">${this.perf.ext ? 'Waiting for timer queries…' : (this.perf.unreliable
      ? `GPU timer queries rejected (Σ ${this.perf.unreliable.sum.toFixed(0)} ms reported in a ${this.perf.unreliable.frame.toFixed(1)} ms frame). `
      : 'No GPU timer queries in this browser. ') + 'Toggle any effect (or Profile all) to measure its synced frame-time delta, or enable Debug → Sync per-pass timing.'}</div>`);
    const max = Math.max(1, ...rows.map((r) => r.ms));
    for (const r of rows.slice(0, 48)) {
      const w = Math.max(0, Math.min(100, (r.ms / max) * 100));
      html.push(`<div class="ov-cost"><span class="ov-cn">${esc(r.name)}</span><span class="ov-cbar"><i style="transform:scaleX(${(w / 100).toFixed(3)})"></i></span><span class="ov-cms">${fmt(r.ms)}</span><span class="ov-csrc">${r.src}</span></div>`);
    }
    if (total > 0) html.push(`<div class="ov-cost ov-total"><span class="ov-cn">Σ timed passes</span><span></span><span class="ov-cms">${fmt(total)}</span><span class="ov-csrc"></span></div>`);
    if (this.perf.probe) html.unshift(`<div class="ov-empty">Measuring ${esc(BY_KEY[this.perf.probe.key]?.label || this.perf.probe.key)}…</div>`);
    this.costList.innerHTML = html.join('');
  }
}

function fmt(ms) { return (ms >= 0 ? '' : '−') + Math.abs(ms).toFixed(2); }
function fmtVal(v, step) { const d = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3; return Number(v).toFixed(d); }
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
