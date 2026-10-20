// Seeded PRNG (mulberry32). One stream drives the whole course for a seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * next());
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.sign = () => (next() < 0.5 ? -1 : 1);
  return next;
}

export const seedToString = (s) => (s >>> 0).toString(16).toUpperCase().padStart(8, '0');
export function parseSeed(str) {
  const t = String(str || '').trim().replace(/^#?seed=/i, '');
  if (/^[0-9a-f]{1,8}$/i.test(t)) return parseInt(t, 16) >>> 0;
  if (!t) return null;
  let h = 2166136261; // FNV-1a for arbitrary words
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const randomSeed = () => (Math.random() * 4294967296) >>> 0;
