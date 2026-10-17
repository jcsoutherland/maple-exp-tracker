import { useEffect, useRef } from 'react';
import { classAvatar } from '../core/pixelart';
import { useCtrl } from './hooks';

/**
 * A job's pixel-art explorer, animated: the slow idle loop, or the class attack while `fighting`. Drawn at a
 * whole-number zoom with no smoothing, so every pixel (body, weapon, effects) stays the same size.
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

/** The Live tab's character: idle, or attacking while EXP or loot is coming in. */
export function CharacterStage() {
  const c = useCtrl(), fighting = c.fighting;
  return (
    <div className="stage">
      <AvatarCanvas cls={c.identity.cls} zoom={4} fighting={fighting} />
      <div className="stage-cap">{fighting ? '⚔ Fighting' : c.sess ? 'Idle' : 'Start a session to begin'}</div>
    </div>
  );
}
