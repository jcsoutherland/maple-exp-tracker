import { Capture } from '../core/capture';
import { buildAnimations, classFamily, imageDataToUrl, pixelize, urlToImageData, type Animations, type Facing } from '../core/pixelart';
import { findTagCandidates, grabBox, spriteBox, SpriteLearner, tagOcrCanvas, TagTracker, toDataUrl, type Box } from '../core/character';
import { REGION_DEFS, type Region, type RegionKey, type Settings } from '../core/config';
import { canonItem, canonMap, loadOsms, monsterNames, osmsReady } from '../core/data/osms';
import { logLineCanvas, logPreviewCanvas, logScan, newLineCount, prepRegion, regionSignature, slotSignature, type FrameSource, type LogScan } from '../core/imaging';
import type { OcrEngine } from '../core/ocr/engine';
import { TesseractEngine } from '../core/ocr/tesseract';
import { cleanMap, cleanName, lineAmount, lineKind, lineQuality, matchClass, parseExp, parseLevel, parsePair } from '../core/parse';
import { elapsed, finalize, newSession, type SavedSession, type Session } from '../core/session';
import * as store from '../core/storage';
import { Ticker } from '../core/ticker';
import { Tracker } from '../core/tracker';
import { normLine, sim } from '../core/util';

export interface Identity { name: string; cls: string; level: number | null }
export interface OcrTestRow { key: RegionKey | 'log'; label: string; color: string; img: string; raw: string; parsed: string }

/**
 * Owns capture, OCR and the tracker, and runs each read on its own cadence:
 *  - pickup log: pixel-change check at ~15 Hz on the newest line; OCR only when a line appears (plus a periodic re-read)
 *  - HP/MP every barsMs, EXP every expMs
 *  - map: every mapMs if the title pixels changed, and whenever another mapExpStep EXP has been earned
 *  - name/class once per session; level at session start and after each detected level-up
 * The UI subscribes for change notifications; nothing here touches React.
 */
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
    if (this.identity.name) this.loadAvatar(this.identity.name);
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
    this.identity = { ...this.identity, ...p };
    store.saveIdentity(this.identity);
    if (p.cls !== undefined && this.avatar) this.avatar = { ...this.avatar, anim: buildAnimations(this.avatar.base, classFamily(this.identity.cls), this.avatar.facing) };
    if (p.name !== undefined && p.name !== this.avatar?.name) this.loadAvatar(p.name);
    if (this.sess) { if (p.name) this.sess.char = p.name; if (p.cls !== undefined) this.sess.cls = p.cls; if (p.level) { this.sess.level = p.level; this.sess.levelStart ??= p.level; } }
    this.notify();
  }

  private makeTracker(s: Session) {
    return new Tracker(s, {
      hpMin: () => this.settings.hpMin, mpMin: () => this.settings.mpMin,
      canonItem: raw => canonItem(raw), canonMap: raw => canonMap(raw), itemsKnown: osmsReady,
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
    const [n, c, l] = await Promise.all([this.read('name', v), this.read('cls', v), this.read('level', v)]);
    const ch = store.loadChars();
    // the status-bar name is ~9px tall and OCR confuses letters ('Flynny' → 'Flyriny'): snap to a known character
    let name = cleanName(n);
    if (name) { const known = Object.keys(ch).map(k => ({ k, s: sim(k, name!) })).sort((a, b) => b.s - a.s)[0]; if (known && known.s >= 0.6) name = known.k; }
    const got = { name, cls: matchClass(c), level: parseLevel(l) };
    this.setIdentity({
      ...(got.name && !this.identity.name ? { name: got.name } : {}),
      ...(got.cls ? { cls: got.cls } : !this.identity.cls && got.name && ch[got.name]?.cls ? { cls: ch[got.name].cls } : {}),
      ...(got.level ? { level: got.level } : {}),
    });
    return got;
  }

  // ---------- session ----------
  async start() {
    if (!this.identity.name) await this.identify();
    else if (!this.identity.level) { const l = parseLevel(await this.read('level', this.capture.video)); if (l) this.setIdentity({ level: l }); }
    const { name, cls, level } = this.identity;
    this.sess = newSession(name, cls, level);
    this.tracker = this.makeTracker(this.sess);
    this.tracker.event('info', 'Session started');
    this.snapSaved = 'none'; this.spriteState = 'searching';
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
    else { s.activeMs += Date.now() - s.resumeAt; s.paused = true; this.tracker?.event('info', 'Paused'); this.ticker.set({ ui: [1000, () => this.notify()] }); }
    this.persist(true);
    this.notify();
  }
  stop(): SavedSession | null {
    const s = this.sess;
    if (!s) return null;
    this.ticker.stop();
    s.char = this.identity.name || s.char; s.cls = this.identity.cls || s.cls;
    this.saveSpriteFrames(s.char);
    this.spriteState = 'off';
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
      sprite: [200, () => this.tickSprite()],
      ui: [1000, () => { this.persist(); this.notify(); }],
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
        this.read('level', this.capture.video).then(x => { const l = parseLevel(x); if (l && s.level && Math.abs(l - s.level) <= 1) s.level = this.identity.level = l; });
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
    if (!force && sig === this.mapSig) return; // title pixels unchanged: same map
    this.busy.map = true;
    try {
      this.mapSig = sig;
      this.mapExpAt = this.sess?.exp ?? 0;
      // minimap title (two lines: street, map) or, when the minimap is collapsed, its bar ('Street : Map')
      const [full, bar] = await Promise.all([this.read('map', v), this.read('mapBar', v)]);
      const fromBar = cleanMap((bar.split(':').pop() || '').trim());
      const fromFull = cleanMap(full);
      const pick = [fromFull, fromBar].find(n => n && canonMap(n)) ?? fromFull ?? fromBar;
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

  // ---------- character sprite ----------
  readonly sprite = new SpriteLearner();
  /** 'searching' until the name tag is found, then 'tracking' (or 'lost' while it's off screen) */
  spriteState: 'off' | 'searching' | 'tracking' | 'lost' = 'off';
  private tag: TagTracker | null = null;
  private tagMisses = 0;
  /** pending confirmation of a newly found tag (null = confirmed or none) */
  private tagCheck: { ok: number; tries: number; next: number } | null = null;
  private lastAcquire = 0;
  private lastActive = 0;
  private snapSaved: 'none' | 'raw' | 'cutout' = 'none';
  private busySprite = false;
  private spriteScratch = document.createElement('canvas');

  /** Mark "fighting" (EXP or loot just came in) for the sprite's attack animation. */
  private markActive() { this.lastActive = Date.now(); }
  get fighting() { return Date.now() - this.lastActive < 4000; }

  private async tickSprite() {
    const name = this.identity.name || this.sess?.char;
    if (!this.canRun || this.busySprite || !name || name === 'Unknown') return;
    if (this.avatar?.name === name) { this.spriteState = 'tracking'; return; } // avatar made: no need to keep tracking the character
    this.busySprite = true;
    try {
      const v = this.capture.video, now = Date.now();
      let box = this.tag ? this.tag.locate(v) : null;
      if (box) this.tagMisses = 0;
      else if (this.tag) this.tagMisses++;
      if (!box && now - this.lastAcquire > 3000) {
        this.lastAcquire = now;
        box = this.tag ? this.tag.locateAnywhere(v) : await this.acquireTag(v, name);
        if (box) this.tagMisses = 0;
      }
      if (box && this.tagCheck) { await this.confirmTag(v, box, name); if (this.tagCheck || !this.tag) box = null; }
      this.spriteState = box ? 'tracking' : this.tag && !this.tagCheck ? 'lost' : 'searching';
      if (!box) return;
      const sb = spriteBox(v, box.x + box.w / 2, box.y);
      if (!sb) return;
      this.sprite.add(grabBox(v, sb, this.spriteScratch), { x: box.x, y: box.y }, this.fighting, now);
      // automatic snapshot: the first crop at session start, replaced by a cut-out once the background is learned
      if (!this.avatar?.base && this.snapSaved === 'none') this.saveSnapshot(name);
      // one good idle frame → pixel-art avatar (kept across sessions until 'Retake')
      if (this.sprite.maskReady && (!this.avatar || this.avatar.name !== name) && !this.avatarBusy) {
        this.avatarBusy = true;
        try { if (store.loadChars()[name]?.pixel) await this.loadAvatar(name); else this.captureAvatar(name); } finally { this.avatarBusy = false; }
      }
    } catch (e) { console.error(e); } finally { this.busySprite = false; }
  }

  /** How well OCR'd tag text matches the player's name, beyond how well it matches any monster's name. */
  private nameScore(text: string, name: string) {
    const txt = text.toLowerCase().replace(/[^a-z0-9]/g, ''), want = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const best = (w: string) => {
      let s = 0, at = 0;
      for (let i = 0; i <= Math.max(0, txt.length - w.length + 1); i++)
        for (const L of [w.length - 1, w.length, w.length + 1]) { const v = sim(txt.slice(i, i + L), w); if (v > s) { s = v; at = i; } }
      return { s, at };
    };
    const me = best(want);
    const mob = Math.max(0, ...monsterNames().filter(m => m.length >= 4).map(m => best(m.toLowerCase().replace(/[^a-z0-9]/g, '')).s));
    // monster labels ("Black Pig" read as "Black Finny") must not pass for the player's tag
    return { ok: txt.length >= 3 && me.s >= 0.6 && me.s >= mob + 0.1, at: me.at, len: txt.length, want: want.length };
  }

  /** Find the player's name tag: OCR tag-like boxes and pick the one containing the character's name. */
  private async acquireTag(v: FrameSource, name: string): Promise<Box | null> {
    for (const b of findTagCandidates(v, this.spriteScratch, 8)) {
      this.stats.ocrCalls++;
      const m = this.nameScore(await this.engine.read(tagOcrCanvas(v, b), 'line'), name);
      if (!m.ok) continue;
      // keep only the name's part of the box (it can merge with a monster's label) so the template follows the player
      const x0 = b.x + Math.round(b.w * m.at / m.len), w = Math.min(b.w, Math.round(b.w * m.want / m.len) + 4);
      const tagBox = { x: Math.max(0, x0 - 2), y: b.y, w, h: b.h };
      this.tag = new TagTracker(tagBox, v);
      this.tagCheck = { ok: 0, tries: 0, next: Date.now() + 600 };
      return tagBox;
    }
    return null;
  }

  /** A new tag must read as the player's name once more before frames are trusted (OCR at this size is noisy). */
  private async confirmTag(v: FrameSource, box: Box, name: string) {
    const ck = this.tagCheck!;
    if (Date.now() < ck.next) return;
    ck.next = Date.now() + 700; ck.tries++;
    this.stats.ocrCalls++;
    if (this.nameScore(await this.engine.read(tagOcrCanvas(v, box), 'line'), name).ok) ck.ok++;
    if (ck.ok >= 1) this.tagCheck = null;
    else if (ck.tries >= 4) { this.tag = null; this.tagCheck = null; } // wasn't us
  }

  // ---------- pixel-art avatar ----------
  /** pixel-art version of the character with pre-rendered idle / class-attack loops */
  avatar: { name: string; base: ImageData; anim: Animations; facing: Facing } | null = null;
  private avatarBusy = false;

  /** Load the saved avatar for a character (if any) and build its animations for the current class. */
  async loadAvatar(name = this.identity.name) {
    const ch = store.loadChars()[name];
    if (!name || !ch?.pixel) { this.avatar = null; this.notify(); return; }
    const base = await urlToImageData(ch.pixel), facing = ch.facing ?? 'left';
    this.avatar = { name, base, facing, anim: buildAnimations(base, classFamily(this.identity.cls || ch.cls || ''), facing) };
    this.notify();
  }

  /** Make the avatar from the steadiest cut-out idle frame (once the background has been learned). */
  private captureAvatar(name: string) {
    const frames = this.sprite.idle.length >= 3 ? this.sprite.idle : [...this.sprite.idle, ...this.sprite.attack];
    const cuts = frames.map(f => this.sprite.cutout(f, true)).filter((c): c is ImageData => !!c);
    if (cuts.length < 2) return;
    // pick the frame whose silhouette size is the median: avoids frames where a stray patch of scenery got in
    const area = (c: ImageData) => { let n = 0; for (let i = 3; i < c.data.length; i += 4) if (c.data[i] > 128) n++; return n; };
    const sorted = cuts.map(c => ({ c, a: area(c) })).sort((x, y) => x.a - y.a);
    const base = pixelize(sorted[sorted.length >> 1].c, 48);
    const ch = store.loadChars();
    const facing = ch[name]?.facing ?? 'left';
    ch[name] = { ...ch[name], pixel: imageDataToUrl(base), snap: imageDataToUrl(base) };
    store.saveChars(ch);
    this.avatar = { name, base, facing, anim: buildAnimations(base, classFamily(this.identity.cls), facing) };
    this.historyVersion++;
    this.notify();
  }

  /** Throw away the avatar; a new one is made from the next good frames. */
  retakeAvatar() {
    const name = this.identity.name, ch = store.loadChars();
    if (ch[name]) { delete ch[name].pixel; store.saveChars(ch); }
    this.avatar = null;
    this.notify();
  }

  /** Which way the character faces in the picture (attacks fire that way). */
  setFacing(facing: Facing) {
    const a = this.avatar;
    if (!a) return;
    const ch = store.loadChars();
    ch[a.name] = { ...ch[a.name], facing };
    store.saveChars(ch);
    this.avatar = { ...a, facing, anim: buildAnimations(a.base, classFamily(this.identity.cls), facing) };
    this.notify();
  }

  /** Current loop to play: the class attack while EXP/loot is coming in, else idle. */
  avatarFrames(): ImageData[] { return this.avatar ? (this.fighting ? this.avatar.anim.attack : this.avatar.anim.idle) : []; }

  /** Frames for the UI: rendered with the cut-out (or a vignette), the attack loop while fighting. */
  spriteFrames(): ImageData[] {
    const list = this.fighting && this.sprite.attack.length >= 2 ? this.sprite.attack : this.sprite.idle.length ? this.sprite.idle : this.sprite.attack;
    return list.map(f => this.sprite.render(f));
  }

  private saveSnapshot(name: string) {
    const fr = this.sprite.idle[this.sprite.idle.length - 1] || this.sprite.attack[this.sprite.attack.length - 1];
    if (!fr) return;
    const ch = store.loadChars();
    ch[name] = { ...ch[name], snap: toDataUrl(this.sprite.render(fr)) };
    store.saveChars(ch);
    this.snapSaved = this.sprite.maskReady ? 'cutout' : 'raw';
    this.historyVersion++;
  }

  /** Keep a few animation frames with the character for History. */
  private saveSpriteFrames(name: string) {
    const enc = (l: typeof this.sprite.idle) => l.slice(-6).map(f => toDataUrl(this.sprite.render(f)));
    if (!this.sprite.idle.length && !this.sprite.attack.length) return;
    const ch = store.loadChars();
    ch[name] = { ...ch[name], sprite: { idle: enc(this.sprite.idle), attack: enc(this.sprite.attack), cutout: this.sprite.maskReady } };
    store.saveChars(ch);
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
      const p = prepRegion(src, this.regions[key], def);
      const raw = p.ink ? await this.engine.read(p.canvas, def.engine === 'num' ? 'num' : 'line') : '';
      let parsed: string;
      switch (key) {
        case 'hp': case 'mp': { const v = parsePair(raw); parsed = v ? v.join(' / ') : '✗'; break; }
        case 'exp': { const v = parseExp(raw); parsed = v ? `${v.exp.toLocaleString()} @ ${v.pct}%` : '✗'; break; }
        case 'level': parsed = String(parseLevel(raw) ?? '✗'); break;
        case 'map': case 'mapBar': { const c = cleanMap(key === 'mapBar' ? (raw.split(':').pop() || '').trim() : raw); parsed = c ? (canonMap(c) ? `${canonMap(c)} ✓` : c) : '✗ (→ Undefined)'; break; }
        case 'cls': parsed = matchClass(raw) ?? '✗'; break;
        default: parsed = cleanName(raw) ?? '✗';
      }
      rows.push({ key, label: def.label, color: def.color, img: p.canvas.toDataURL(), raw, parsed });
    }
    return rows;
  }
}
