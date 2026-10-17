import { Capture } from '../core/capture';
import { classLook, LOOK_V, rollLook, SpriteLoader, type CharLook } from '../core/avatar/msio';
import { REGION_DEFS, type Region, type RegionKey, type Settings } from '../core/config';
import { canonItem, canonMap, loadOsms, mapsReady, osmsReady } from '../core/data/osms';
import { enhanceText, fixIL, logLineCanvas, logPreviewCanvas, logScan, newLineCount, prepRegion, regionSignature, slotSignature, type FrameSource, type LogScan } from '../core/imaging';
import type { OcrEngine } from '../core/ocr/engine';
import { TesseractEngine } from '../core/ocr/tesseract';
import { cleanMap, cleanName, lineAmount, lineKind, lineQuality, matchClass, parseExp, parseLevel, parsePair } from '../core/parse';
import { elapsed, finalize, newSession, type SavedSession, type Session } from '../core/session';
import * as store from '../core/storage';
import { Ticker } from '../core/ticker';
import { Tracker } from '../core/tracker';
import { normLine, sim } from '../core/util';

export interface Identity {
  name: string; cls: string; level: number | null;
  /** the user typed the name: screen reading never replaces it */
  nameTyped?: boolean;
  /** for the rolled character look (0 male, 1 female) */
  gender?: 0 | 1;
}
export interface OcrTestRow { key: RegionKey | 'log'; label: string; color: string; img: string; raw: string; parsed: string }

/**
 * Owns capture, OCR and the tracker, and runs each read on its own cadence:
 *  - pickup log: pixel-change check at ~15 Hz on the newest line; OCR only when a line appears (plus a periodic re-read)
 *  - HP/MP every barsMs, EXP every expMs
 *  - map: every mapMs if the title pixels changed, and whenever another mapExpStep EXP has been earned
 *  - name/class once per session; level at session start and after each detected level-up
 * The UI subscribes for change notifications; nothing here touches React.
 */

/** Map title text: cleaned, or — when cleaning rejects it (a stray symbol like "{ine 2") — raw if it still matches a real map. */
const mapText = (raw: string) => {
  const last = (raw.split('\n').pop() || '').trim();
  return cleanMap(raw) ?? (canonMap(last) ? last : null);
};

export class Controller {
  readonly capture = new Capture();
  engine: OcrEngine = new TesseractEngine();
  ocrState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  settings: Settings = store.loadSettings();
  regions: Record<RegionKey, Region> = store.loadRegions();
  identity: Identity = { name: '', cls: '', level: null };
  sess: Session | null = null;
  tracker: Tracker | null = null;
  lastFinished: SavedSession | null = null;
  historyVersion = 0;
  /** reads/sec of the pickup-log watcher and OCR calls, for the performance readout */
  stats = { logChecks: 0, ocrCalls: 0, lastTickMs: 0 };

  private ticker = new Ticker();
  private listeners = new Set<() => void>();
  private version = 0;
  private busy = { log: false, bars: false, exp: false, map: false };
  private lastLog: LogScan | null = null;
  private slotCache = new Map<number, string>();
  /** recently counted log lines (normalised text), for the fallback text check */
  private counted: { n: string; t: number }[] = [];
  /** per visible log line (bottom-up, aligned with lastLog.slots): counted yet, OCR attempts */
  private logLines: { done: boolean; tries: number; lastTry: number; guess: boolean }[] = [];
  private mapSig = 0;
  private mapExpAt = 0;
  private recent: [number, number][] = [];
  private lastTimeline = 0;
  private lastSave = 0;
  private scratch = { sig: document.createElement('canvas') };

  constructor() {
    const ch = store.loadChars(), last = store.loadSessions().slice(-1)[0];
    if (last) this.identity = { name: last.char, cls: ch[last.char]?.cls || last.cls, level: ch[last.char]?.level ?? last.level };
    // whatever the user last typed/confirmed wins over history
    const saved = store.loadIdentity();
    if (saved?.name) this.identity = { ...this.identity, ...saved, level: saved.level ?? ch[saved.name]?.level ?? this.identity.level };
    const act = store.loadActive();
    if (act) { // recover an unfinished session (paused) after a crash or closed tab
      act.paused = true;
      this.sess = act;
      this.tracker = this.makeTracker(act);
      this.tracker.event('info', 'Recovered unfinished session (paused)');
    }
    this.capture.onEnded = () => { if (this.sess && !this.sess.paused) this.togglePause(); this.notify(); };
    loadOsms().then(() => this.notify());
    this.loadLook();
  }

  // ---------- subscription ----------
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;
  notify() { this.version++; this.listeners.forEach(l => l()); }

  // ---------- setup ----------
  async initOcr() {
    if (this.ocrState === 'ready' || this.ocrState === 'loading') return;
    this.ocrState = 'loading'; this.notify();
    try { await this.engine.init(); this.ocrState = 'ready'; } catch (e) { console.error(e); this.ocrState = 'error'; }
    this.notify();
  }
  /** Stop sharing the game window (pauses a running session). */
  stopCapture() {
    if (this.sess && !this.sess.paused) this.togglePause();
    this.capture.stop();
    this.capture.video.srcObject = null;
    this.notify();
  }
  async shareScreen() { const ok = await this.capture.startScreen(); this.initOcr(); this.notify(); return ok; }
  async useVideo(file: File, rate: number) { const ok = await this.capture.useFile(file, rate); this.initOcr(); this.notify(); return ok; }
  setRegion(k: RegionKey, r: Partial<Region>) { this.regions = { ...this.regions, [k]: { ...this.regions[k], ...r } }; store.saveRegions(this.regions); this.notify(); }
  resetRegions() { localStorage.removeItem('met.regions'); this.regions = store.loadRegions(); this.notify(); }
  updateSettings(p: Partial<Settings>) {
    this.settings = { ...this.settings, ...p };
    store.saveSettings(this.settings);
    if (this.sess && !this.sess.paused) this.startTimers();
    this.notify();
  }
  setIdentity(p: Partial<Identity>) {
    const before = this.identity;
    this.identity = { ...this.identity, ...p };
    store.saveIdentity(this.identity);
    if (this.identity.name !== before.name || classLook(this.identity.cls) !== classLook(before.cls)) {
      if (this.sess) this.ensureLook(); else this.loadLook();
    } else if ((this.identity.gender ?? 0) !== (before.gender ?? 0) && (this.sess || this.sprites.look)) this.ensureLook(); // new look in that gender
    if (this.sess) { if (p.name) this.sess.char = p.name; if (p.cls !== undefined) this.sess.cls = p.cls; if (p.level) { this.sess.level = p.level; this.sess.levelStart ??= p.level; } }
    this.notify();
  }

  private makeTracker(s: Session) {
    return new Tracker(s, {
      hpMin: () => this.settings.hpMin, mpMin: () => this.settings.mpMin,
      canonItem: raw => canonItem(raw), canonMap: raw => canonMap(raw), itemsKnown: osmsReady, mapsKnown: mapsReady,
    });
  }
  private get canRun() { return !!this.sess && !this.sess.paused && this.capture.ready && this.ocrState === 'ready'; }
  private read(key: RegionKey, src: FrameSource) {
    const def = REGION_DEFS[key], p = prepRegion(src, this.regions[key], def);
    if (!p.ink) return Promise.resolve('');
    this.stats.ocrCalls++;
    return this.engine.read(p.canvas, def.engine === 'num' ? 'num' : 'line');
  }

  /** Read name / class / level from screen (once per session, or on demand). */
  async identify() {
    if (!this.capture.ready || this.ocrState !== 'ready') return null;
    const v = this.capture.video;
    const [name0, c, lv] = await Promise.all([this.readName(), this.read('cls', v), this.readLevel()]);
    const ch = store.loadChars();
    // a near-exact match to a character seen before is that character (old misreads must not pull it back)
    let name = name0;
    if (name) { const known = Object.keys(ch).map(k => ({ k, s: sim(k, name!) })).sort((a, b) => b.s - a.s)[0]; if (known && known.s >= 0.85) name = known.k; }
    const id = this.identity;
    // levels never go down: a lower read needs all three frames to agree (e.g. to correct a level typed too high)
    const level = lv && (lv.level >= (id.level ?? 0) || lv.votes === 3) ? lv.level : null;
    const got = { name, cls: matchClass(c), level };
    this.setIdentity({
      // a confident read replaces a name the app guessed before, never one the user typed
      ...(got.name && (!id.name || (!id.nameTyped && got.name !== id.name)) ? { name: got.name } : {}),
      ...(got.cls ? { cls: got.cls } : !this.identity.cls && got.name && ch[got.name]?.cls ? { cls: ch[got.name].cls } : {}),
      ...(got.level ? { level: got.level } : {}),
    });
    return got;
  }

  /**
   * The character name (~9px tall): "zoom and enhance" (6× smooth upscale + Otsu threshold), OCR, then each i/l
   * checked against its pixels. Read on three frames a moment apart; a name needs two matching reads.
   */
  private async readName(): Promise<string | null> {
    const votes = new Map<string, number>();
    for (let k = 0; k < 3; k++) {
      if (k) await new Promise(r => setTimeout(r, 250));
      const e = enhanceText(this.capture.video, this.regions.name);
      const r = await this.engine.readChars(e.canvas, 'line');
      this.stats.ocrCalls++;
      const n = cleanName(fixIL(r.chars, e));
      if (n) votes.set(n, (votes.get(n) || 0) + 1);
    }
    const best = [...votes].sort((a, b) => b[1] - a[1])[0];
    return best && best[1] >= 2 ? best[0] : null;
  }

  /**
   * The level: the digits are cream on orange tiles of about the same brightness, so they're separated by colour
   * (weakest channel: orange has almost no blue), zoomed and enhanced, and read on three frames; two must agree.
   */
  private async readLevel(): Promise<{ level: number; votes: number } | null> {
    const votes = new Map<number, number>();
    for (let k = 0; k < 3; k++) {
      if (k) await new Promise(r => setTimeout(r, 200));
      const lv = parseLevel(await this.engine.read(enhanceText(this.capture.video, this.regions.level, 6, 'min', 130).canvas, 'num'));
      this.stats.ocrCalls++;
      if (lv) votes.set(lv, (votes.get(lv) || 0) + 1);
    }
    const best = [...votes].sort((a, b) => b[1] - a[1])[0];
    return best && best[1] >= 2 ? { level: best[0], votes: best[1] } : null;
  }

  // ---------- session ----------
  async start() {
    await this.identify(); // name / class / level once per session
    const { name, cls, level } = this.identity;
    this.sess = newSession(name, cls, level);
    this.tracker = this.makeTracker(this.sess);
    this.ensureLook();
    this.tracker.event('info', 'Session started');
    this.resetWatchers();
    this.startTimers();
    this.notify();
    this.tickExp(); this.tickMap(true);
  }
  private resetWatchers() {
    this.lastLog = null; this.slotCache.clear(); this.counted = []; this.logLines = []; this.mapSig = 0; this.mapExpAt = 0; this.recent = []; this.lastTimeline = 0;
  }
  togglePause() {
    const s = this.sess;
    if (!s) return;
    if (s.paused) { s.paused = false; s.resumeAt = Date.now(); this.tracker?.rebaseline(); this.resetWatchers(); this.tracker?.event('info', 'Resumed'); this.startTimers(); }
    else { s.activeMs += Date.now() - s.resumeAt; s.paused = true; this.autoPaused = false; this.tracker?.event('info', 'Paused'); this.ticker.set({ ui: [1000, () => this.notify()] }); }
    this.persist(true);
    this.notify();
  }
  stop(): SavedSession | null {
    const s = this.sess;
    if (!s) return null;
    this.ticker.stop();
    s.char = this.identity.name || s.char; s.cls = this.identity.cls || s.cls;
    const out = finalize(s, this.settings);
    store.saveSessions([...store.loadSessions(), out]);
    const ch = store.loadChars();
    ch[out.char] = { ...ch[out.char], cls: out.cls, level: out.level, last: out.end };
    store.saveChars(ch);
    store.saveActive(null);
    this.sess = null; this.tracker = null; this.lastFinished = out; this.historyVersion++;
    if (out.level) this.identity.level = out.level;
    this.notify();
    return out;
  }
  private persist(force = false) {
    const s = this.sess;
    if (!s || (!force && Date.now() - this.lastSave < 30000)) return;
    this.lastSave = Date.now();
    store.saveActive(s.paused ? s : { ...s, activeMs: elapsed(s), paused: true });
  }
  persistNow() { this.persist(true); }

  // ---------- scheduling ----------
  private startTimers() {
    const sc = this.settings.schedule;
    this.ticker.set({
      log: [sc.logWatchMs, () => this.tickLog()],
      bars: [sc.barsMs, () => this.tickBars()],
      exp: [sc.expMs, () => this.tickExp()],
      map: [Math.min(sc.mapMs, 2000), () => this.tickMap(false)],
      ui: [1000, () => { this.checkIdle(); this.persist(); this.notify(); }],
    });
  }

  private async tickLog() {
    if (!this.canRun || this.busy.log) return;
    this.busy.log = true;
    const t0 = performance.now();
    try {
      const v = this.capture.video, r = this.regions.log;
      const lo = logScan(v, r, r.thr - 30, document.createElement('canvas'));
      this.stats.logChecks++;
      const first = !this.lastLog;
      const { count, aligned } = newLineCount(this.lastLog, lo);
      this.lastLog = lo;
      const now = Date.now();
      // Follow each line as it scrolls up: new lines enter at slot 0 and push the rest up by `count`.
      // Lines already on screen when watching starts belong to before the session (done = true).
      const fresh = Array.from({ length: count }, () => ({ done: first, tries: 0, lastTry: 0, guess: !aligned && !first }));
      this.logLines = (aligned ? [...fresh, ...this.logLines] : fresh.concat(lo.slots.slice(count).map(() => ({ done: true, tries: 0, lastTry: 0, guess: false }))))
        .slice(0, lo.slots.length);
      // Read pending lines among the newest four; a line that doesn't parse is retried on later ticks (≤4 tries,
      // ≥250 ms apart) and counted the first time it does, so each line is counted once but gets several chances.
      const ready: string[] = [];
      let hi: LogScan | null = null;
      for (let i = Math.min(3, this.logLines.length - 1); i >= 0; i--) { // oldest first
        const ln = this.logLines[i];
        if (ln.done || ln.tries >= 4 || now - ln.lastTry < 250) continue;
        ln.tries++; ln.lastTry = now;
        const res = await this.readSlot(lo, i, () => (hi ??= logScan(v, r, r.thr, document.createElement('canvas'))));
        if (lineQuality(res) < 2) continue;
        ln.done = true;
        // a guessed alignment can re-present an old line as new: skip text that was counted moments ago
        if (ln.guess && this.counted.some(c => now - c.t < 6000 && sim(c.n, normLine(res)) >= 0.8)) continue;
        this.counted.push({ n: normLine(res), t: now });
        ready.push(res);
      }
      this.counted = this.counted.filter(c => now - c.t < 6000);
      if (ready.length) { this.tracker?.onLogLines(ready); this.markActive(); this.notify(); }
    } catch (e) { console.error(e); } finally { this.busy.log = false; this.stats.lastTickMs = performance.now() - t0; }
  }

  /**
   * OCR one log line slot. Text over dark scenery needs a low brightness cut-off and over bright walls a higher one:
   * read with the low one and retry with the high one only if the result doesn't parse. Results are cached by the
   * slot's text-pixel signature, so an unchanged line is never OCR'd twice.
   */
  private async readSlot(lo: LogScan, i: number, high: () => LogScan): Promise<string> {
    const slot = lo.slots[i], sig = slotSignature(lo, slot);
    const hit = this.slotCache.get(sig);
    if (hit !== undefined) return hit;
    this.stats.ocrCalls++;
    let t = await this.engine.read(logLineCanvas(lo, slot), 'line');
    if (lineQuality(t) < 2) {
      this.stats.ocrCalls++;
      const t2 = await this.engine.read(logLineCanvas(high(), slot), 'line');
      if (lineQuality(t2) > lineQuality(t)) t = t2;
    }
    this.slotCache.set(sig, t);
    if (this.slotCache.size > 60) this.slotCache.delete(this.slotCache.keys().next().value!);
    return t;
  }

  /** OCR the newest `count` lines of a scan (Setup → Test OCR). */
  async readLogLines(src: FrameSource, lo: LogScan, count = 4): Promise<string[]> {
    const out: string[] = [];
    let hi: LogScan | null = null;
    for (let i = 0; i < Math.min(count, lo.slots.length); i++)
      out.push(await this.readSlot(lo, i, () => (hi ??= logScan(src, this.regions.log, this.regions.log.thr, document.createElement('canvas')))));
    return out;
  }

  private async tickBars() {
    if (!this.canRun || this.busy.bars) return;
    this.busy.bars = true;
    try {
      const v = this.capture.video;
      const [h, m] = await Promise.all([this.read('hp', v), this.read('mp', v)]);
      this.tracker?.onBar('hp', parsePair(h));
      this.tracker?.onBar('mp', parsePair(m));
    } catch (e) { console.error(e); } finally { this.busy.bars = false; }
  }

  private async tickExp() {
    if (!this.canRun || this.busy.exp) return;
    this.busy.exp = true;
    try {
      const r = parseExp(await this.read('exp', this.capture.video));
      const s = this.sess, t = this.tracker;
      if (!r || !s || !t) return;
      const before = s.exp;
      const leveled = t.onExp(r);
      if (s.exp > before) this.markActive();
      if (leveled) { // level-up: confirm with the level digits
        this.identity.level = s.level;
        this.readLevel().then(r => { if (r && s.level && Math.abs(r.level - s.level) <= 1) s.level = this.identity.level = r.level; });
      }
      const el = elapsed(s);
      this.recent.push([el, s.exp]);
      while (this.recent.length && el - this.recent[0][0] > 600000) this.recent.shift();
      if (el - this.lastTimeline >= 30000) {
        s.timeline.push([+(el / 60000).toFixed(2), s.exp, s.mesos]);
        this.lastTimeline = el;
        if (s.timeline.length > 720) s.timeline = s.timeline.filter((_, i) => i % 2 === 0);
      }
      if (s.exp - this.mapExpAt >= this.settings.schedule.mapExpStep) this.tickMap(true);
      this.notify();
    } catch (e) { console.error(e); } finally { this.busy.exp = false; }
  }

  private lastMapRead = 0;
  private async tickMap(force: boolean) {
    if (!this.canRun || this.busy.map) return;
    if (!force && Date.now() - this.lastMapRead < this.settings.schedule.mapMs) return;
    const v = this.capture.video;
    const sig = regionSignature(v, this.regions.map, this.scratch.sig) ^ regionSignature(v, this.regions.mapBar, this.scratch.sig);
    this.lastMapRead = Date.now();
    // title pixels unchanged: same map — unless we couldn't tell which map it is, then keep trying
    if (!force && sig === this.mapSig && this.tracker?.mapCur) return;
    this.busy.map = true;
    try {
      this.mapSig = sig;
      this.mapExpAt = this.sess?.exp ?? 0;
      // minimap title (two lines: street, map) or, when the minimap is collapsed, its bar ('Street : Map')
      const [full, bar] = await Promise.all([this.read('map', v), this.read('mapBar', v)]);
      const fromBar = mapText((bar.split(':').pop() || '').trim()) ?? mapText(bar);
      const fromFull = mapText(full);
      const pick = [fromFull, fromBar].find(n => n && canonMap(n)) ?? fromFull ?? fromBar;
      if (pick && !canonMap(pick)) console.debug('map name not in the database:', pick);
      this.tracker?.onMap(pick);
      this.notify();
    } catch (e) { console.error(e); } finally { this.busy.map = false; }
  }

  /** EXP/hr over the whole session and over the last 10 minutes. */
  rates() {
    const s = this.sess, el = elapsed(s);
    const hr = s && el > 60000 ? s.exp / (el / 3.6e6) : null;
    let r10: number | null = null;
    if (this.recent.length > 1) {
      const a = this.recent[0], b = this.recent[this.recent.length - 1];
      if (b[0] - a[0] >= 60000) r10 = (b[1] - a[1]) / ((b[0] - a[0]) / 3.6e6);
    }
    return { el, hr, r10 };
  }

  // ---------- character ----------
  private lastActive = 0;
  /** Mark "fighting" (EXP or loot just came in) for the avatar's attack animation. */
  private markActive() { this.lastActive = Date.now(); }
  /** paused by the idle timer (resumes by itself when EXP moves) rather than by the user */
  autoPaused = false;

  /** Idle for `idlePauseSec` (no EXP or loot): pause, without counting the idle stretch as session time. */
  private checkIdle() {
    const s = this.sess, sec = this.settings.idlePauseSec;
    if (!s || s.paused || !sec) return;
    const quietSince = Math.max(this.lastActive, s.resumeAt);
    if (Date.now() - quietSince < sec * 1000) return;
    s.activeMs += quietSince - s.resumeAt;
    s.paused = true; this.autoPaused = true;
    this.tracker?.event('info', `Auto-paused (idle ${sec}s)`);
    // keep an eye on the EXP bar only, to resume as soon as it moves
    this.ticker.set({ ui: [1000, () => this.notify()], idle: [this.settings.schedule.expMs, () => this.watchIdle()] });
    this.persist(true);
    this.notify();
  }
  private busyIdle = false;
  private async watchIdle() {
    const s = this.sess, t = this.tracker;
    if (!s || !t || !s.paused || !this.autoPaused || this.busyIdle || !this.capture.ready || this.ocrState !== 'ready') return;
    this.busyIdle = true;
    try {
      const r = parseExp(await this.read('exp', this.capture.video));
      // only a real gain resumes: higher than before, and the % it implies matches the % shown (a misread digit doesn't)
      const tot = t.total;
      if (!r || t.exp == null || r.exp <= t.exp || (tot && Math.abs(r.exp * 100 / tot - r.pct) > 0.03)) return;
      // EXP moved: back to work. The EXP baseline is kept, so this gain still counts.
      s.paused = false; s.resumeAt = Date.now(); this.autoPaused = false;
      this.resetWatchers();
      t.event('info', 'Resumed (EXP moving again)');
      this.markActive();
      this.startTimers();
      this.tickExp();
      this.notify();
    } catch (e) { console.error(e); } finally { this.busyIdle = false; }
  }
  get fighting() { return Date.now() - this.lastActive < 4000; }
  /** The pixel-art explorer for the current job (idle / attack loops). */
  /** Real Maple sprite frames for the character's saved look (pixel art shows until they're in). */
  readonly sprites = new SpriteLoader();

  /** Load the character's saved look (if it suits the current job) and its frames. */
  private loadLook() {
    const look = store.loadChars()[this.identity.name]?.look;
    this.sprites.load(look && this.lookFits(look) ? look : null, () => this.onSpriteFrame());
  }
  /** Does a saved look still suit the character (current format, job branch and gender)? */
  private lookFits(l: CharLook) { return l.v === LOOK_V && l.branch === classLook(this.identity.cls) && l.gender === (this.identity.gender ?? 0); }
  /** A session starts with a look: roll a random one if the character has none that fits (job branch, gender). */
  private ensureLook(force = false) {
    const { name, cls, level } = this.identity;
    if (!name || name === 'Unknown') return;
    const cur = store.loadChars()[name]?.look;
    if (!force && cur && this.lookFits(cur)) { if (JSON.stringify(this.sprites.look) !== JSON.stringify(cur)) this.loadLook(); return; }
    const ch = store.loadChars();
    ch[name] = { ...ch[name], look: rollLook(cls, level, this.identity.gender ?? 0), thumb: undefined };
    store.saveChars(ch);
    this.tracker?.event('info', 'New character look rolled');
    this.loadLook();
  }
  /** Roll a different random look for the character (the dice button). */
  rerollLook() { this.ensureLook(true); }
  /** Keep a small still of the character for History once the first idle frame is in. */
  private onSpriteFrame() {
    const f = this.sprites.frames.idle[0], name = this.identity.name, ch = store.loadChars();
    if (f && name && ch[name]?.look && !ch[name].thumb) {
      const c = document.createElement('canvas'), h = Math.ceil(f.height / 2) + 1; // FeetCenter: the character is the top half
      c.width = f.width; c.height = h;
      c.getContext('2d')!.drawImage(f, 0, 0);
      ch[name] = { ...ch[name], thumb: c.toDataURL('image/png') };
      store.saveChars(ch);
      this.historyVersion++;
    }
    this.notify();
  }

  // ---------- diagnostics ----------
  /** Run every region once on a frame and return the prepared images and readings (Setup → Test OCR). */
  async testOcr(src: FrameSource): Promise<OcrTestRow[]> {
    const rows: OcrTestRow[] = [];
    for (const key of Object.keys(REGION_DEFS) as RegionKey[]) {
      const def = REGION_DEFS[key];
      if (key === 'log') {
        const r = this.regions.log, lo = logScan(src, r, r.thr - 30, document.createElement('canvas'));
        const saved = this.slotCache; this.slotCache = new Map();
        const lines = await this.readLogLines(src, lo);
        this.slotCache = saved;
        rows.push({ key, label: def.label, color: def.color, img: logPreviewCanvas(lo).toDataURL(), raw: lines.join(' ⏎ '),
          parsed: lines.slice().reverse().map(l => `${lineKind(l) ?? '?'}${lineAmount(l) ? ' +' + lineAmount(l) : ''}`).join(' ⏎ ') || '(no lines)' });
        continue;
      }
      if (key === 'level') { // the colour-aware reader used for the level
        const e = enhanceText(src, this.regions.level, 6, 'min', 130), raw = await this.engine.read(e.canvas, 'num');
        rows.push({ key, label: def.label, color: def.color, img: e.canvas.toDataURL(), raw, parsed: String(parseLevel(raw) ?? '✗') });
        continue;
      }
      if (key === 'name') { // the enhanced reader used for the name
        const e = enhanceText(src, this.regions.name), r = await this.engine.readChars(e.canvas, 'line');
        rows.push({ key, label: def.label, color: def.color, img: e.canvas.toDataURL(), raw: r.text, parsed: cleanName(fixIL(r.chars, e)) ?? '✗' });
        continue;
      }
      const p = prepRegion(src, this.regions[key], def);
      const raw = p.ink ? await this.engine.read(p.canvas, def.engine === 'num' ? 'num' : 'line') : '';
      let parsed: string;
      switch (key) {
        case 'hp': case 'mp': { const v = parsePair(raw); parsed = v ? v.join(' / ') : '✗'; break; }
        case 'exp': { const v = parseExp(raw); parsed = v ? `${v.exp.toLocaleString()} @ ${v.pct}%` : '✗'; break; }
        case 'map': case 'mapBar': { const c = mapText(key === 'mapBar' ? (raw.split(':').pop() || '').trim() : raw) ?? (key === 'mapBar' ? mapText(raw) : null); parsed = c ? (canonMap(c) ? `${canonMap(c)} ✓` : `${c} ✗ not a known map`) : '✗ (→ Cannot determine)'; break; }
        case 'cls': parsed = matchClass(raw) ?? '✗'; break;
        default: parsed = cleanName(raw) ?? '✗';
      }
      rows.push({ key, label: def.label, color: def.color, img: p.canvas.toDataURL(), raw, parsed });
    }
    return rows;
  }
}
