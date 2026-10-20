// In-game HUD: seven-segment green score (the blocky top-centre counter from the
// reference stills), overall + per-seed best, seed label, and the death summary.
const BEST_KEY = 'tron-slope.best.v1';
const SEED_KEY = 'tron-slope.bestBySeed.v1';
const SEGS = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
const SEG_RECTS = { a: [1, 0, 4, 1], b: [5, 1, 1, 4], c: [5, 6, 1, 4], d: [1, 10, 4, 1], e: [0, 6, 1, 4], f: [0, 1, 1, 4], g: [1, 5, 4, 1] };

const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode / quota */ } };

function digitSVG(ch) {
  const on = SEGS[ch] || '';
  return `<svg viewBox="-0.5 -0.5 7 12" class="seg">${Object.entries(SEG_RECTS).map(([k, [x, y, w, h]]) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" class="${on.includes(k) ? 'on' : 'off'}"/>`).join('')}</svg>`;
}

export class Hud {
  constructor() {
    const hud = document.getElementById('hud');
    this.scoreEl = hud.querySelector('.score');
    this.bestEl = hud.querySelector('.best');
    this.speedEl = hud.querySelector('.speed');
    this.seedEl = hud.querySelector('.seed');
    this.msgEl = hud.querySelector('.msg');
    this.autoEl = hud.querySelector('.auto');
    this.sum = document.getElementById('summary');
    this.sumScore = this.sum.querySelector('.s-score');
    this.sumStats = this.sum.querySelector('.s-stats');
    this.sumSeed = this.sum.querySelector('input');
    this.sum.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); this.onSeedSubmit && this.onSeedSubmit(this.sumSeed.value); this.sumSeed.blur(); });
    this.best = Number(load(BEST_KEY, 0)) || 0;
    this.bySeed = load(SEED_KEY, {});
    this._shown = -1;
  }

  startRun(seedStr) {
    this.seedStr = seedStr; this.tainted = false; this.beating = false;
    this.sum.hidden = true;
    this.msgEl.textContent = ''; this.msgEl.className = 'msg';
    this.scoreEl.classList.remove('beating');
    this.seedEl.textContent = `seed ${seedStr}`;
    this.renderBest();
  }

  // Autoplay runs never count toward bests
  setAutoplay(on) { this.autoEl.hidden = !on; if (on) this.tainted = true; }

  renderBest() {
    const sb = this.bySeed[this.seedStr] || 0;
    this.bestEl.textContent = this.best ? `best ${this.best}${sb && sb !== this.best ? ` · seed ${sb}` : ''}` : '';
  }

  frame(score, speed, godMode) {
    if (godMode) this.tainted = true; // no-death runs never count toward bests
    if (score !== this._shown) { this._shown = score; this.scoreEl.innerHTML = String(score).split('').map(digitSVG).join(''); }
    if (!this.tainted && !this.beating && this.best > 0 && score > this.best) { this.beating = true; this.scoreEl.classList.add('beating'); }
    this.speedEl.textContent = `${(speed * 3.6).toFixed(0)} km/h`;
  }

  crash(score, seedStr, cause) {
    this.last = { score, cause, newBest: false, newSeedBest: false };
    if (!this.tainted) {
      if (score > this.best) { this.best = score; this.last.newBest = true; save(BEST_KEY, score); }
      if (score > (this.bySeed[seedStr] || 0)) {
        this.bySeed[seedStr] = score; this.last.newSeedBest = true;
        const keys = Object.keys(this.bySeed); if (keys.length > 200) delete this.bySeed[keys[0]];
        save(SEED_KEY, this.bySeed);
      }
    }
    this.msgEl.textContent = this.last.newBest ? `new best ${score}` : ({ hit: 'crashed', wall: 'hit the wall', fell: 'fell' }[cause] || 'crashed');
    this.msgEl.className = 'msg' + (this.last.newBest ? ' newbest' : '');
    this.renderBest();
  }

  showSummary() {
    const l = this.last || { score: 0 };
    this.msgEl.textContent = '';
    this.sumScore.innerHTML = String(l.score).split('').map(digitSVG).join('');
    const sb = this.bySeed[this.seedStr] || 0;
    this.sumStats.innerHTML = `<span>best <b>${this.best}</b>${l.newBest ? ' <i>new</i>' : ''}</span><span>this seed <b>${sb}</b>${l.newSeedBest && !l.newBest ? ' <i>new</i>' : ''}</span>${this.tainted ? '<span class="dim">autoplay / no-death run · not counted</span>' : ''}`;
    this.sumSeed.value = this.seedStr;
    this.sum.hidden = false;
  }
}
