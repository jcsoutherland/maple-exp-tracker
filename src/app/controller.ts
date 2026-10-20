import { Capture } from '../core/capture';
import { classLook, LOOK_V, randomVariant, rollLook, SpriteLoader, type CharLook } from '../core/avatar/msio';
import { anyOn, featureOn, HOTBAR_COLS, HOTBAR_ROWS, hudScale, REGION_DEFS, type Region, type RegionKey, type Settings, type UiRatio } from '../core/config';
import { potionByName } from '../core/potions';
import { fitQuickslot, GLYPHS, readSlotCount, SlotCounter } from '../core/potcount';
import { SlotWatch, slotStrip } from '../core/slotwatch';
import { crossRead, readSlotSprite } from '../core/itemno';
import { HotbarAuto, loadPotionIcons, scanSlots, type IconTpl, type ScanMemo } from '../core/hotbarscan';
/** how often the quickslot is checked for which potions it holds */
const HOTBAR_SCAN_MS = 2000;
/** the features the EXP bar is read for */
const EXP_FEATURES = ['expGain', 'expRate', 'expLost', 'levelGoal', 'kills', 'graphs', 'expByMap'] as const;
/** a potion sighting that isn't confirmed by then is dropped */
const PENDING_MAX_MS = 30_000;
import { allItems, canonItem, canonMap, dropsOnMap, loadOsms, mapsReady, maxMobExp, mobForItem, mobsSettled, onOsmsLoaded, osmsReady, osmsSettled } from '../core/data/osms';
import { ExpLineFilter, LineShapeFilter, LogAnchor, snapInk, snapLine, type LineSnap } from '../core/logqueue';
import { readLogSnap } from '../core/logread';
import { matchLine, matchSnap, nativeStrip, parenScore, type LineMatch, type NameLists } from '../core/logmatch';
import { LogFollower, type LogLine, type SlotToken } from '../core/logtrack';
import { enhanceText, fixIL, frameSize, gaugeFill, logPreviewCanvas, logScan, newLineCount, prepRegion, regionSignature, slotSignature, type FrameSource, type LogScan } from '../core/imaging';
import type { OcrEngine } from '../core/ocr/engine';
import { TesseractEngine } from '../core/ocr/tesseract';
import { PaddleEngine } from '../core/ocr/paddle';
import { cleanMap, cleanName, lineAmount, lineKind, lineQuality, matchClass, parseExp, parseLevel, parsePair } from '../core/parse';
import { elapsed, finalize, newSession, type SavedSession, type Session } from '../core/session';
import * as store from '../core/storage';
import { Ticker } from '../core/ticker';
import { Tracker } from '../core/tracker';
import { median, normLine, sim } from '../core/util';

/** a pickup-log line waiting to be (or being) read */
interface LogItem { snap: LineSnap; status: 'queued' | 'reading' | 'done' | 'failed'; tries: number; guess: boolean; /** the followed line it reads (Ideal ratio) */ line?: LogLine }
/** snapshots older than this are dropped unread, and the queue never holds more than LOG_QUEUE_MAX */
const LOG_MAX_AGE_MS = 30_000, LOG_QUEUE_MAX = 60, LOG_READERS = 2, LOG_WATCH_SLOTS = 8; // ≤60 × ~22 KB
/** the loading screen never waits longer than this on page load / session start */
const BOOT_MAX_MS = 12_000, START_MAX_MS = 8_000;

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
  /**
   * The pickup log's reader: PaddleOCR (a neural line recogniser, far better than Tesseract on small text over busy
   * scenery and effects), falling back to Tesseract if its model can't be loaded.
   */
  logEngine: OcrEngine = new PaddleEngine();
  ocrState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  settings: Settings = store.loadSettings();
  regions: Record<RegionKey, Region> = store.loadRegions(this.settings.uiRatio);
  identity: Identity = { name: '', cls: '', level: null };
  sess: Session | null = null;
  tracker: Tracker | null = null;
  lastFinished: SavedSession | null = null;
  historyVersion = 0;
  /** reads/sec of the pickup-log watcher and OCR calls, for the performance readout */
  stats = { logChecks: 0, ocrCalls: 0, logMatched: 0, lastTickMs: 0, expSkipped: 0, logDropped: 0, logBacklog: 0, guessSkipped: 0, logGuesses: 0, junkSkipped: 0 };

  private ticker = new Ticker();
  private listeners = new Set<() => void>();
  private version = 0;
  private busy = { log: false, bars: false, exp: false, map: false };
  private lastLog: LogScan | null = null;
  private slotCache = new Map<number, string>();
  /** recently counted log lines (normalised text), for the fallback text check */
  private counted: { n: string; t: number; h: number }[] = [];
  /** per visible log line (bottom-up, aligned with lastLog.slots): counted yet, OCR attempts */
  /** the log lines on screen, newest first, followed as they scroll; `pre` = already there before watching started */
  private logLines: { pre: boolean; guess: boolean; item: LogItem | null }[] = [];
  /** snapshots waiting to be read (oldest first) */
  private logQueue: LogItem[] = [];
  private reading = 0;
  private readonly expFilter = new ExpLineFilter();
  private readonly shapeFilter = new LineShapeFilter();
  /** where the newest pickup-log line sits, learned over many frames (the slot grid stays fixed on it) */
  private readonly logAnchor = new LogAnchor();
  /** optional diagnostics hook (the replay harness records why log lines were skipped) */
  debug?: (kind: string, info?: unknown) => void;
  private mapSig = 0;
  private mapExpAt = 0;
  private recent: [number, number][] = [];
  private lastTimeline = 0;
  private lastSave = 0;
  private scratch = { sig: document.createElement('canvas'), gauge: document.createElement('canvas'), slots: document.createElement('canvas') };

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
    this.capture.onEnded = () => {
      if (this.sess && !this.sess.paused) { this.togglePause(); this.tracker?.event('info', 'Window sharing ended: share it again and press Resume'); }
      this.notify();
    };
    this.capture.onChange = () => this.notify();
    loadOsms().then(() => this.notify());
    onOsmsLoaded(() => this.notify());
    setTimeout(() => this.notify(), BOOT_MAX_MS + 50); // let the loading screen time out even if nothing else changes
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
    const log = this.logEngine.init().catch(e => { console.warn('PaddleOCR unavailable, the log uses Tesseract', e); this.logEngine = this.engine; });
    try { await Promise.all([this.engine.init(), log]); this.ocrState = 'ready'; } catch (e) { console.error(e); this.ocrState = 'error'; }
    this.notify();
  }
  /** Stop sharing the game window (pauses a running session). */
  stopCapture() {
    if (this.sess && !this.sess.paused) this.togglePause();
    this.capture.stop();
    this.notify();
  }
  async shareScreen() { const ok = await this.capture.startScreen(); this.reloadRegions(); this.initOcr(); this.notify(); return ok; }
  async useVideo(file: File, rate: number) { const ok = await this.capture.useFile(file, rate); this.reloadRegions(); this.initOcr(); this.notify(); return ok; }
  setRegion(k: RegionKey, r: Partial<Region>) { this.regions = { ...this.regions, [k]: { ...this.regions[k], ...r } }; store.saveRegions(this.regions, this.settings.uiRatio); this.notify(); }
  resetRegions() { store.clearRegions(this.settings.uiRatio); this.reloadRegions(); this.notify(); }
  /** Switch to the regions of the game's other UI ratio (each keeps its own). */
  setUiRatio(ratio: UiRatio) { if (ratio !== this.settings.uiRatio) { this.updateSettings({ uiRatio: ratio }); this.reloadRegions(); this.notify(); } }
  /** the Ideal ratio's presets depend on the capture size, so they're laid out again once it's known */
  private reloadRegions() {
    const v = this.capture.video, ok = this.capture.ready;
    this.regions = store.loadRegions(this.settings.uiRatio, ok ? v.videoWidth : undefined, ok ? v.videoHeight : undefined);
  }
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
    else if (this.identity.level !== before.level && this.sprites.look) this.ensureLook(); // gear for the new level
    if (this.sess) { if (p.name) this.sess.char = p.name; if (p.cls !== undefined) this.sess.cls = p.cls; if (p.level) { this.sess.level = p.level; this.sess.levelStart ??= p.level; } }
    this.notify();
  }

  private makeTracker(s: Session) {
    return new Tracker(s, {
      hpMin: () => this.settings.hpMin, mpMin: () => this.settings.mpMin,
      canonItem: raw => canonItem(raw), canonMap: raw => canonMap(raw), itemsKnown: osmsReady, mapsKnown: mapsReady, maxMobExp, potsCounted: k => this.potsCounted(k), mobForDrop: (item, map) => mobForItem(item, map)?.name ?? null,
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

  // ---------- loading screen ----------
  private bootAt = Date.now();
  private booted = false;
  /** what a starting session is doing (shown on the loading screen), and since when */
  private starting: { label: string; at: number } | null = null;
  /**
   * What the Live dashboard is still waiting for, so it can show a loading screen instead of panels popping in one by
   * one: on page load the item / map and monster data, on session start the name / level read. The character isn't
   * waited for (its sprites can take a while from the renderer): its box is there at once and the character appears
   * in it when ready. Never longer than a few seconds: a slow site doesn't keep the dashboard hidden.
   */
  get loading(): { label: string; pct: number } | null {
    const now = Date.now();
    if (this.starting) {
      if (now - this.starting.at > START_MAX_MS) { this.starting = null; return null; }
      return { label: this.starting.label, pct: 50 };
    }
    if (this.booted) return null;
    const steps: [string, boolean][] = [['Loading item & map data', osmsSettled()], ['Loading monster data', mobsSettled()]];
    const left = steps.filter(s => !s[1]);
    if (!left.length || now - this.bootAt > BOOT_MAX_MS) { this.booted = true; return null; }
    return { label: left[0][0], pct: Math.round(100 * (steps.length - left.length) / steps.length) };
  }

  // ---------- session ----------
  async start() {
    this.starting = { label: 'Reading name, class and level', at: Date.now() }; this.notify();
    setTimeout(() => this.notify(), START_MAX_MS + 50);
    await this.identify().catch(e => console.error(e)); // name / class / level once per session
    const { name, cls, level } = this.identity;
    this.sess = newSession(name, cls, level);
    this.tracker = this.makeTracker(this.sess);
    this.starting = null;
    this.ensureLook();
    this.tracker.event('info', 'Session started');
    this.resetWatchers();
    this.startTimers();
    this.notify();
    this.tickExp(); this.tickMap(true);
  }
  private resetWatchers() {
    this.lastLog = null; this.follower = new LogFollower(); this.slotCache.clear(); this.counted = []; this.logLines = []; this.mapSig = 0; this.mapExpAt = 0; this.recent = []; this.lastTimeline = 0;
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
      gauge: [sc.gaugeMs, () => this.tickGauge()],
      exp: [sc.expMs, () => this.tickExp()],
      map: [Math.min(sc.mapMs, 2000), () => this.tickMap(false)],
      ui: [1000, () => { this.checkIdle(); this.persist(); this.notify(); }],
    });
  }

  /**
   * Watch the pickup log. This never waits on OCR: new lines are spotted with a cheap pixel comparison and copied out
   * of the frame at once (snapshots), then read from a queue by two OCR workers. EXP lines are recognised by shape
   * and skipped (the EXP bar counts EXP exactly), so a fast party log doesn't drown the meso / item lines.
   */
  private tickLog() {
    if (!this.canRun || this.busy.log || !anyOn(this.settings, 'mesos', 'drops')) return;
    this.busy.log = true;
    const t0 = performance.now();
    try {
      if (this.settings.uiRatio === 'ideal') { this.tickLogIdeal(); return; }
      const v = this.capture.video, r = this.regions.log;
      const lo = logScan(v, r, r.thr - 30, document.createElement('canvas'), this.logAnchor.value, this.settings.uiRatio);
      this.logAnchor.add(lo.detected, `${v.videoWidth}x${v.videoHeight}:${r.x},${r.y},${r.w},${r.h}`);
      this.stats.logChecks++;
      const first = !this.lastLog;
      const { count, aligned } = newLineCount(this.lastLog, lo);
      if (!aligned && !first && count) { this.stats.logGuesses++; this.debug?.('guess', count); }
      this.lastLog = lo;
      const now = Date.now();
      // Follow each line as it scrolls up: new lines enter at slot 0 and push the rest up by `count`.
      // Lines already on screen when watching starts belong to before the session.
      const fresh = Array.from({ length: count }, () => ({ pre: first, guess: !aligned && !first, item: null as LogItem | null }));
      this.logLines = (aligned ? [...fresh, ...this.logLines] : fresh.concat(lo.slots.slice(count).map(() => ({ pre: true, guess: false, item: null }))))
        .slice(0, lo.slots.length);
      // snapshot new lines; a line whose read failed gets a fresh snapshot (≤4 tries, ≥250 ms apart) while still visible
      let hi: LogScan | null = null;
      // the high-contrast scan only serves Tesseract's second try; PaddleOCR reads the original pixels
      const high = () => (this.logEngine.prefersRaw ? null : (hi ??= logScan(v, r, r.thr, document.createElement('canvas'), this.logAnchor.value, this.settings.uiRatio)));
      for (let i = Math.min(LOG_WATCH_SLOTS, this.logLines.length) - 1; i >= 0; i--) { // oldest first
        const ln = this.logLines[i];
        if (ln.pre) continue;
        if (!ln.item) {
          // a yellow line is EXP / party bonus: never queued, so a party's flood of them can't push item lines out
          if (lo.yellow?.[i]) { ln.item = { snap: snapLine(lo, null, lo.slots[i], now, true), status: 'done', tries: 1, guess: ln.guess }; this.stats.expSkipped++; this.debug?.('yellow', i); this.markActive(); continue; }
          const snap = snapLine(lo, high(), lo.slots[i], now);
          ln.item = { snap, status: 'queued', tries: 1, guess: ln.guess };
          // read in the game's own font first: no queue, no OCR (and a line half hidden by a player still reads)
          if (this.matchLog(ln.item)) continue;
          // not shaped like a log line (something moving behind the log): never read
          if (this.shapeFilter.isJunk(snap)) { ln.item.status = 'done'; this.stats.junkSkipped++; this.debug?.('junk', snap); continue; }
          this.logQueue.push(ln.item);
        }
        else if (ln.item.status === 'failed' && ln.item.tries < 4 && now - ln.item.snap.t >= 250) {
          ln.item.snap = snapLine(lo, high(), lo.slots[i], now, lo.yellow?.[i]); ln.item.tries++;
          if (!this.matchLog(ln.item)) { ln.item.status = 'queued'; this.logQueue.push(ln.item); }
        }
      }
      this.pumpLog();
    } catch (e) { console.error(e); } finally { this.busy.log = false; this.stats.lastTickMs = performance.now() - t0; }
  }

  /**
   * The log's line grid at the Ideal ratio, in log-region pixels: the newest line's text-cell top and where every
   * line's ")" ends. Seeded from where the log sits in its default box, then learned from the lines the font matcher
   * reads (each read line gives its exact row and edge).
   */
  private logGrid: { key: string; top0: number; xr: number; tops: number[]; xrs: number[]; misses: number } | null = null;
  private follower = new LogFollower();
  /** font-matcher results by slot image (an unchanged slot isn't read again) */
  private slotReads = new Map<number, LineMatch | null>();

  /**
   * Ideal ratio: the log is drawn pixel for pixel, so every line slot is read by the font matcher each tick (cached
   * while its pixels don't change) and the log is followed by the lines it recognises (LogFollower): a bright or moving
   * background can't fake new lines, and identical repeats still count. A new line the matcher can't read goes to OCR.
   */
  private tickLogIdeal() {
    const v = this.capture.video, r = this.regions.log;
    const lo = logScan(v, r, r.thr - 30, document.createElement('canvas'), null, 'ideal');
    this.stats.logChecks++;
    if (!lo.rgba || lo.X == null || lo.Y == null) return;
    const key = `${v.videoWidth}x${v.videoHeight}:${r.x},${r.y},${r.w},${r.h}`;
    // where the newest line sits in the default box: 29 px above its bottom, ")" 9 px in from its right
    if (this.logGrid?.key !== key) { this.logGrid = { key, top0: lo.H - 29, xr: lo.W - 9, tops: [], xrs: [], misses: 0 }; this.follower = new LogFollower(); }
    const G = this.logGrid, names = this.logNames(), now = Date.now(), P = 14;
    /** the slot's rows (region pixels, 3 above its text cell) as a native strip, read by the matcher */
    const read = (j: number) => {
      const r0 = G.top0 - P * j - 3, r1 = r0 + 20;
      if (r0 < 0 || r1 > lo.H) return null;
      const strip = nativeStrip(lo.rgba!.subarray(r0 * lo.W * 4, r1 * lo.W * 4), lo.W, r1 - r0, lo.X!, lo.Y! + r0, 1);
      let h = 2166136261;
      for (let i = 0; i < strip.M.length; i++) if (strip.M[i]) h = Math.imul(h ^ i, 16777619);
      h = (h ^ (G.xr << 20)) >>> 0;
      let m = this.slotReads.get(h);
      if (m === undefined) {
        m = matchLine(strip, names, G.xr, undefined, [2, 3, 4]);
        this.slotReads.set(h, m);
        if (this.slotReads.size > 400) this.slotReads.delete(this.slotReads.keys().next().value!);
      }
      return { m, strip, r0 };
    };
    const tokens: SlotToken[] = [];
    let matched = 0;
    for (let j = 0; j < 6; j++) {
      const s = read(j);
      if (!s) { tokens.push({ text: null, lum: 0, ink: false }); continue; }
      if (s.m) {
        matched++;
        G.tops.push(s.r0 + s.m.y + P * j); G.xrs.push(s.m.xr);
        if (G.tops.length > 60) { G.tops.shift(); G.xrs.shift(); }
      }
      // brightness is measured on this frame: a cached read can come from when the line was brighter (a fading line's
      // text pixels stay the same set while they dim)
      let lum = 0, n = 0;
      const y0 = (s.m?.y ?? 3) + 3;
      for (let y = y0; y < Math.min(s.strip.h, y0 + 12); y++) for (let x = 0; x < s.strip.w; x++) if (s.strip.M[y * s.strip.w + x]) { lum += s.strip.L[y * s.strip.w + x]; n++; }
      lum = n ? lum / n : 0;
      tokens.push({ text: s.m?.text ?? null, lum, ink: !!s.m || parenScore(s.strip, G.xr, [2, 3, 4]) >= 0.6 });
    }
    // a line read below the newest slot: the grid sits a line too high (the default box was moved)
    const below = read(-1);
    if (below?.m) { G.top0 += P; G.tops = []; G.xrs = []; this.follower = new LogFollower(); return; }
    // learn the grid from the lines read: the most common row and edge
    if (G.tops.length >= 8 && G.tops.length % 4 === 0) {
      const mode = (a: number[]) => { const c = new Map<number, number>(); for (const x of a) c.set(x, (c.get(x) || 0) + 1); return [...c].sort((p, q) => q[1] - p[1])[0][0]; };
      const t = mode(G.tops), x = mode(G.xrs);
      if (t !== G.top0 || x !== G.xr) { G.top0 = t; G.xr = x; }
    }
    // nothing read for a long while although the log shows lines: look for them anywhere in the box
    G.misses = matched ? 0 : G.misses + 1;
    if (G.misses >= 45 && tokens.some(t => t.ink)) { G.misses = 0; this.findLogGrid(lo, names); }

    this.debug?.('tok', tokens.map(t => (t.text ? t.text.replace(/^You have gained mesos /, 'M').replace(/^You received EXP /, 'E').replace(/^Bonus EXP for PARTY /, 'B').replace(/ x1 earned. /, '') + '@' + Math.round(t.lum) : t.ink ? '?@' + Math.round(t.lum) : '.')).join(' | '));
    const { added, identified } = this.follower.update(tokens);
    if (added.length) this.debug?.('newLines', added.length);
    for (const ln of identified) this.countFollowed(ln);
    for (const ln of added) ln.born = this.stats.logChecks;
    // new lines the matcher hasn't read after ~1 s (covered, or an unknown item): OCR them, as the old reader would.
    // Waiting gives the matcher its chance first: a player standing in front usually moves on.
    this.follower.lines.forEach((ln, j) => {
      if (!ln || ln.pre || ln.text != null || this.stats.logChecks - (ln.born ?? 0) < 12) return;
      const it = ln.item as LogItem | undefined;
      if (it && (it.status !== 'failed' || it.tries >= 3 || now - it.snap.t < 500)) return;
      const a = Math.max(0, G.top0 - P * j), snap = snapLine(lo, null, [a, Math.min(lo.H, a + P + 3)], now);
      if (it) { it.snap = snap; it.tries++; it.status = 'queued'; this.logQueue.push(it); return; }
      const item: LogItem = { snap, status: 'queued', tries: 1, guess: false, line: ln };
      ln.item = item;
      this.logQueue.push(item);
    });
    this.pumpLog();
  }

  /** Search the whole log box for lines to set the grid from (when the default box has been moved). */
  private findLogGrid(lo: LogScan, names: NameLists) {
    const G = this.logGrid!;
    for (let r0 = 0; r0 + 20 <= lo.H; r0 += 7) {
      const strip = nativeStrip(lo.rgba!.subarray(r0 * lo.W * 4, (r0 + 20) * lo.W * 4), lo.W, 20, lo.X!, lo.Y! + r0, 1);
      const m = matchLine(strip, names);
      // the lowest line read is the newest one
      if (m && r0 + m.y > G.top0 - 7) { G.top0 = r0 + m.y; G.xr = m.xr; }
      else if (m && G.tops.length === 0) { G.top0 = r0 + m.y; G.xr = m.xr; }
    }
    this.debug?.('grid', [G.top0, G.xr]);
    this.follower = new LogFollower();
  }

  /** A followed line has been read (by the matcher or OCR): count it once (EXP lines only show activity). */
  private countFollowed(ln: LogLine) {
    const t = ln.text!;
    const it = ln.item as LogItem | undefined;
    if (it && it.status !== 'done') it.status = 'done'; // read before its OCR turn came: drop that
    this.markActive();
    if (lineKind(t) === 'exp' || t.startsWith('Bonus EXP')) { this.stats.expSkipped++; return; }
    this.stats.logMatched++;
    this.debug?.('match', t);
    this.tracker?.onLogLines([t]);
    this.notify();
  }

  /** Feed queued snapshots to the OCR workers (oldest first), skipping EXP lines and dropping stale ones. */
  private pumpLog() {
    const now = Date.now();
    while (this.logQueue.length > LOG_QUEUE_MAX || (this.logQueue.length && now - this.logQueue[0].snap.t > LOG_MAX_AGE_MS)) {
      this.logQueue.shift()!.status = 'done'; this.stats.logDropped++;
    }
    while (this.reading < LOG_READERS && this.logQueue.length) {
      const q = this.logQueue.shift()!;
      if (this.expFilter.isExp(q.snap)) { q.status = 'done'; this.stats.expSkipped++; this.debug?.('expShape', q.snap); this.markActive(); continue; }
      this.reading++;
      this.readSnap(q).catch(e => console.error(e)).finally(() => { this.reading--; this.pumpLog(); });
    }
    this.stats.logBacklog = this.logQueue.length;
  }

  private async readSnap(q: LogItem) {
    q.status = 'reading';
    const { ink, hash } = snapInk(q.snap);
    if (ink < 25 * q.snap.f * q.snap.f) { q.status = 'failed'; return; } // (almost) no text in the slot yet
    let t = this.slotCache.get(hash); // an identical line image reads the same: never OCR it twice
    if (t === undefined) {
      t = await readLogSnap(this.logEngine, q.snap, this.shapeFilter.edge, () => this.stats.ocrCalls++);
      this.slotCache.set(hash, t);
      if (this.slotCache.size > 80) this.slotCache.delete(this.slotCache.keys().next().value!);
    }
    if (lineQuality(t) < 2) { q.status = 'failed'; this.debug?.('unreadable', t); return; } // retried from a new snapshot while the line is on screen
    if (q.line) { // Ideal ratio: a followed line, unless the matcher has read it meanwhile
      q.status = 'done';
      if (q.line.text == null) { q.line.text = t; q.line.ocr = true; this.countFollowed(q.line); }
      return;
    }
    this.countLine(q, t, hash);
  }

  /** item names the log matcher tries: the current map's monsters' drops first, then every item (by width) */
  private allItemNames: { from: unknown; names: string[] } = { from: null, names: [] };
  private logNames(): NameLists {
    const all = allItems();
    if (this.allItemNames.from !== all) this.allItemNames = { from: all, names: all.map(i => i.name) };
    return { likely: dropsOnMap(this.tracker?.mapCur ?? null), all: this.allItemNames.names };
  }

  /**
   * Read a snapshot by matching the game's font (see logmatch.ts). True when it did: the line is then done, counted or
   * (an EXP line) skipped. False leaves it to OCR.
   */
  private matchLog(q: LogItem): boolean {
    const m = matchSnap(q.snap, this.logNames(), this.shapeFilter.edge);
    if (!m) return false;
    this.stats.logMatched++;
    this.debug?.('match', m.text);
    if (m.kind === 'exp') {
      q.status = 'done'; this.stats.expSkipped++;
      this.expFilter.learn(q.snap, true); this.shapeFilter.learn(q.snap);
      q.snap = { ...q.snap, lo: new Float32Array(0), hi: null, rgb: null };
      this.markActive();
      return true;
    }
    this.countLine(q, m.text, snapInk(q.snap).hash);
    return true;
  }

  /** A line has been read (text `t`, pixel hash `hash`): count it unless it's a re-presented old line. */
  private countLine(q: LogItem, t: string, hash: number) {
    q.status = 'done';
    this.expFilter.learn(q.snap, lineKind(t) === 'exp');
    this.shapeFilter.learn(q.snap);
    q.snap = { ...q.snap, lo: new Float32Array(0), hi: null, rgb: null }; // read: free the pixels
    const now = Date.now();
    // a guessed alignment can re-present an old line as new: skip text that was counted moments ago
    // (only within 2 s: a re-presented line shows up a frame or two later, while picking up the same item again takes
    // longer; a 6 s window dropped back-to-back Tablecloths in a party)
    // the same line image (pixel hash), not just similar text: '+14 mesos' and '+16 mesos' read about the same but are
    // two pickups, and a party's meso lines come seconds apart
    if (q.guess && this.counted.some(c => now - c.t < 2000 && c.h === hash)) { this.stats.guessSkipped++; this.debug?.('guessDup', t); return; }
    this.counted = this.counted.filter(c => now - c.t < 2000);
    this.counted.push({ n: normLine(t), t: now, h: hash });
    this.tracker?.onLogLines([t]);
    this.markActive();
    this.notify();
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
    const eng = this.logEngine;
    const t = await readLogSnap(eng, snapLine(lo, eng.prefersRaw ? null : high(), slot, 0), this.shapeFilter.edge, () => this.stats.ocrCalls++);
    this.slotCache.set(sig, t);
    if (this.slotCache.size > 60) this.slotCache.delete(this.slotCache.keys().next().value!);
    return t;
  }

  /** OCR the newest `count` lines of a scan (Setup → Test OCR). */
  async readLogLines(src: FrameSource, lo: LogScan, count = 4): Promise<string[]> {
    const out: string[] = [];
    let hi: LogScan | null = null;
    for (let i = 0; i < Math.min(count, lo.slots.length); i++)
      out.push(await this.readSlot(lo, i, () => (hi ??= logScan(src, this.regions.log, this.regions.log.thr, document.createElement('canvas'), this.logAnchor.value, this.settings.uiRatio))));
    return out;
  }

  private async tickBars() {
    if (!this.canRun || this.busy.bars || !featureOn(this.settings, 'potions')) return;
    this.busy.bars = true;
    try {
      const v = this.capture.video;
      const [h, m] = await Promise.all([this.read('hp', v), this.read('mp', v)]);
      this.tracker?.onBar('hp', parsePair(h));
      this.tracker?.onBar('mp', parsePair(m));
    } catch (e) { console.error(e); } finally { this.busy.bars = false; }
  }

  /** HP / MP gauge fill, by pixel colour (~10×/s, well under a millisecond): what potions are counted from. */
  gaugeLast: { hp: number | null; mp: number | null } = { hp: null, mp: null };
  private tickGauge() {
    if (!this.canRun) return;
    const v = this.capture.video;
    if (++this.gaugeN % 3 === 0 && featureOn(this.settings, 'potions')) this.watchCounts(v); // ~3×/s
    const now = Date.now();
    for (const k of ['hp', 'mp'] as const) {
      const f = gaugeFill(v, this.regions[k === 'hp' ? 'hpGauge' : 'mpGauge'], k, this.scratch.gauge), prev = this.gaugeLast[k];
      // the bar moved (or flashed, which it does on every change): a potion count drop is only believed after one
      if (f == null || prev == null || Math.abs(f - prev) >= 0.008) this.gaugeMovedAt[k] = now;
      this.gaugeLast[k] = f;
      this.tracker?.onGauge(k, f);
    }
  }
  /** when each gauge last moved or flashed */
  private gaugeMovedAt = { hp: 0, mp: 0 };

  private gaugeN = 0;
  /** per hotbar slot holding a potion: its count, read and checked by a SlotCounter */
  private counts = new Map<number, SlotCounter>();
  /** per hotbar potion slot: its picture, watched for changes (a count may only change with it) */
  private slotWatch = new Map<number, { w: SlotWatch; changedAt: number }>();
  /**
   * The Quickslot box as fitted to the slots on screen (see fitQuickslot): a hand-drawn box a few % off loses digits
   * ("96" read as 9). `for` is the drawn box and the potion slots it was fitted with; a change to either refits.
   */
  qsFit: { region: Region; scale: number; for: string } | null = null;
  private qsFitAt = 0;
  /** Fit the box when counting starts, and again (at most every 15 s) while some potion's count isn't reading. */
  private fitCounts(v: FrameSource, now: number) {
    const bar = this.settings.hotbar, slots = bar.map((n, i) => (n && potionByName(n) ? i : -1)).filter(i => i >= 0);
    if (!slots.length) return;
    const key = JSON.stringify([this.regions.quickslot, slots]);
    const stale = slots.some(i => { const sc = this.counts.get(i); return !sc || now - sc.at > 10_000; });
    if (this.qsFit?.for === key && !stale) return;
    if (now - this.qsFitAt < 15_000) return;
    this.qsFitAt = now;
    const fit = fitQuickslot(v, this.regions.quickslot, slots, HOTBAR_COLS, HOTBAR_ROWS, GLYPHS, this.scratch.slots);
    if (!fit) return;
    const moved = !this.qsFit || JSON.stringify(this.qsFit.region) !== JSON.stringify(fit.region);
    this.qsFit = { region: fit.region, scale: fit.scale, for: key };
    if (moved && (Math.abs(fit.scale - 1) > 0.005 || fit.region.x !== this.regions.quickslot.x || fit.region.y !== this.regions.quickslot.y))
      this.tracker?.event('info', `Quickslot box lined up with your hotbar automatically (${fit.reads} potion count${fit.reads > 1 ? 's' : ''} readable)`);
  }
  /**
   * Read the count printed on every hotbar slot that holds a potion (template matching, see potcount.ts). A drop of 1–3
   * that the potion's gauge confirms is potions used; a rise is a pickup; anything else is a misread and only moves the
   * baseline (noted in the activity log). Exact even when a potion is drunk while being hit.
   */
  private watchCounts(v: FrameSource) {
    this.followHotbar(v, Date.now());
    const bar = this.settings.hotbar, now = Date.now();
    // a slot emptied, or now holding a different potion, starts its count afresh
    for (const k of [...this.counts.keys()]) if (bar[k] !== this.countFor.get(k)) { this.counts.delete(k); this.slotWatch.delete(k); this.countFor.delete(k); }
    this.fitCounts(v, now);
    const qs = this.qsFit?.region ?? this.regions.quickslot;
    bar.forEach((name, i) => {
      const p = name ? potionByName(name) : null;
      if (!p || !this.tracker) return;
      const kind = p.hp || p.hpPct ? 'hp' : 'mp';
      const w = this.slotWatch.get(i) ?? this.slotWatch.set(i, { w: new SlotWatch(), changedAt: -Infinity }).get(i)!;
      const sc = this.counts.get(i) ?? this.counts.set(i, new SlotCounter()).get(i)!;
      this.countFor.set(i, p.name);
      const res = this.readCount(v, qs, i, kind, sc, w, now);
      // while another potion is being confirmed in this slot, uses are held until it's settled which one they were
      const pend = this.pending.get(i);
      if (pend) { pend.oldUsed += res.used; return; }
      if (res.used) this.tracker.creditPots(kind, p.name, res.used);
      else if (res.rejected) this.tracker.event('info', `${p.name} count ${res.from} → ${sc.val} ignored (looks like a misread)`);
    });
    // a potion seen but not yet confirmed on the hotbar is counted from its first sighting, held until it's confirmed
    for (const [i, pend] of this.pending) {
      const p = potionByName(pend.name);
      if (p) pend.newUsed += this.readCount(v, qs, i, p.hp || p.hpPct ? 'hp' : 'mp', pend.sc, pend.w, now).used;
    }
  }
  /** Read one slot's count, with its picture watched too (not read): a count may only change when the picture did, lately. */
  private readCount(v: FrameSource, qs: Region, i: number, kind: 'hp' | 'mp', sc: SlotCounter, w: { w: SlotWatch; changedAt: number }, now: number) {
    const tpl = readSlotCount(v, qs, i, HOTBAR_COLS, HOTBAR_ROWS, GLYPHS, this.scratch.slots);
    // at the Ideal ratio the game's own digit pictures match the screen exactly: they cross-check the templates (and
    // win when the two disagree), as the font matcher does for the pickup log
    const ideal = this.settings.uiRatio === 'ideal';
    const r = ideal ? crossRead(tpl, readSlotSprite(v, qs, i, HOTBAR_COLS, HOTBAR_ROWS, 1, this.scratch.slots), true) : tpl;
    const ch = w.w.feed(slotStrip(v, qs, i, HOTBAR_COLS, HOTBAR_ROWS, this.scratch.slots), now);
    if (ch != null) w.changedAt = ch;
    return sc.feed(r, now, now - this.gaugeMovedAt[kind] < 3000, now - w.changedAt < 4000);
  }
  // ---------- the hotbar follows the game by itself (hotbarscan.ts) ----------
  private hotbarAuto = new HotbarAuto();
  /** which potion each slot's count belongs to */
  private countFor = new Map<number, string>();
  /**
   * Slots where a scan saw a potion the hotbar doesn't have there yet. Its count is read from that first sighting, and
   * its uses (newUsed) are credited once it's confirmed; the slot's old potion's uses meanwhile (oldUsed) are credited
   * instead if it isn't (a tooltip, a window over the quickslot). Nothing drunk while confirming is lost or counted twice.
   */
  private pending = new Map<number, { name: string; since: number; sc: SlotCounter; w: { w: SlotWatch; changedAt: number }; newUsed: number; oldUsed: number; shown: number | null }>();
  /** Settle a pending slot: credit the uses of whichever potion it turned out to be. */
  private settlePending(i: number, confirmed: boolean) {
    const pend = this.pending.get(i), t = this.tracker;
    if (!pend) return;
    this.pending.delete(i);
    const name = confirmed ? pend.name : this.settings.hotbar[i], used = confirmed ? pend.newUsed : pend.oldUsed;
    const p = name ? potionByName(name) : null;
    if (p && used && t) t.creditPots(p.hp || p.hpPct ? 'hp' : 'mp', p.name, used);
    if (confirmed) { this.counts.set(i, pend.sc); this.slotWatch.set(i, pend.w); this.countFor.set(i, pend.name); }
  }
  private potionIcons: { scale: number; icons: IconTpl[] } | null = null;
  private iconsLoading = false;
  private hotbarScanAt = 0;
  /** each slot's last picture and what it was recognised as: an unchanged slot isn't matched again */
  private scanCache = new Map<number, ScanMemo>();
  /**
   * Every 2 s, recognise which potion is in each quickslot slot by its icon and, once a change is steady,
   * update the hotbar (as if dragged on the Potions tab). A new potion is counted from the moment it's first seen
   * (see pending), so uses while it's being confirmed still count. Off when the Potions tab's "Detect automatically" is unticked.
   */
  private followHotbar(v: FrameSource, now: number) {
    // switched off mid-sighting: the held uses go back to the slot's own potion
    if (!this.settings.autoHotbar) for (const i of [...this.pending.keys()]) this.settlePending(i, false);
    // wait for the item list (it names every potion and food) before loading their icons
    if (!this.settings.autoHotbar || !(osmsReady() || osmsSettled()) || now - this.hotbarScanAt < HOTBAR_SCAN_MS) return;
    this.hotbarScanAt = now;
    const { H } = frameSize(v), scale = hudScale(this.settings.uiRatio, H);
    if (this.potionIcons?.scale !== scale) {
      if (!this.iconsLoading) {
        this.iconsLoading = true;
        loadPotionIcons(scale).then(icons => { this.potionIcons = { scale, icons }; this.hotbarScanAt = 0; this.scanCache.clear(); }).catch(() => undefined).finally(() => { this.iconsLoading = false; });
      }
      return;
    }
    const scan = scanSlots(v, this.qsFit?.region ?? this.regions.quickslot, HOTBAR_COLS, HOTBAR_ROWS, this.potionIcons.icons, scale, this.scratch.slots, false, this.scanCache);
    const bar = this.settings.hotbar;
    scan.forEach((n, i) => {
      const pend = this.pending.get(i);
      // a different potion (or the old one back) ends a sighting; an empty read (something over the slot) doesn't
      if (pend && ((n && n !== pend.name) || now - pend.since > PENDING_MAX_MS)) this.settlePending(i, false);
      if (n && n !== bar[i] && !this.pending.has(i) && potionByName(n))
        this.pending.set(i, { name: n, since: now, sc: new SlotCounter(), w: { w: new SlotWatch(), changedAt: -Infinity }, newUsed: 0, oldUsed: 0, shown: this.counts.get(i)?.val ?? null });
    });
    // a slot whose count still reads still holds its potion, whatever its icon looked like
    const counted = bar.map((_, i) => now - (this.counts.get(i)?.at ?? -Infinity) < 3000);
    const next = this.hotbarAuto.feed(scan, bar, counted);
    if (!next) return;
    const was = bar;
    next.forEach((n, i) => {
      const pend = this.pending.get(i);
      if (pend && n !== was[i]) this.settlePending(i, n === pend.name);
    });
    next.forEach((n, i) => {
      if (n === was[i]) return;
      this.tracker?.event('info', n ? `Hotbar: ${n} found in slot ${i + 1}${was[i] ? ` (was ${was[i]})` : ''}` : `Hotbar: ${was[i]} no longer in slot ${i + 1}`);
    });
    // potions found that aren't on the Potions tab's lists yet are added to them
    const add = (key: 'hpOrder' | 'mpOrder', pred: (n: string) => boolean) => {
      const list = this.settings[key], extra = next.filter((n): n is string => !!n && pred(n) && !list.includes(n));
      return extra.length ? [...list, ...new Set(extra)] : list;
    };
    const isHp = (n: string) => { const p = potionByName(n); return !!p && !!(p.hp || p.hpPct); };
    const isMp = (n: string) => { const p = potionByName(n); return !!p && !!(p.mp || p.mpPct); };
    this.updateSettings({ hotbar: next, hpOrder: add('hpOrder', isHp), mpOrder: add('mpOrder', isMp) });
  }

  /** Are the hotbar counts covering this stat's potions right now (a slot for it read in the last 5 s)? */
  private potsCounted(kind: 'hp' | 'mp') {
    const now = Date.now();
    for (const [i, sc] of this.counts) {
      const p = potionByName(this.settings.hotbar[i] ?? '');
      if (p && sc.val != null && now - sc.at < 5000 && (kind === 'hp' ? p.hp || p.hpPct : p.mp || p.mpPct)) return true;
    }
    return false;
  }
  /** The confirmed count on a hotbar slot (null until read). */
  slotCount(i: number) {
    // while a swap there is unconfirmed, keep showing the count from before it (the new potion's number would otherwise
    // appear under the old potion for a few seconds)
    const pend = this.pending.get(i);
    return pend ? pend.shown : this.counts.get(i)?.val ?? null;
  }

  private async tickExp() {
    if (!this.canRun || this.busy.exp || !anyOn(this.settings, ...EXP_FEATURES)) return;
    this.busy.exp = true;
    try {
      const r = parseExp(await this.read('exp', this.capture.video));
      const s = this.sess, t = this.tracker;
      if (!r || !s || !t) return;
      const before = s.exp;
      const res = t.onExp(r);
      if (s.exp > before) this.markActive();
      if (res === 'level') { this.identity.level = s.level; this.ensureLook(); } // new gear for the new level
      // the bar rolled over (a level-up needs the level number to confirm it), and a regular check once a minute
      if (res === 'candidate' || Date.now() - this.levelReadAt > 60_000) this.checkLevel();
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

  private levelReadAt = 0;
  private levelBusy = false;
  /** Read the level number (2 of 3 reads must agree) and hand it to the tracker, which uses it to confirm level-ups. */
  private async checkLevel() {
    if (this.levelBusy) return;
    this.levelBusy = true; this.levelReadAt = Date.now();
    try {
      const r = await this.readLevel(), t = this.tracker;
      if (r && t) t.onLevelRead(r.level);
    } catch (e) { console.error(e); } finally { this.levelBusy = false; }
  }

  private lastMapRead = 0;
  private async tickMap(force: boolean) {
    if (!this.canRun || this.busy.map || !anyOn(this.settings, 'expByMap', 'monsters', 'kills', 'drops')) return;
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
  /** EXP gained over the last `ms` of session time (null until the session is that old). */
  gainOver(ms: number) {
    const r = this.recent, s = this.sess;
    if (!s || r.length < 2) return null;
    const now = r[r.length - 1];
    if (now[0] - r[0][0] < ms * 0.95) return null;
    const from = r.find(p => p[0] >= now[0] - ms) ?? r[0];
    return now[1] - from[1];
  }
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

  /**
   * Idle for `idlePauseSec` (no EXP, loot or MP spent on skills): pause, without counting the idle stretch as session
   * time. While auto-paused, three cheap watchers bring the session back the moment you fight again: a new pickup-log
   * line (pixel check), MP going down (gauge), or the EXP bar going up.
   */
  private checkIdle() {
    const s = this.sess, sec = this.settings.idlePauseSec;
    if (!s || s.paused || !sec) return;
    // with neither the EXP bar nor the pickup log read, fighting can't be told from idling: never auto-pause then
    if (!anyOn(this.settings, ...EXP_FEATURES, 'mesos', 'drops')) return;
    const quietSince = Math.max(this.lastActive, s.resumeAt, this.tracker?.lastDrop('mp') ?? 0);
    if (Date.now() - quietSince < sec * 1000) return;
    s.activeMs += quietSince - s.resumeAt;
    s.paused = true; this.autoPaused = true;
    this.tracker?.event('info', `Auto-paused (idle ${sec}s)`);
    this.idle = { log: null, mp: [], mpBase: null, exp: null };
    const sc = this.settings.schedule;
    this.ticker.set({
      ui: [1000, () => this.notify()],
      idle: [sc.expMs, () => this.watchIdle()],
      idleFast: [Math.max(sc.logWatchMs, sc.gaugeMs), () => this.watchIdleFast()],
    });
    this.persist(true);
    this.notify();
  }
  private idle: { log: LogScan | null; mp: number[]; mpBase: number | null; exp: number | null } = { log: null, mp: [], mpBase: null, exp: null };
  /** While auto-paused: a new pickup-log line or MP spent means you're fighting again. */
  private watchIdleFast() {
    const s = this.sess;
    if (!s || !s.paused || !this.autoPaused || !this.capture.ready) return;
    const v = this.capture.video, r = this.regions.log, id = this.idle;
    try {
      const lo = logScan(v, r, r.thr - 30, document.createElement('canvas'), this.logAnchor.value, this.settings.uiRatio);
      const prev = id.log;
      id.log = lo;
      if (prev && newLineCount(prev, lo).count > 0) { this.resumeFromIdle('loot / EXP in the log', prev); return; }
      const f = gaugeFill(v, this.regions.mpGauge, 'mp', this.scratch.gauge);
      if (f == null) { id.mp = []; return; }
      id.mp.push(f); if (id.mp.length > 3) id.mp.shift();
      if (id.mp.length < 3) return;
      const m = median(id.mp);
      id.mpBase ??= m;
      if (m < id.mpBase - 0.015) this.resumeFromIdle('MP spent'); // ≥ 2px of the bar: a skill, not read noise
      else if (m > id.mpBase) id.mpBase = m; // regen / a pot while idle
    } catch (e) { console.error(e); }
  }
  private busyIdle = false;
  /** While auto-paused: the EXP bar going up (two reads in a row above the paused value) resumes too. */
  private async watchIdle() {
    const s = this.sess, t = this.tracker;
    if (!s || !t || !s.paused || !this.autoPaused || this.busyIdle || !this.capture.ready || this.ocrState !== 'ready') return;
    this.busyIdle = true;
    try {
      const r = parseExp(await this.read('exp', this.capture.video));
      if (!r || t.exp == null || r.exp <= t.exp) { this.idle.exp = null; return; }
      const prev = this.idle.exp;
      this.idle.exp = r.exp;
      if (prev != null && r.exp >= prev) this.resumeFromIdle('EXP moving again');
    } catch (e) { console.error(e); } finally { this.busyIdle = false; }
  }
  /**
   * Back from auto-pause. The EXP baseline is kept, so EXP earned since still counts. When a log line woke us, the log
   * watcher restarts from the frame just before it, so that line is counted too.
   */
  private resumeFromIdle(why: string, logBefore?: LogScan) {
    const s = this.sess, t = this.tracker;
    if (!s || !t || !s.paused || !this.autoPaused) return;
    s.paused = false; s.resumeAt = Date.now(); this.autoPaused = false;
    this.resetWatchers();
    if (logBefore) { this.lastLog = logBefore; this.logLines = logBefore.slots.map(() => ({ pre: true, guess: false, item: null })); }
    t.event('info', `Resumed (${why})`);
    this.markActive();
    this.startTimers();
    this.tickLog();
    this.tickExp();
    this.notify();
  }
  /**
   * Attacking: EXP or loot came in within the last EXP read or so (EXP is read every 5 s, so a shorter window would
   * flicker back to idle between reads), or MP was just spent on a skill (seen on the gauge 10×/s).
   */
  get fighting() {
    const now = Date.now();
    return !!this.sess && !this.sess.paused
      && (now - this.lastActive < this.settings.schedule.expMs + 2000 || now - (this.tracker?.lastDrop('mp') ?? -Infinity) < 3000);
  }
  /** The pixel-art explorer for the current job (idle / attack loops). */
  /** Real Maple sprite frames for the character's saved look (pixel art shows until they're in). */
  readonly sprites = new SpriteLoader();

  /** Load the character's saved look (if it suits the current job) and its frames. */
  private loadLook() {
    const look = store.loadChars()[this.identity.name]?.look;
    // a look made by an older version (or for another job / gender) is replaced right away, not at the next session
    if (look && !this.lookFits(look)) { this.ensureLook(); return; }
    this.sprites.load(look ?? null, () => this.onSpriteFrame());
  }
  /**
   * Does a saved look still suit the character: current format, job branch and gender, and the gear for the current
   * level (gear upgrades as you level; the face, hair and skin stay)?
   */
  private lookFits(l: CharLook) {
    const { cls, level, gender = 0 } = this.identity;
    return l.v === LOOK_V && l.branch === classLook(cls) && l.gender === gender
      && JSON.stringify(l.items) === JSON.stringify(rollLook(cls, level, gender, l.variant).items);
  }
  /**
   * Make sure the character has a look that fits: keep its pool look (face, hair, skin) and re-dress it for the current
   * job and level, or pick a random pool look when there's none yet; `reroll` picks a different pool look.
   */
  private ensureLook(reroll = false) {
    const { name, cls, level, gender = 0 } = this.identity;
    if (!name || name === 'Unknown') return;
    const cur = store.loadChars()[name]?.look;
    if (!reroll && cur && this.lookFits(cur)) { if (JSON.stringify(this.sprites.look) !== JSON.stringify(cur)) this.loadLook(); return; }
    const keep = cur?.v === LOOK_V && cur.gender === gender ? cur.variant : undefined;
    const variant = reroll ? randomVariant(keep) : keep ?? randomVariant();
    const ch = store.loadChars();
    ch[name] = { ...ch[name], look: rollLook(cls, level, gender, variant), thumb: undefined };
    store.saveChars(ch);
    if (reroll || keep == null) this.tracker?.event('info', 'New character look rolled');
    this.loadLook();
  }
  /** A different look from the pool for the character (the dice button). */
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
        const r = this.regions.log, lo = logScan(src, r, r.thr - 30, document.createElement('canvas'), this.logAnchor.value, this.settings.uiRatio);
        const saved = this.slotCache; this.slotCache = new Map();
        const lines = await this.readLogLines(src, lo);
        this.slotCache = saved;
        rows.push({ key, label: def.label, color: def.color, img: logPreviewCanvas(lo).toDataURL(), raw: lines.join(' ⏎ '),
          parsed: lines.slice().reverse().map(l => `${lineKind(l) ?? '?'}${lineAmount(l) ? ' +' + lineAmount(l) : ''}`).join(' ⏎ ') || '(no lines)' });
        continue;
      }
      if (key === 'quickslot') { // the crop with its 4×3 grid: each line should sit on a slot border
        const r = this.regions.quickslot, { W, H } = frameSize(src), z = 3, c = document.createElement('canvas');
        c.width = Math.round(r.w * W) * z; c.height = Math.round(r.h * H) * z;
        const g = c.getContext('2d')!; g.imageSmoothingEnabled = false; g.drawImage(src, r.x * W, r.y * H, r.w * W, r.h * H, 0, 0, c.width, c.height);
        g.strokeStyle = def.color; g.lineWidth = 1;
        for (let i = 1; i < HOTBAR_COLS; i++) { g.beginPath(); g.moveTo(i * c.width / HOTBAR_COLS, 0); g.lineTo(i * c.width / HOTBAR_COLS, c.height); g.stroke(); }
        for (let j = 1; j < HOTBAR_ROWS; j++) { g.beginPath(); g.moveTo(0, j * c.height / HOTBAR_ROWS); g.lineTo(c.width, j * c.height / HOTBAR_ROWS); g.stroke(); }
        const reads = this.settings.hotbar.flatMap((n, i) => (n ? [`${n}: ${readSlotCount(src, r, i, HOTBAR_COLS, HOTBAR_ROWS)?.value ?? '✗ unreadable'}`] : []));
        rows.push({ key, label: def.label, color: def.color, img: c.toDataURL(), raw: 'grid lines should sit on the slot borders',
          parsed: reads.length ? reads.join(' · ') : 'no potions placed yet (Potions tab)' });
        continue;
      }
      if (def.gauge) { // pixel colour, no OCR: show the strip that's read and how full it looks
        const k = key === 'hpGauge' ? 'hp' : 'mp', r = this.regions[key], f = gaugeFill(src, r, k), c = document.createElement('canvas');
        const { W, H } = frameSize(src);
        c.width = Math.max(8, Math.round(r.w * W)) * 2; c.height = 16;
        const g = c.getContext('2d')!; g.imageSmoothingEnabled = false; g.drawImage(src, r.x * W, r.y * H, r.w * W, Math.max(1, r.h * H), 0, 0, c.width, c.height);
        const max = this.tracker?.[k].max;
        rows.push({ key, label: def.label, color: def.color, img: c.toDataURL(), raw: 'pixel read, no OCR',
          parsed: f == null ? '✗ not a gauge here (drag this box onto the middle of the bar)' : `${(f * 100).toFixed(0)}% full${max ? ` ≈ ${Math.round(f * max)} / ${max}` : ''}` });
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
