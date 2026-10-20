import * as THREE from 'three';

// Procedural 32³ grading LUTs (display-referred sRGB in → out). No assets.
const N = 32;
const GRADES = {
  neutral: (r, g, b) => [r, g, b],
  tron: (r, g, b) => {
    // cool shadows, cyan-biased highlights, slight crush
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sh = 1 - Math.min(1, l * 2);
    return [r * 0.92 - sh * 0.02, g * 1.0 + sh * 0.01, b * 1.06 + sh * 0.05 + l * 0.03];
  },
  legacy: (r, g, b) => {
    // teal shadows / orange highlights
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const t = smooth(l);
    return [r + (t * 0.08 - (1 - t) * 0.03), g + (t * 0.02 + (1 - t) * 0.015), b + (-t * 0.07 + (1 - t) * 0.04)];
  },
  ares: (r, g, b) => {
    // crushed blacks, red push, desaturated greens
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const c = (x) => Math.max(0, (x - 0.04) / 0.96);
    return [c(r * 1.08 + l * 0.04), c(g * 0.86 + l * 0.08), c(b * 0.84 + l * 0.06)];
  },
};
function smooth(x) { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); }

export function makeLUT(name) {
  const f = GRADES[name] || GRADES.neutral;
  const data = new Uint8Array(N * N * N * 4);
  let i = 0;
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const o = f(r / (N - 1), g / (N - 1), b / (N - 1));
    data[i++] = Math.round(Math.min(1, Math.max(0, o[0])) * 255);
    data[i++] = Math.round(Math.min(1, Math.max(0, o[1])) * 255);
    data[i++] = Math.round(Math.min(1, Math.max(0, o[2])) * 255);
    data[i++] = 255;
  }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

// Procedural lens-dirt mask: smudges, specks and a few hair-line scratches.
export function makeDirt() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 288;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
  let seed = 1337;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  x.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 40; i++) {
    const r = 20 + rnd() * 80, px = rnd() * c.width, py = rnd() * c.height;
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    const a = 0.04 + rnd() * 0.08;
    g.addColorStop(0, `rgba(255,240,220,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
  }
  for (let i = 0; i < 260; i++) {
    const r = 1 + rnd() * 5, px = rnd() * c.width, py = rnd() * c.height;
    x.fillStyle = `rgba(255,255,255,${0.1 + rnd() * 0.35})`;
    x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
  }
  x.strokeStyle = 'rgba(255,255,255,0.12)'; x.lineWidth = 0.8;
  for (let i = 0; i < 6; i++) {
    x.beginPath(); let px = rnd() * c.width, py = rnd() * c.height; x.moveTo(px, py);
    for (let k = 0; k < 8; k++) { px += (rnd() - 0.5) * 60; py += (rnd() - 0.5) * 30; x.lineTo(px, py); }
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}
