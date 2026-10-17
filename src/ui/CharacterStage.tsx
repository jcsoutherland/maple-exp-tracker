import { useEffect, useRef } from 'react';
import { useCtrl } from './hooks';

/**
 * The player's character, cut out of the live capture and animated: the idle loop normally, the attack loop while
 * EXP or loot is coming in. Frames come from the controller's SpriteLearner.
 */
export function CharacterStage({ size = 2 }: { size?: number }) {
  const c = useCtrl();
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let i = 0;
    const scratch = document.createElement('canvas');
    const id = window.setInterval(() => {
      const cv = ref.current;
      if (!cv) return;
      const frames = c.spriteFrames();
      const g = cv.getContext('2d')!;
      g.clearRect(0, 0, cv.width, cv.height);
      // floor shadow
      g.fillStyle = 'rgba(0,0,0,.35)';
      g.beginPath(); g.ellipse(cv.width / 2, cv.height - 10, cv.width * 0.22, 7, 0, 0, Math.PI * 2); g.fill();
      if (!frames.length) return;
      const fr = frames[i++ % frames.length];
      scratch.width = fr.width; scratch.height = fr.height;
      scratch.getContext('2d')!.putImageData(fr, 0, 0);
      g.imageSmoothingEnabled = false;
      const w = fr.width * size, h = fr.height * size;
      g.drawImage(scratch, (cv.width - w) / 2, cv.height - h - 4, w, h);
    }, c.fighting ? 120 : 220);
    return () => clearInterval(id);
  }, [c, size, c.fighting]);

  const state = c.spriteState, n = c.sprite.sampleCount;
  const caption = !c.sess ? 'Start a session to bring your character in'
    : state === 'searching' ? `Looking for “${c.identity.name || '?'}” on screen…`
    : state === 'lost' ? 'Character off screen'
    : !c.sprite.maskReady ? `Learning the background… (${Math.min(n, 8)}/8 views — moving around helps)`
    : c.fighting ? '⚔ Fighting' : 'Idle';
  return (
    <div className="stage">
      <canvas ref={ref} width={120 * size + 40} height={100 * size + 16} />
      <div className="stage-cap">{caption}</div>
    </div>
  );
}
