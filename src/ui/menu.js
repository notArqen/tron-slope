// Title screen + pause menu. Plain DOM; keyboard first (↑/↓ or Tab to move,
// Enter/Space to choose). The title animates in only on first load (rare →
// allowed some delight); the pause menu is keyboard-summoned constantly, so it
// appears instantly with no animation.
const START_LEVELS = [['easy', 'Easy', 0], ['medium', 'Medium', 0.35], ['hard', 'Hard', 0.7]];
const LS_START = 'tron-slope.start.v1';

export class Menu {
  constructor(hooks) {
    this.h = hooks;
    this.title = document.getElementById('menu');
    this.pause = document.getElementById('pause');
    this.level = (() => { try { return localStorage.getItem(LS_START) || 'easy'; } catch { return 'easy'; } })();

    // start-difficulty segmented control
    const seg = this.title.querySelector('.m-level:not(.m-vehicle)');
    for (const [id, label] of START_LEVELS) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.dataset.level = id; b.setAttribute('role', 'radio');
      b.onclick = () => this.setLevel(id);
      seg.append(b);
    }
    this.setLevel(this.level);

    // vehicle picker mirrors the Game → Vehicle setting
    for (const b of this.title.querySelectorAll('.m-vehicle button')) b.onclick = () => this.h.vehicle(b.dataset.vehicle);
    this.title.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'play') this.h.play(null, this.startD());
      if (act === 'settings') this.h.settings();
      if (act === 'autoplay') this.h.autoplay(this.startD());
    });
    this.title.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = this.title.querySelector('input').value.trim();
      this.h.play(v || null, this.startD());
    });
    this.pause.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) this.h[act]();
    });
    for (const root of [this.title, this.pause]) root.addEventListener('keydown', (e) => this.nav(e, root));
  }

  setVehicle(v) { for (const b of this.title.querySelectorAll('.m-vehicle button')) b.setAttribute('aria-checked', String(b.dataset.vehicle === v)); }

  startD() { return START_LEVELS.find(([id]) => id === this.level)[2]; }

  setLevel(id) {
    this.level = id;
    try { localStorage.setItem(LS_START, id); } catch { /* private mode */ }
    for (const b of this.title.querySelectorAll('.m-level button')) b.setAttribute('aria-checked', String(b.dataset.level === id));
  }

  // ↑/↓ moves between controls, ←/→ changes the start level when it's focused
  nav(e, root) {
    if (e.target.tagName === 'INPUT' && !['ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) return;
    const items = [...root.querySelectorAll('button:not([hidden]), input')].filter((el) => !el.closest('.m-level') || el.getAttribute('aria-checked') === 'true');
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      const n = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      n && n.focus();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && document.activeElement?.closest('.m-vehicle')) {
      e.preventDefault(); e.stopPropagation();
      const v = e.key === 'ArrowRight' ? 'cycle' : 'ball'; this.h.vehicle(v);
      this.title.querySelector(`.m-vehicle [data-vehicle="${v}"]`).focus();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && document.activeElement?.closest('.m-level')) {
      e.preventDefault(); e.stopPropagation();
      const k = START_LEVELS.findIndex(([id]) => id === this.level);
      const nk = Math.max(0, Math.min(START_LEVELS.length - 1, k + (e.key === 'ArrowRight' ? 1 : -1)));
      this.setLevel(START_LEVELS[nk][0]);
      this.title.querySelector(`.m-level [data-level="${START_LEVELS[nk][0]}"]`).focus();
    }
  }

  showTitle(best) {
    this.title.querySelector('.m-best').textContent = best ? `best ${best}` : '';
    this.title.hidden = false;
    document.body.classList.add('in-menu');
    requestAnimationFrame(() => this.title.querySelector('[data-act="play"]').focus({ preventScroll: true }));
  }
  hideTitle() {
    this.title.hidden = true;
    document.body.classList.remove('in-menu');
    this.title.classList.remove('first');
  }
  showPause(seed, auto) {
    this.pause.querySelector('.p-seed').textContent = `seed ${seed}`;
    this.setAutoLabel(auto);
    this.pause.hidden = false;
    this.pause.querySelector('[data-act="resume"]').focus({ preventScroll: true });
  }
  setAutoLabel(on) { this.pause.querySelector('.p-auto').textContent = `Autoplay: ${on ? 'on' : 'off'}`; }
  hidePause() { this.pause.hidden = true; if (this.pause.contains(document.activeElement)) document.activeElement.blur(); }
}
