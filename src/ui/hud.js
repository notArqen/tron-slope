// In-game HUD: seven-segment green score (the blocky top-centre counter from the
// reference stills), overall + per-seed best, seed label, and the death summary.
const BEST_KEY = 'tron-slope.best.v1';
const SEED_KEY = 'tron-slope.bestBySeed.v1';
const BEST_AUTO_KEY = 'tron-slope.bestAuto.v1', SEED_AUTO_KEY = 'tron-slope.bestBySeedAuto.v1';
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
    // manual and autoplay keep separate high scores (overall + per seed)
    this.S = {
      manual: { best: Number(load(BEST_KEY, 0)) || 0, bySeed: load(SEED_KEY, {}), keys: [BEST_KEY, SEED_KEY] },
      auto: { best: Number(load(BEST_AUTO_KEY, 0)) || 0, bySeed: load(SEED_AUTO_KEY, {}), keys: [BEST_AUTO_KEY, SEED_AUTO_KEY] },
    };
    this.mode = 'manual';
    this._shown = -1;
  }

  startRun(seedStr) {
    this.seedStr = seedStr; this.tainted = false; this.beating = false; this.mode = 'manual';
    this.sum.hidden = true;
    this.msgEl.textContent = ''; this.msgEl.className = 'msg';
    this.scoreEl.classList.remove('beating');
    this.seedEl.textContent = `seed ${seedStr}`;
    this.renderBest();
  }

  // Autoplay runs never count toward bests
  // score milestone: brief flash of the digits (CSS transition, not a keyframe, so repeats retarget cleanly)
  pulse() { this.scoreEl.classList.add('pulse'); clearTimeout(this._pt); this._pt = setTimeout(() => this.scoreEl.classList.remove('pulse'), 160); }

  // a run that used autoplay at any point is scored on the autoplay board
  setAutoplay(on) { this.autoEl.hidden = !on; if (on) { this.mode = 'auto'; this.beating = false; this.scoreEl.classList.remove('beating'); } this.renderBest(); }
  get best() { return this.S[this.mode].best; }
  get bySeed() { return this.S[this.mode].bySeed; }

  renderBest() {
    const sb = this.bySeed[this.seedStr] || 0;
    const tag = this.mode === 'auto' ? 'autoplay best' : 'best';
    this.bestEl.textContent = this.best ? `${tag} ${this.best}${sb && sb !== this.best ? ` · seed ${sb}` : ''}` : '';
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
      const B = this.S[this.mode];
      if (score > B.best) { B.best = score; this.last.newBest = true; save(B.keys[0], score); }
      if (score > (B.bySeed[seedStr] || 0)) {
        B.bySeed[seedStr] = score; this.last.newSeedBest = true;
        const keys = Object.keys(B.bySeed); if (keys.length > 200) delete B.bySeed[keys[0]];
        save(B.keys[1], B.bySeed);
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
    this.sumStats.innerHTML = `<span>best <b>${this.best}</b>${l.newBest ? ' <i>new</i>' : ''}</span><span>this seed <b>${sb}</b>${l.newSeedBest && !l.newBest ? ' <i>new</i>' : ''}</span>${this.tainted ? '<span class="dim">no-death run · not counted</span>' : this.mode === 'auto' ? '<span class="dim">autoplay board</span>' : ''}`;
    this.sumSeed.value = this.seedStr;
    this.sum.hidden = false;
  }
}
