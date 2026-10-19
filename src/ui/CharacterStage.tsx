import { useEffect, useRef, useState } from 'react';
import { lookGear, type CharLook, type GearPiece } from '../core/avatar/msio';
import { itemByName } from '../core/data/osms';
import { onCelebrate, type Celebration } from './fireworks';
import { useCtrl, useItemIcon } from './hooks';
import { MeowdbLink } from './MeowdbLink';

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

  // "LEVEL UP!" banner over the stage while the celebration plays
  const [cel, setCel] = useState<Celebration | null>(null), [celOn, setCelOn] = useState(false);
  useEffect(() => {
    let off = 0;
    const unsub = onCelebrate(e => {
      setCel(e); setCelOn(false);
      requestAnimationFrame(() => setCelOn(true));
      clearTimeout(off); off = window.setTimeout(() => setCelOn(false), Math.max(3500, e.ms - 800));
    });
    return () => { unsub(); clearTimeout(off); };
  }, []);

  const shown = !!sp.look && sp.frames.idle.some(Boolean);
  const placeholder = !sp.look ? "To start click the 'Start Session' button"
    : !shown ? `Rendering your character… (${sp.done}/${sp.total})${sp.failures ? ' · renderer busy, retrying' : ''}` : '';
  return (
    <div className="stage">
      <div className="showroom" style={{ width: W * SHOW, maxWidth: '100%', aspectRatio: `${W} / ${H}` }}>
        <canvas ref={ref} width={W * Z} height={H * Z} />
        {placeholder && <div className="stage-ph">{placeholder}</div>}
        {cel && <div className={'lvup' + (celOn ? ' show' : '')} role="status"><b>LEVEL UP!</b> Lv {cel.from} → {cel.to}</div>}
        {sp.look && <button className="reroll" title="New random hair, face and skin (gear is always the best for your job and level)" onClick={() => c.rerollLook()}>🎲</button>}
        {sp.look && <GearInfo look={sp.look} cls={c.identity.cls} level={c.sess?.level ?? c.identity.level} />}
      </div>
      <div className="stage-cap">{shown ? (fighting ? '⚔ Fighting' : 'Idle') : ' '}</div>
    </div>
  );
}

/**
 * The ⓘ under the dice: hover (or tap) to cover the stage with the gear the character is wearing, which is the best
 * for the job at this level, so it doubles as a shopping list. The catalog uses the renderer's (GMS) item ids, which
 * differ from Classic World's for some items, so each piece is matched to the Classic item by id, then by name; anything
 * still unmatched is marked "look only".
 */
function GearInfo({ look, cls, level }: { look: CharLook; cls: string; level: number | null }) {
  const [open, setOpen] = useState(false);
  const gear = lookGear(look);
  if (!gear.length) return null;
  return (
    // hover shows it (CSS); `open` is for a tap or the keyboard, and closes when the pointer or focus leaves
    <div className={'gearinfo' + (open ? ' open' : '')} onMouseLeave={() => setOpen(false)}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
      onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
      <button className="gearbtn" aria-label="Show the gear your character is wearing" aria-expanded={open} onClick={() => setOpen(o => !o)}>i</button>
      <div className="gearlist" role="dialog" aria-label="Gear">
        <div className="gearhead">Best gear for {cls || 'your job'}{level ? ` at Lv ${level}` : ''}</div>
        <div className="geargrid">{gear.map(g => <GearRow key={g.id} g={g} />)}</div>
      </div>
    </div>
  );
}

function GearRow({ g }: { g: GearPiece }) {
  // by name only: Classic numbers items differently, and 310 of the catalog's ids are a different item in Classic
  const classic = itemByName(g.name), inClassic = !!classic, icon = useItemIcon(classic?.id);
  return (
    <div className={'gearrow' + (inClassic ? '' : ' lookonly')} title={inClassic ? g.name : `${g.name}: not in the Classic World item list, it's here for the look`}>
      <span className="gearic">{icon && <img src={icon} alt="" />}</span>
      <span className="gearname">
        {inClassic ? <MeowdbLink name={g.name}>{g.name}</MeowdbLink> : <span>{g.name}</span>}
        <small>{g.slot}{g.level ? ` · Lv ${g.level}` : ''}{inClassic ? '' : ' · look only'}</small>
      </span>
    </div>
  );
}
