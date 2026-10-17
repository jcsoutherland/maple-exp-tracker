export function lev(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let p = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const c = [i];
    for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = c;
  }
  return p[n];
}

/** Case-insensitive similarity in [0, 1] (1 = identical). */
export function sim(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const L = Math.max(a.length, b.length);
  return L ? 1 - lev(a, b) / L : 1;
}

export function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/** Lowercase letters and digits only: used to compare OCR'd lines. */
export const normLine = (l: string) => l.toLowerCase().replace(/[^a-z0-9]/g, '');

export const fmtN = (n: number) => Math.round(n || 0).toLocaleString();
export const fmtK = (n: number) => {
  n = Math.round(n || 0);
  return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : n.toLocaleString();
};
export const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
export const fmtHM = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
