import { useEffect, useRef } from 'react';
import type { CharLook } from '../core/avatar/msio';
import { classAvatar } from '../core/pixelart';
import { GROUND_Y, SCENE_H, SCENE_W, sceneImage } from '../core/scene';
import { useCtrl } from './hooks';

/**
 * A job's pixel-art explorer, animated: the slow idle loop, or the class attack while `fighting`. Drawn at a
 * whole-number zoom with no smoothing, so every pixel stays the same size.
 */
export function AvatarCanvas({ cls, zoom, fighting = false }: { cls: string; zoom: number; fighting?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const a = classAvatar(cls);

  useEffect(() => {
    const frames = fighting ? a.attack : a.idle, scratch = document.createElement('canvas');
    scratch.width = a.w; scratch.height = a.h;
    let i = 0;
    const paint = () => {
      const g = ref.current?.getContext('2d');
      if (!g) return;
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, a.w * zoom, a.h * zoom);
      scratch.getContext('2d')!.putImageData(frames[i++ % frames.length], 0, 0);
      g.drawImage(scratch, 0, 0, a.w * zoom, a.h * zoom);
    };
    paint();
    const id = window.setInterval(paint, fighting ? a.attackMs : a.idleMs);
    return () => clearInterval(id);
  }, [a, fighting, zoom]);

  return <canvas ref={ref} width={a.w * zoom} height={a.h * zoom} />;
}

const Z = 2; // scene and sprites share this zoom (maplestory.io frames are rendered at the game's own 1:1 size)
const FEET_X = 104; // where the character stands (native px); room on the left for projectiles
const TICK = 60;
/** frame delays (ms) for an attack with n frames, like the game's swing/stab/shoot timing */
const attackDelays = (n: number) => (n === 2 ? [350, 450] : n === 3 ? [300, 150, 350] : new Array(n).fill(200));
const REST = 300; // pause between attacks
const IDLE_MS = 500;

/** projectile sprites (native pixels), facing left */
const SHOTS: Record<NonNullable<CharLook['shot']>, { rows: string[][]; pal: Record<string, string>; speed: number }> = {
  arrow: { speed: 9, pal: { o: '#2a1e1e', w: '#8a5a2c', s: '#e4e9f2', f: '#ffffff' }, rows: [['..s......f.', '.swwwwwwwff', '..s......f.']] },
  star: { speed: 8, pal: { o: '#24182a', s: '#d8dde8', d: '#7c8496' }, rows: [['..o..', '.oso.', 'osdso', '.oso.', '..o..'], ['o...o', '.sos.', '.odo.', '.sos.', 'o...o']] },
  orb: { speed: 7, pal: { o: '#4a2a8c', p: '#8a5cf0', P: '#c4a8ff', W: '#ffffff' }, rows: [['.ooo.', 'opPpo', 'oPWPo', 'opPpo', '.ooo.']] },
};

/** The Live tab's character: real Maple sprites on a backdrop for the current map. */
export function CharacterStage() {
  const c = useCtrl(), fighting = c.fighting, theme = c.theme, sp = c.sprites;
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ fighting, theme });
  live.current = { fighting, theme };

  useEffect(() => {
    const bg = document.createElement('canvas'), px = document.createElement('canvas');
    bg.width = SCENE_W; bg.height = SCENE_H;
    let bgTheme = '', t0 = performance.now(), wasFighting = false;
    const id = window.setInterval(() => {
      const g = ref.current?.getContext('2d');
      if (!g) return;
      const { fighting, theme } = live.current, now = performance.now();
      if (fighting !== wasFighting) { wasFighting = fighting; t0 = now; }
      const t = now - t0;
      g.imageSmoothingEnabled = false;
      if (bgTheme !== theme) { bg.getContext('2d')!.putImageData(sceneImage(theme), 0, 0); bgTheme = theme; }
      g.drawImage(bg, 0, 0, SCENE_W * Z, SCENE_H * Z);

      const fr = sp.frames, look = sp.look;
      const idleOk = fr.idle.length > 0 && fr.idle.every(Boolean), atkOk = fr.attack.length > 0 && fr.attack.every(Boolean);
      if (look && idleOk) {
        // real sprite: idle ping-pongs (0,1,2,1); attack plays through, then a short rest
        let img = fr.idle[0]!, shotAge = -1;
        if (fighting && atkOk) {
          const d = attackDelays(fr.attack.length), cycle = d.reduce((a, b) => a + b, 0) + REST, ct = t % cycle;
          let acc = 0, k = 0;
          while (k < d.length && ct >= acc + d[k]) acc += d[k++];
          img = k < d.length ? fr.attack[k]! : fr.idle[0]!;
          const fire = d.slice(0, -1).reduce((a, b) => a + b, 0); // the last frame is the release
          shotAge = ct >= fire ? ct - fire : -1;
        } else {
          const seq = fr.idle.length > 2 ? [...fr.idle.keys(), ...[...fr.idle.keys()].slice(1, -1).reverse()] : [...fr.idle.keys()];
          img = fr.idle[seq[Math.floor(t / IDLE_MS) % seq.length]]!;
        }
        // FeetCenter frames: the image centre is the feet
        g.drawImage(img, FEET_X * Z - img.width * Z / 2, GROUND_Y * Z - img.height * Z / 2, img.width * Z, img.height * Z);
        if (look.shot && shotAge >= 0) drawShot(g, look.shot, shotAge);
      } else {
        // pixel-art stand-in until the real frames are in
        const a = classAvatar(c.identity.cls), list = fighting ? a.attack : a.idle;
        const im = list[Math.floor(t / (fighting ? a.attackMs : a.idleMs)) % list.length];
        px.width = a.w; px.height = a.h;
        px.getContext('2d')!.putImageData(im, 0, 0);
        g.drawImage(px, (FEET_X - 50) * Z, (GROUND_Y - 50) * Z, a.w * Z, a.h * Z);
      }
    }, TICK);
    return () => clearInterval(id);
  }, [c, sp]);

  const status = !sp.look ? (c.sess ? 'Rolling a character for your class…' : 'Start a session to roll a character for your class')
    : sp.ready ? (fighting ? '⚔ Fighting' : 'Idle')
    : `Fetching your character from maplestory.io (${sp.done}/${sp.total})${sp.failures ? ' · renderer busy, retrying' : ''}…`;
  return (
    <div className="stage">
      <canvas ref={ref} width={SCENE_W * Z} height={SCENE_H * Z} />
      <div className="stage-cap">{status}</div>
    </div>
  );
}

function drawShot(g: CanvasRenderingContext2D, kind: NonNullable<CharLook['shot']>, age: number) {
  const s = SHOTS[kind], steps = Math.floor(age / TICK), x0 = FEET_X - 24 - steps * s.speed, y0 = GROUND_Y - 34;
  if (x0 < -12) return;
  const rows = s.rows[steps % s.rows.length];
  rows.forEach((row, j) => [...row].forEach((ch, i) => {
    const col = s.pal[ch];
    if (!col) return;
    g.fillStyle = col;
    g.fillRect((x0 + i) * Z, (y0 + j) * Z, Z, Z);
  }));
}
