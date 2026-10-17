import { useEffect, useRef } from 'react';
import { useCtrl } from './hooks';

/**
 * The character as pixel art: a breathing idle loop, or the class attack (bow / sword / wand / stars / gun / punch)
 * while EXP or loot is coming in. Until the avatar exists, shows the live capture while it's being made.
 */
export function CharacterStage() {
  const c = useCtrl();
  const ref = useRef<HTMLCanvasElement>(null);
  const a = c.avatar, fighting = c.fighting;

  useEffect(() => {
    let i = 0;
    const scratch = document.createElement('canvas');
    const id = window.setInterval(() => {
      const cv = ref.current;
      if (!cv) return;
      const g = cv.getContext('2d')!;
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, cv.width, cv.height);
      const frames = c.avatarFrames();
      if (frames.length) {
        const fr = frames[i++ % frames.length], sc = Math.max(1, Math.floor(Math.min(cv.width / fr.width, cv.height / fr.height)));
        scratch.width = fr.width; scratch.height = fr.height;
        scratch.getContext('2d')!.putImageData(fr, 0, 0);
        g.drawImage(scratch, Math.round((cv.width - fr.width * sc) / 2), cv.height - fr.height * sc, fr.width * sc, fr.height * sc);
        return;
      }
      // still capturing: show the live crop softly
      const live = c.spriteFrames();
      if (!live.length) return;
      const fr = live[i++ % live.length];
      scratch.width = fr.width; scratch.height = fr.height;
      scratch.getContext('2d')!.putImageData(fr, 0, 0);
      g.globalAlpha = 0.55;
      g.drawImage(scratch, (cv.width - fr.width * 1.6) / 2, cv.height - fr.height * 1.6, fr.width * 1.6, fr.height * 1.6);
      g.globalAlpha = 1;
    }, fighting ? 90 : 170);
    return () => clearInterval(id);
  }, [c, fighting, a]);

  const caption = a ? (fighting ? '⚔ Fighting' : 'Idle')
    : !c.sess ? 'Start a session — your pixel character is made from the capture'
    : c.spriteState === 'searching' ? `Looking for “${c.identity.name || '?'}” on screen…`
    : c.spriteState === 'lost' ? 'Character off screen'
    : `Making your pixel character… (${Math.min(c.sprite.sampleCount, 8)}/8 views — moving around helps)`;

  return (
    <div className="stage">
      <canvas ref={ref} width={300} height={190} />
      <div className="stage-cap">
        {caption}
        {a && <>
          <button className="sm" title="Make a new pixel character from the next good frames" onClick={() => c.retakeAvatar()}>↻ Retake</button>
          <button className="sm" title="Flip which way the character faces (attacks fire that way)" onClick={() => c.setFacing(a.facing === 'left' ? 'right' : 'left')}>⇄ Flip</button>
        </>}
      </div>
    </div>
  );
}
