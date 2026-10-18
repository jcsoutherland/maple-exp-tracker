/**
 * Frame source: a live window capture (getDisplayMedia) or a recorded gameplay video for testing.
 * Frames are read straight from a hidden <video>; capture runs at up to 30 fps so the pickup log can be watched closely.
 */
export class Capture {
  readonly video: HTMLVideoElement;
  kind: 'screen' | 'file' | null = null;
  label = '';
  private stream: MediaStream | null = null;
  /** every stream this page ever opened: Stop must end them all, or the browser keeps showing "sharing" */
  private streams = new Set<MediaStream>();
  onEnded: (() => void) | null = null;
  /** sharing started/ended or frames arrived (for the UI) */
  onChange: (() => void) | null = null;

  constructor() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    // must stay "rendered" (not display:none) for frames to keep updating
    Object.assign(v.style, { position: 'fixed', left: '-10px', top: '-10px', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
    document.body.append(v);
    for (const ev of ['loadedmetadata', 'resize', 'emptied']) v.addEventListener(ev, () => this.onChange?.());
    this.video = v;
  }

  get ready() { return this.kind !== null && this.video.videoWidth > 0; }
  /** The browser is sharing a window with us right now (frames or not). */
  get sharing() { return this.kind === 'screen' && !!this.stream?.getVideoTracks().some(t => t.readyState === 'live'); }

  /** Throws DOMException NotAllowedError when the user cancels the picker. */
  async startScreen() {
    const st = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
    this.stop();
    this.streams.add(st);
    this.stream = st;
    this.kind = 'screen';
    this.label = st.getVideoTracks()[0]?.label || 'window';
    this.video.removeAttribute('src');
    this.video.srcObject = st;
    st.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.streams.delete(st);
      if (this.stream !== st) return; // an older share, already replaced
      this.stream = null; this.kind = null; this.video.srcObject = null;
      this.onEnded?.(); this.onChange?.();
    });
    this.video.play().catch(() => undefined); // a rejected play() doesn't stop frames from arriving
    this.onChange?.();
    return this.waitFrame();
  }

  async useFile(file: File, rate = 1) {
    this.stop();
    this.kind = 'file';
    this.label = file.name;
    this.video.src = URL.createObjectURL(file);
    this.video.playbackRate = rate;
    this.video.onended = () => this.onEnded?.();
    await this.video.play();
    return this.waitFrame();
  }

  /** End any capture: every track of every stream, and whatever the video element still holds. */
  stop() {
    const held = this.video.srcObject instanceof MediaStream ? [this.video.srcObject] : [];
    for (const s of [...this.streams, ...held]) s.getTracks().forEach(t => t.stop());
    this.streams.clear();
    this.stream = null;
    this.video.srcObject = null;
    if (this.video.src.startsWith('blob:')) URL.revokeObjectURL(this.video.src);
    this.video.removeAttribute('src');
    this.kind = null;
    this.onChange?.();
  }

  waitFrame(ms = 5000): Promise<boolean> {
    return new Promise(res => {
      const t0 = Date.now();
      const chk = () => (this.video.videoWidth > 0 ? res(true) : Date.now() - t0 > ms ? res(false) : setTimeout(chk, 100));
      chk();
    });
  }

  /** Full-resolution copy of the current frame. */
  snapshot(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.video.videoWidth; c.height = this.video.videoHeight;
    c.getContext('2d')!.drawImage(this.video, 0, 0);
    return c;
  }
}
