/**
 * Frame source: a live window capture (getDisplayMedia) or a recorded gameplay video for testing.
 * Frames are read straight from a hidden <video>; capture runs at up to 30 fps so the pickup log can be watched closely.
 */
export class Capture {
  readonly video: HTMLVideoElement;
  kind: 'screen' | 'file' | null = null;
  label = '';
  private stream: MediaStream | null = null;
  onEnded: (() => void) | null = null;

  constructor() {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    // must stay "rendered" (not display:none) for frames to keep updating
    Object.assign(v.style, { position: 'fixed', left: '-10px', top: '-10px', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
    document.body.append(v);
    this.video = v;
  }

  get ready() { return this.kind !== null && this.video.videoWidth > 0; }

  /** Throws DOMException NotAllowedError when the user cancels the picker. */
  async startScreen() {
    const st = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
    this.stop();
    this.stream = st;
    this.kind = 'screen';
    this.label = st.getVideoTracks()[0]?.label || 'window';
    this.video.removeAttribute('src');
    this.video.srcObject = st;
    st.getVideoTracks()[0]?.addEventListener('ended', () => { this.kind = null; this.onEnded?.(); });
    this.video.play().catch(() => undefined); // a rejected play() doesn't stop frames from arriving
    return this.waitFrame();
  }

  async useFile(file: File, rate = 1) {
    this.stop();
    this.kind = 'file';
    this.label = file.name;
    this.video.srcObject = null;
    this.video.src = URL.createObjectURL(file);
    this.video.playbackRate = rate;
    this.video.onended = () => this.onEnded?.();
    await this.video.play();
    return this.waitFrame();
  }

  stop() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    if (this.video.src.startsWith('blob:')) URL.revokeObjectURL(this.video.src);
    this.kind = null;
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
