/**
 * Level-up celebration: a few seconds of fireworks on a full-screen canvas behind the page. While it plays, the body
 * gets `.celebrate`, which makes the content surface and tiles see-through so the bursts glow through them
 * (styles.css). Listeners (the character stage) show the "LEVEL UP!" banner. With reduced motion only the banner shows.
 */
const COLORS = ['#8b7bff', '#ff7a9c', '#f5c542', '#a6e05a', '#5aa9ff', '#ffb257', '#ffffff'];
const SHOW_MS = 7000;

export interface Celebration { from: number; to: number; ms: number }
const listeners = new Set<(c: Celebration) => void>();
/** Called on every celebration (and replay); returns the unsubscribe. */
export function onCelebrate(cb: (c: Celebration) => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }

interface Rocket { x: number; y: number; vx: number; vy: number; c: string }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; age: number; c: string; tw: boolean }

let cv: HTMLCanvasElement | null = null, ctx: CanvasRenderingContext2D | null = null;
let W = 0, H = 0, raf = 0, until = 0, nextLaunch = 0;
let rockets: Rocket[] = [], sparks: Spark[] = [];
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: T[]) => a[(Math.random() * a.length) | 0];

function setup() {
  if (cv) return;
  cv = document.createElement('canvas');
  cv.className = 'fw-canvas';
  document.body.prepend(cv);
  ctx = cv.getContext('2d');
  const size = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = innerWidth; H = innerHeight; cv!.width = W * dpr; cv!.height = H * dpr;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  addEventListener('resize', size);
}

function burst(x: number, y: number, c: string) {
  const n = rnd(80, 120) | 0, c2 = pick(COLORS), ring = Math.random() < .3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd(-.05, .05), sp = ring ? rnd(4.6, 5.2) : rnd(1, 6);
    sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rnd(70, 110), age: 0, c: Math.random() < .7 ? c : c2, tw: Math.random() < .25 });
  }
}

function launch() {
  const x = rnd(W * .04, W * .96), ty = rnd(H * .1, H * .6), c = pick(COLORS);
  if (Math.random() < .5) return burst(x, ty, c); // half burst straight away, so the show starts at once
  rockets.push({ x, y: H + 10, vx: rnd(-.4, .4), vy: -Math.sqrt(2 * .09 * (H - ty)), c });
}

function frame(t: number) {
  const g = ctx!;
  // fade the last frame (leaves short trails), then draw additively
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = 'rgba(0,0,0,.13)';
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter';
  const live = t < until;
  if (live && t > nextLaunch) { launch(); if (Math.random() < .5) launch(); nextLaunch = t + rnd(160, 320); }
  rockets = rockets.filter(r => {
    r.x += r.vx; r.y += r.vy; r.vy += .09;
    g.globalAlpha = .9; g.fillStyle = r.c; g.beginPath(); g.arc(r.x, r.y, 2, 0, 7); g.fill();
    if (r.vy >= -.6) { burst(r.x, r.y, r.c); return false; }
    return true;
  });
  sparks = sparks.filter(p => {
    p.age++; p.vx *= .975; p.vy = p.vy * .975 + .045; p.x += p.vx; p.y += p.vy;
    const k = 1 - p.age / p.life;
    if (k <= 0) return false;
    g.globalAlpha = (p.tw && (p.age >> 2) % 2 ? .25 : 1) * k;
    g.fillStyle = p.c; g.beginPath(); g.arc(p.x, p.y, 1.6 + 2 * k, 0, 7); g.fill();
    return true;
  });
  g.globalAlpha = 1;
  if (!live) document.body.classList.remove('celebrate');
  if (live || rockets.length || sparks.length) raf = requestAnimationFrame(frame);
  else { cv!.classList.remove('on'); g.clearRect(0, 0, W, H); raf = 0; }
}

/** Celebrate reaching level `to` (from `from`); calling it again restarts the show. */
export function celebrateLevel(from: number, to: number) {
  const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : SHOW_MS;
  listeners.forEach(cb => cb({ from, to, ms }));
  if (!ms) return;
  setup();
  if (!ctx) return;
  document.body.classList.add('celebrate');
  cv!.classList.add('on');
  until = performance.now() + ms; nextLaunch = 0;
  for (let i = 0; i < 3; i++) setTimeout(launch, i * 120);
  if (!raf) raf = requestAnimationFrame(frame);
}
