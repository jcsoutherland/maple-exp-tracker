import { Capture } from '../core/capture';
import { classLook, LOOK_V, randomVariant, rollLook, SpriteLoader, type CharLook } from '../core/avatar/msio';
import { HOTBAR_COLS, HOTBAR_ROWS, REGION_DEFS, type Region, type RegionKey, type Settings } from '../core/config';
import { potionByName } from '../core/potions';
import { GLYPHS, readSlotCount, SlotCounter } from '../core/potcount';
import { canonItem, canonMap, loadOsms, mapsReady, maxMobExp, mobForItem, mobsSettled, onOsmsLoaded, osmsReady, osmsSettled } from '../core/data/osms';
import { ExpLineFilter, LineShapeFilter, LogAnchor, snapInk, snapLine, type LineSnap } from '../core/logqueue';
import { readLogSnap } from '../core/logread';
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
interface LogItem { snap: LineSnap; status: 'queued' | 'reading' | 'done' | 'failed'; tries: number; guess: boolean }
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
  regions: Record<RegionKey, Region> = store.loadRegions();
  identity: Identity = { name: '', cls: '', level: null };
  sess: Session | null = null;
  tracker: Tracker | null = null;
  lastFinished: SavedSession | null = null;
  historyVersion = 0;
  /** reads/sec of the pickup-log watcher and OCR calls, for the performance readout */
  stats = { logChecks: 0, ocrCalls: 0, lastTickMs: 0, expSkipped: 0, logDropped: 0, logBacklog: 0, guessSkipped: 0, logGuesses: 0, junkSkipped: 0 };

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
    if (!this.canRun || this.busy.log) return;
    this.busy.log = true;
    const t0 = performance.now();
    try {
      const v = this.capture.video, r = this.regions.log;
      const lo = logScan(v, r, r.thr - 30, document.createElement('canvas'), this.logAnchor.value);
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
      const high = () => (this.logEngine.prefersRaw ? null : (hi ??= logScan(v, r, r.thr, document.createElement('canvas'), this.logAnchor.value)));
      for (let i = Math.min(LOG_WATCH_SLOTS, this.logLines.length) - 1; i >= 0; i--) { // oldest first
        const ln = this.logLines[i];
        if (ln.pre) continue;
        if (!ln.item) {
          // a yellow line is EXP / party bonus: never queued, so a party's flood of them can't push item lines out
          if (lo.yellow?.[i]) { ln.item = { snap: snapLine(lo, null, lo.slots[i], now, true), status: 'done', tries: 1, guess: ln.guess }; this.stats.expSkipped++; this.debug?.('yellow', i); this.markActive(); continue; }
          const snap = snapLine(lo, high(), lo.slots[i], now);
          // not shaped like a log line (something moving behind the log): never read
          if (this.shapeFilter.isJunk(snap)) { ln.item = { snap, status: 'done', tries: 1, guess: ln.guess }; this.stats.junkSkipped++; this.debug?.('junk', snap); continue; }
          ln.item = { snap, status: 'queued', tries: 1, guess: ln.guess }; this.logQueue.push(ln.item);
        }
        else if (ln.item.status === 'failed' && ln.item.tries < 4 && now - ln.item.snap.t >= 250) {
          ln.item.snap = snapLine(lo, high(), lo.slots[i], now, lo.yellow?.[i]); ln.item.tries++; ln.item.status = 'queued'; this.logQueue.push(ln.item);
        }
      }
      this.pumpLog();
    } catch (e) { console.error(e); } finally { this.busy.log = false; this.stats.lastTickMs = performance.now() - t0; }
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
      out.push(await this.readSlot(lo, i, () => (hi ??= logScan(src, this.regions.log, this.regions.log.thr, document.createElement('canvas'), this.logAnchor.value))));
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

  /** HP / MP gauge fill, by pixel colour (~10×/s, well under a millisecond): what potions are counted from. */
  gaugeLast: { hp: number | null; mp: number | null } = { hp: null, mp: null };
  private tickGauge() {
    if (!this.canRun) return;
    const v = this.capture.video;
    if (++this.gaugeN % 3 === 0) this.watchCounts(v); // ~3×/s
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
  /**
   * Read the count printed on every hotbar slot that holds a potion (template matching, see potcount.ts). A drop of 1–3
   * that the potion's gauge confirms is potions used; a rise is a pickup; anything else is a misread and only moves the
   * baseline (noted in the activity log). Exact even when a potion is drunk while being hit.
   */
  private watchCounts(v: FrameSource) {
    const bar = this.settings.hotbar, now = Date.now();
    for (const k of [...this.counts.keys()]) if (!bar[k]) this.counts.delete(k);
    bar.forEach((name, i) => {
      const p = name ? potionByName(name) : null;
      if (!p || !this.tracker) return;
      const kind = p.hp || p.hpPct ? 'hp' : 'mp';
      const r = readSlotCount(v, this.regions.quickslot, i, HOTBAR_COLS, HOTBAR_ROWS, GLYPHS, this.scratch.slots);
      const sc = this.counts.get(i) ?? this.counts.set(i, new SlotCounter()).get(i)!;
      const res = sc.feed(r, now, now - this.gaugeMovedAt[kind] < 3000);
      if (res.used) this.tracker.creditPots(kind, p.name, res.used);
      else if (res.rejected) this.tracker.event('info', `${p.name} count ${res.from} → ${sc.val} ignored (looks like a misread)`);
    });
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
  slotCount(i: number) { return this.counts.get(i)?.val ?? null; }

  private async tickExp() {
    if (!this.canRun || this.busy.exp) return;
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

  /**
   * Idle for `idlePauseSec` (no EXP, loot or MP spent on skills): pause, without counting the idle stretch as session
   * time. While auto-paused, three cheap watchers bring the session back the moment you fight again: a new pickup-log
   * line (pixel check), MP going down (gauge), or the EXP bar going up.
   */
  private checkIdle() {
    const s = this.sess, sec = this.settings.idlePauseSec;
    if (!s || s.paused || !sec) return;
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
      const lo = logScan(v, r, r.thr - 30, document.createElement('canvas'), this.logAnchor.value);
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
        const r = this.regions.log, lo = logScan(src, r, r.thr - 30, document.createElement('canvas'), this.logAnchor.value);
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
