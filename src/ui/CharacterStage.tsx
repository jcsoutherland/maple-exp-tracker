import { useEffect, useRef } from 'react';
import { useCtrl } from './hooks';

/**
 * The stage's native size in game pixels (maplestory.io frames are the game's own 1:1 size). The canvas is drawn at
 * 3× and shown at half that, so each game pixel is 1.5 CSS pixels: crisp on high-DPI screens, even elsewhere.
 */
const W = 212, H = 126, GROUND = 108, Z = 3, SHOW = 1.5;
const FEET_X = W / 2; // centred; the character faces right (toward the stats)
const TICK = 60;
/** frame delays (ms) for an attack with n frames, like the game's swing/stab/shoot timing */
const attackDelays = (n: number) => (n === 2 ? [350, 450] : n === 3 ? [300, 150, 350] : new Array(n).fill(200));
const REST = 300; // pause between attacks
const IDLE_MS = 500;

/** The Live tab's character: real Maple sprites in a softly lit showroom, idle or attacking while EXP/loot comes in. */
export function CharacterStage() {
  const c = useCtrl(), fighting = c.fighting, sp = c.sprites;
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef(fighting);
  live.current = fighting;

  useEffect(() => {
    let t0 = performance.now(), wasFighting = false;
    const id = window.setInterval(() => {
      const g = ref.current?.getContext('2d');
      if (!g) return;
      const fighting = live.current, now = performance.now();
      if (fighting !== wasFighting) { wasFighting = fighting; t0 = now; }
      const t = now - t0;
      g.clearRect(0, 0, W * Z, H * Z);
      const fr = sp.frames, idleIn = fr.idle.filter((f): f is ImageBitmap => !!f);
      if (!sp.look || !idleIn.length) return;
      // floor shadow (soft: it's lighting, not part of the sprite)
      const sh = g.createRadialGradient(FEET_X * Z, GROUND * Z, 0, FEET_X * Z, GROUND * Z, 26 * Z);
      sh.addColorStop(0, 'rgba(0,0,0,0.55)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
      g.save(); g.scale(1, 0.22); g.fillStyle = sh; g.beginPath(); g.arc(FEET_X * Z, GROUND * Z / 0.22, 26 * Z, 0, Math.PI * 2); g.fill(); g.restore();

      // idle ping-pongs (0,1,2,1); the attack plays through once all its frames are in, then a short rest
      let img = idleIn[0];
      if (fighting && fr.attack.length && fr.attack.every(Boolean)) {
        const d = attackDelays(fr.attack.length), ct = t % (d.reduce((a, b) => a + b, 0) + REST);
        let acc = 0, k = 0;
        while (k < d.length && ct >= acc + d[k]) acc += d[k++];
        img = k < d.length ? fr.attack[k]! : idleIn[0];
      } else {
        const n = idleIn.length, seq = n > 2 ? [...Array(n).keys(), ...[...Array(n).keys()].slice(1, -1).reverse()] : [...Array(n).keys()];
        img = idleIn[seq[Math.floor(t / IDLE_MS) % seq.length]];
      }
      // FeetCenter frames: the image centre is the feet. Maple sprites face left, so mirror them to face right.
      g.imageSmoothingEnabled = false;
      g.save(); g.translate(FEET_X * Z, 0); g.scale(-1, 1);
      g.drawImage(img, -img.width * Z / 2, GROUND * Z - img.height * Z / 2, img.width * Z, img.height * Z);
      g.restore();
    }, TICK);
    return () => clearInterval(id);
  }, [sp]);

  const shown = !!sp.look && sp.frames.idle.some(Boolean);
  const placeholder = !sp.look ? "To start click the 'Start Session' button"
    : !shown ? `Rendering your character… (${sp.done}/${sp.total})${sp.failures ? ' · renderer busy, retrying' : ''}` : '';
  return (
    <div className="stage">
      <div className="showroom" style={{ width: W * SHOW, maxWidth: '100%', aspectRatio: `${W} / ${H}` }}>
        <canvas ref={ref} width={W * Z} height={H * Z} />
        {placeholder && <div className="stage-ph">{placeholder}</div>}
        {sp.look && <button className="reroll" title="New random hair, face and skin (gear is always the best for your job and level)" onClick={() => c.rerollLook()}>🎲</button>}
      </div>
      <div className="stage-cap">{shown ? (fighting ? '⚔ Fighting' : 'Idle') : ' '}</div>
    </div>
  );
}
