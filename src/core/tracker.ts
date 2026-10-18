import { countNewLines, lineAmount, lineKind, parseItemLine, type ExpReading } from './parse';
import type { EventType, Session } from './session';
import { elapsed } from './session';
import { fmtN, lev, median, normLine, sim } from './util';

export interface TrackerDeps {
  /** HP/MP increases below these are regen, not potions */
  hpMin: () => number;
  mpMin: () => number;
  /** snap an OCR'd item / map name to a known one (null when unknown) */
  canonItem?: (raw: string) => { name: string; id?: number } | null;
  canonMap?: (raw: string) => string | null;
  /** true once the full item list is loaded, so unmatched names can be treated as OCR noise */
  itemsKnown?: () => boolean;
  /** true once the real map list is loaded: then only names found in it are accepted */
  mapsKnown?: () => boolean;
  /** most EXP one kill gives on this map (null = monsters unknown): caps believable EXP gains */
  maxMobExp?: (map: string | null) => number | null;
  /** true while the hotbar's potion counts for this stat are being read: then they, not the gauge, count potions */
  potsCounted?: (kind: 'hp' | 'mp') => boolean;
  /** the monster an etc drop comes from (null = not known) */
  mobForDrop?: (item: string, map: string | null) => string | null;
  now?: () => number;
}

/** What one EXP read did: a confirmed level-up, a suspected one (confirm with the level number), or nothing special. */
export type ExpResult = 'level' | 'candidate' | null;
/** EXP per kill assumed when the map's monsters aren't known (no monster in the game gives more outside bosses) */
const DEFAULT_KILL_EXP = 1000;
/** believable kill rate and party / event bonus: the EXP cap is killExp × KILLS_PER_SEC × BONUS per second */
const KILLS_PER_SEC = 2, BONUS = 2;
/** a suspected level-up that neither the level number nor the EXP total confirms within this long was a misread */
const LEVEL_CONFIRM_MS = 180_000;

interface Bar { buf: number[]; cur: number | null; max: number | null; votes: Record<number, number>; regen: number }
/** below this bar % the level total (exp / %) is too imprecise to estimate (0.20% read to 2 decimals: ±2.5%) */
const MIN_TOTAL_PCT = 0.2;
/**
 * Do two reads imply the same level total (exp·100/%)? Allows for the % being cut to 2 decimals (±0.01), so a read
 * with an extra digit (×10) is caught even at a fraction of a percent, and a wrong digit at higher %. A 0.00% read can't be checked: only tiny exp passes.
 */
function sameTotal(a: ExpReading, b: ExpReading, slack: number): boolean {
  if (a.pct <= 0 || b.pct <= 0) return Math.max(a.exp, b.exp) - Math.min(a.exp, b.exp) <= 500 && b.pct < 0.05;
  const ta = a.exp * 100 / a.pct, tb = b.exp * 100 / b.pct;
  return Math.abs(tb / ta - 1) <= 0.01 / a.pct + 0.01 / b.pct + slack;
}

/** EXP earned where the map name couldn't be read or isn't a real map */
export const UNKNOWN_MAP = 'Cannot determine';
const LEGACY_UNKNOWN = 'Undefined';

const newBar = (): Bar => ({ buf: [], cur: null, max: null, votes: {}, regen: 0 });

/** HP/MP gauge fill (0–1) as seen ~10×/s: the last three reads, the smoothed level, a rise in progress, and since when it's unreadable. */
interface Gauge { win: number[]; level: number | null; riseFrom: number | null; lastOk: number; badSince: number | null; dropAt: number }
const newGauge = (): Gauge => ({ win: [], level: null, riseFrom: null, lastOk: -Infinity, badSince: null, dropAt: -Infinity });
/**
 * The game flashes a gauge for ~0.5 s whenever it changes (a potion, a hit), and the flashing frames don't read as a
 * gauge. Up to this long, the level from before is kept, so a potion is the step from before the flash to after it;
 * anything longer (loading screen, a window over the bar) starts over.
 */
const GAUGE_GAP_MS = 1500;
/** gauge reads are trusted for potion counting while one came in this recently (else the OCR'd numbers are used) */
const GAUGE_LIVE_MS = 3000;
/** below this fill the character is (nearly) dead: a rise from there is a respawn, not a potion */
const GAUGE_DEAD = 0.02;

/**
 * Turns validated screen readings into session totals. Holds no DOM state, so it is unit-testable and shared by
 * the web app and a future desktop shell.
 */
export class Tracker {
  // EXP bar state
  exp: number | null = null;
  pct: number | null = null;
  /** EXP needed for the current level, estimated as exp*100/pct (most precise from high-% readings) */
  total: number | null = null;
  private totalPct = 0;
  private totalStale = false;
  private pend: ExpReading | null = null;
  private drop: ExpReading | null = null;
  private reb: ExpReading | null = null;
  private firsts: ExpReading[] = [];
  private big: ExpReading | null = null;
  /** the previous level's EXP total (to sanity-check reads right after a level-up) */
  private lastTotal: number | null = null;
  private strikes = 0;
  /** when the EXP baseline last moved (the EXP cap grows with the time between accepted reads) */
  private expAt = 0;
  /** the bar rolled over: a level-up, once the level number or the new level's EXP total confirms it */
  private lvCand: { since: number } | null = null;
  /** the level number on screen went up to this (the next roll-over is that level-up) */
  private lvSeen: number | null = null;
  // map
  mapCur: string | null = null;
  private mapCand: string | null = null;
  private mapMiss = 0;
  // bars
  hp = newBar();
  mp = newBar();
  private gauge = { hp: newGauge(), mp: newGauge() };
  // pickup log
  private logPrev: string[] = [];
  private mesoAmts: number[] = [];

  constructor(public sess: Session, private deps: TrackerDeps) {}

  private now() { return this.deps.now ? this.deps.now() : Date.now(); }
  event(type: EventType, text: string) {
    const s = this.sess;
    s.events.unshift({ t: elapsed(s, this.now()), type, text });
    if (s.events.length > 60) s.events.length = 60;
  }
  get mapName() { return this.mapCur || UNKNOWN_MAP; }

  /** Forget bar/log baselines (after a pause) so changes while paused aren't counted. */
  rebaseline() {
    this.exp = null; this.firsts = []; this.big = null; this.pend = null; this.drop = null; this.strikes = 0; this.lvCand = null;
    this.hp.cur = this.mp.cur = null; this.hp.buf = []; this.mp.buf = []; this.logPrev = [];
    this.gauge = { hp: newGauge(), mp: newGauge() };
  }

  private gain(d: number) { const s = this.sess; s.exp += d; const m = this.mapName; s.maps[m] = (s.maps[m] || 0) + d; }
  private setTotal(r: ExpReading) {
    if (r.pct >= MIN_TOTAL_PCT && (!this.totalPct || r.pct > this.totalPct || this.totalStale)) { this.total = r.exp * 100 / r.pct; this.totalPct = r.pct; this.totalStale = false; }
  }
  /** Make a reading the EXP baseline. */
  private accept(r: ExpReading, total = true) { this.exp = r.exp; this.pct = r.pct; this.expAt = this.now(); if (total) this.setTotal(r); }

  /**
   * The most EXP that can believably come in since the last accepted read: the best monster on this map (1,000 when
   * the map's monsters aren't known), killed twice a second, with up to double from party / event bonuses.
   */
  expCap(): number {
    const kill = Math.max(50, this.deps.maxMobExp?.(this.mapCur) ?? DEFAULT_KILL_EXP);
    const sec = Math.max(5, (this.now() - this.expAt) / 1000);
    return Math.round(kill * KILLS_PER_SEC * BONUS * sec);
  }

  /**
   * Vet a gain: over the EXP cap it's a misread and never counted (if it reads the same twice the baseline moves there
   * without counting), and a gain over 10% of a level must be read twice. 'wait' = not yet, 'skip' = moved the
   * baseline without counting.
   */
  private vet(d: number, r: ExpReading, total: number): 'ok' | 'wait' | 'skip' {
    const cap = this.expCap(), twice = d > cap || d > total * 0.1;
    if (!twice) { this.big = null; return 'ok'; }
    if (!(this.big && Math.abs(this.big.exp - r.exp) <= Math.max(2, total * 0.002))) { this.big = r; return 'wait'; }
    this.big = null;
    if (d <= cap) return 'ok';
    this.event('info', `Ignored an impossible EXP jump (+${fmtN(d)}; at most ~${fmtN(cap)} fits): treated as a misread`);
    this.totalStale = true;
    return 'skip';
  }

  /** Feed one EXP bar reading. 'level' = a level-up was confirmed; 'candidate' = the bar rolled over (read the level number). */
  onExp(r: ExpReading): ExpResult {
    if (this.exp == null) {
      // the baseline needs two reads that agree (out of the last few), so one misread can't become the starting point;
      // they must imply the same level total as closely as the % display allows (a digit misread by a few hundred
      // EXP, e.g. 124,156 for 124,516, would otherwise be counted as a gain)
      const f = this.firsts.slice().reverse().find(f => r.exp >= f.exp && r.exp - f.exp <= Math.max(2000, f.exp * 0.05) && sameTotal(f, r, 0.0005));
      if (!f) { this.firsts = [...this.firsts.slice(-2), r]; return null; }
      this.firsts = []; this.accept(f);
    }
    const base = this.exp!;
    if (this.total == null) {
      // bar below 0.2% (fresh level / session start): the level total isn't known precisely yet, so check the
      // read against the previous read's implied total (and the previous level's total), never take it on trust
      const d = r.exp - base, est = this.lastTotal ? this.lastTotal * 1.2 : null;
      const ok = d >= 0 && r.pct >= (this.pct ?? 0) - 0.01 && sameTotal({ exp: base, pct: this.pct ?? 0 }, r, 0.02)
        && (!est || Math.abs(r.exp * 100 / est - r.pct) <= r.pct * 0.3 + 0.05);
      if (!ok) return null;
      const v = d > 0 ? this.vet(d, r, r.pct > 0 ? r.exp * 100 / r.pct : Infinity) : 'ok';
      if (v === 'wait') return null;
      if (v === 'ok' && d > 0) this.gain(d);
      this.accept(r);
      return null;
    }
    // a misread digit shifts exp but not %, so compare the % predicted from exp with the % read
    const total = this.total;
    const fits = (exp: number) => !!total && Math.abs(exp * 100 / total - r.pct) <= 0.02 + r.pct * 0.006 / this.totalPct;
    if (total && !fits(r.exp)) { // repair a stray extra digit ("1250728" for 125,072) when exactly one deletion fits the %
      const d = String(r.exp), fixes = new Set<number>();
      for (let i = 0; i < d.length; i++) { const c = +(d.slice(0, i) + d.slice(i + 1)); if (fits(c)) fixes.add(c); }
      if (fixes.size === 1) r = { ...r, exp: [...fixes][0] };
    }
    const consistent = fits(r.exp);
    const bigDrop = base - r.exp > total * 0.12; // deaths cost ≤10%, so a bigger drop means the bar rolled over
    if (consistent && !bigDrop) {
      this.strikes = 0; this.pend = null; this.lvCand = null;
      const d = r.exp - base;
      if (d > 0) {
        const v = this.vet(d, r, total);
        if (v === 'wait') return null;
        if (v === 'ok') this.gain(d);
        this.accept(r); this.drop = null;
      } else if (d < 0) {
        // EXP went backwards (death without a safety charm): require a second matching read before logging it
        if (this.drop && Math.abs(this.drop.exp - r.exp) <= Math.max(2, total * 0.0002)) {
          const lost = base - r.exp;
          this.sess.expLost += lost; this.sess.deaths++;
          this.event('death', `EXP lost: -${fmtN(lost)} (death?)`);
          this.accept(r, false); this.drop = null;
        } else this.drop = r;
      } else this.drop = null;
      return null;
    }
    // inconsistent: a level-up (the bar rolled over) or a bad read
    if (bigDrop || (r.exp < base && this.pct != null && r.pct < this.pct)) return this.rollover(r, total);
    // rebaseline after repeated disagreement (e.g. a drifting total estimate) only if the new reads agree with each
    // other AND imply about the same level total; a consistently misread digit on a still frame must not get in
    if (r.pct >= 1 && Math.abs(r.exp * 100 / r.pct / total - 1) > 0.03) return null;
    if (this.reb && Math.abs(this.reb.exp - r.exp) < this.reb.exp * 0.01) this.strikes++; else { this.strikes = 1; this.reb = r; }
    if (this.strikes >= 4) { this.accept(r, false); this.totalStale = true; this.setTotal(r); this.strikes = 0; this.reb = null; }
    return null;
  }

  /**
   * The bar is lower than before, twice in a row. That's a level-up only when the level number on screen went up
   * (onLevelRead) or the new level clearly needs more EXP than the old one (exp·100/% once the bar is past 0.2%).
   * Until then nothing is counted; unconfirmed for 3 minutes, it was a misread and the baseline moves without counting.
   */
  private rollover(r: ExpReading, total: number): ExpResult {
    const s = this.sess, base = this.exp!;
    const again = this.pend && r.exp >= this.pend.exp && r.pct >= this.pend.pct;
    this.pend = r;
    if (!again) return null;
    const g = Math.max(0, total - base) + r.exp;
    if (g >= total * 0.5) return null; // nobody earns half a level between two reads: a misread
    const newTotal = r.pct >= MIN_TOTAL_PCT ? r.exp * 100 / r.pct : null;
    const byTotal = newTotal != null && newTotal > total * 1.01;
    const byLevel = this.lvSeen != null && this.lvSeen > (s.level ?? 0);
    if (!byTotal && !byLevel) {
      if (!this.lvCand) { this.lvCand = { since: this.now() }; return 'candidate'; }
      if (this.now() - this.lvCand.since < LEVEL_CONFIRM_MS) return null;
      this.event('info', 'The EXP bar dropped but the level number never changed: re-synced (nothing counted)');
      this.lvCand = null; this.pend = null; this.lastTotal = total;
      this.accept(r, false); this.total = null; this.totalPct = 0; this.setTotal(r);
      return null;
    }
    const cap = this.expCap();
    if (g <= cap) this.gain(g);
    else this.event('info', `Level-up EXP of +${fmtN(g)} is more than fits (~${fmtN(cap)}): not counted`);
    s.level = byLevel ? this.lvSeen! : (s.level || 0) + 1; s.levelUps++;
    this.event('level', `Level up! → ${s.level}`);
    this.lastTotal = total; this.total = null; this.totalPct = 0; this.accept(r);
    this.pend = null; this.strikes = 0; this.lvCand = null; this.lvSeen = null;
    return 'level';
  }

  /**
   * The level number read from the screen (2 of 3 reads agreeing). It never goes down, and a jump of more than two
   * levels is a misread; a higher level confirms the bar's roll-over as a level-up.
   */
  onLevelRead(lv: number) {
    const s = this.sess;
    if (s.level == null) { s.level = lv; s.levelStart ??= lv; return; }
    if (lv > s.level && lv <= s.level + 2) this.lvSeen = lv;
  }

  /** Feed one HP or MP reading [cur, max]. */
  onBar(kind: 'hp' | 'mp', pair: [number, number] | null) {
    if (!pair) return;
    const b = this[kind], s = this.sess[kind];
    let [cur0, max] = pair;
    // the closing "]" is often read as a trailing 1 ("10781"): if the shorter value is already known, use it
    if (max >= 1e4 && max % 10 === 1) { const short = (max - 1) / 10; if (b.votes[short] >= 1) max = short; }
    // max = most-voted value (votes decay so a real change, e.g. after a level-up, wins within ~10 reads)
    for (const k in b.votes) b.votes[k] *= 0.9;
    b.votes[max] = (b.votes[max] || 0) + 1;
    let best = b.max;
    for (const k in b.votes) if (best == null || b.votes[k] > (b.votes[best] || 0) + 1.5) best = +k;
    b.max = best;
    if (b.max == null) return;
    if (max !== b.max) { // a 1-digit misread or stray bracket digit still describes the known max
      const a = String(max), e = String(b.max);
      if (!(a.startsWith(e) && a.length === e.length + 1) && lev(a, e) > 1) return;
    }
    if (cur0 > b.max) { cur0 = +String(cur0).slice(1); if (!(cur0 <= b.max)) return; }
    b.buf.push(cur0);
    if (b.buf.length > 5) b.buf.shift();
    const cur = median(b.buf); // filters up to two consecutive misreads
    if (b.cur == null) { b.cur = cur; return; }
    const d = cur - b.cur, min = kind === 'hp' ? this.deps.hpMin() : this.deps.mpMin();
    s.max = b.max;
    if (d < 0) s.used += -d;
    // potions come from the gauge while it's readable; the 1/s numbers are only a fallback (they see the net change,
    // so a potion taken while being hit is easily lost)
    else if (d >= min && !this.gaugeLive(kind)) { s.rec += d; (s.jumps ??= []).push(d); }
    else if (d > 0) b.regen += d;
    b.cur = cur;
  }

  private gaugeLive(kind: 'hp' | 'mp') { return this.now() - this.gauge[kind].lastOk < GAUGE_LIVE_MS; }

  /**
   * Feed one HP or MP gauge read (fill 0–1, null = not readable). Read ~10×/s, a potion is a sharp rise: each rise
   * of at least the regen cutoff counts as one potion (a rise worth two counts as two), even while taking damage,
   * because damage and the potion rarely land in the same tenth of a second. A median of three reads filters
   * single-frame noise, and consecutive rising reads (an animated bar) are one rise.
   */
  onGauge(kind: 'hp' | 'mp', fill: number | null) {
    const g = this.gauge[kind], now = this.now();
    if (fill == null) {
      g.win = [];
      g.badSince ??= now;
      if (now - g.badSince > GAUGE_GAP_MS) { g.level = null; g.riseFrom = null; }
      return;
    }
    g.badSince = null;
    g.lastOk = now;
    g.win.push(fill);
    if (g.win.length > 3) g.win.shift();
    if (g.win.length < 3) return;
    const m = median(g.win);
    if (g.level == null) { g.level = m; return; }
    if (m > g.level) { g.riseFrom ??= g.level; g.level = m; return; }
    if (g.riseFrom != null) this.gaugeRise(kind, g.riseFrom, g.level);
    if (m < g.level) g.dropAt = now;
    g.riseFrom = null;
    g.level = m;
  }

  /** Potions used, read off the hotbar: a slot's count went down by `n`. */
  creditPots(kind: 'hp' | 'mp', name: string, n: number) {
    const f = this.sess[kind];
    (f.counted ??= {})[name] = (f.counted[name] || 0) + n;
    this.event('info', `${name} ×${n} used`);
  }

  /** When the HP / MP gauge last went down (damage taken / MP spent on a skill). */
  lastDrop(kind: 'hp' | 'mp') { return this.gauge[kind].dropAt; }

  private gaugeRise(kind: 'hp' | 'mp', from: number, to: number) {
    if (from < GAUGE_DEAD) return; // respawn
    const max = this[kind].max, s = this.sess[kind];
    const min = kind === 'hp' ? this.deps.hpMin() : this.deps.mpMin();
    // with the max known the rise is in HP/MP; until then, a rise of a few percent of the bar
    const amt = max ? Math.round((to - from) * max) : 0;
    if (max ? amt < min : to - from < 0.04) { if (max) this[kind].regen += amt; return; }
    s.rec += amt;
    // the hotbar's counts are exact: a rise they don't explain is other recovery (a party skill, a buff), not a potion
    if (this.deps.potsCounted?.(kind)) return;
    (s.jumps ??= []).push(amt);
  }

  /**
   * Feed the pickup-log lines currently on screen, bottom-up (index 0 = newest); works out which are new from the
   * text. The app uses onLogLines with pixel-based dedup instead; this is kept for text-only sources.
   */
  onLog(lines: string[]) {
    const cur = lines.map(t => ({ t, n: normLine(t) })).filter(l => l.n.length >= 6);
    const fresh = countNewLines(this.logPrev, cur.map(l => l.n));
    this.logPrev = cur.map(l => l.n);
    this.onLogLines(cur.slice(0, fresh).reverse().map(l => l.t));
  }

  /** Feed lines already known to be new, oldest first. */
  onLogLines(lines: string[]) {
    const s = this.sess;
    for (const l of lines) {
      const kind = lineKind(l);
      if (kind === 'item') {
        const it = parseItemLine(l);
        if (!it) continue;
        const canon = this.deps.canonItem?.(it.name);
        if (!canon && this.deps.itemsKnown?.()) continue; // full item list loaded and nothing close: OCR garbage
        let nm = canon?.name || it.name;
        const ex = Object.keys(s.drops).find(k => sim(k, nm) >= 0.8);
        if (ex) nm = ex;
        const d = s.drops[nm] || (s.drops[nm] = { qty: 0, cat: it.cat, id: canon?.id });
        d.qty += it.qty;
        this.event('drop', `${nm} ×${it.qty}`);
        const mob = this.deps.mobForDrop?.(nm, this.mapCur);
        if (mob) { const m = ((s.mobs ??= {})[mob] ??= { n: 0, last: 0 }); m.n += it.qty; m.last = elapsed(s, this.now()); }
      } else if (kind === 'meso') {
        const n = lineAmount(l);
        if (!n) continue;
        if (this.mesoAmts.length >= 5 && n > 8 * median(this.mesoAmts)) continue; // implausible (e.g. extra digit)
        this.mesoAmts.push(n);
        if (this.mesoAmts.length > 50) this.mesoAmts.shift();
        s.mesos += n;
        this.event('meso', `+${fmtN(n)} mesos`);
      }
      // EXP lines are ignored: the EXP bar is exact, log lines can repeat identically and be missed
    }
  }

  /**
   * Feed a map-name reading (already cleaned; null = no title visible). Once the real map list is loaded, a name
   * must match it: text that isn't a real map (OCR noise like "Cette Wonio") twice in a row means we can't tell
   * where we are, and EXP goes to "Cannot determine" until a real name is read.
   */
  onMap(raw: string | null) {
    if (!raw) return;
    const canon = this.deps.canonMap?.(raw) ?? null;
    if (!canon && this.deps.mapsKnown?.()) {
      if (this.mapCur && this.mapMiss++ >= 1) { this.mapCur = null; this.mapCand = null; this.event('map', `Map: ${UNKNOWN_MAP}`); }
      return;
    }
    this.mapMiss = 0;
    if (canon) { // a real map name: exact (similar names like "Line 1 <Area 1>" / "Line 2 <Area 1>" are different maps)
      if (canon !== this.mapCur) { this.mapCur = canon; this.event('map', `Map: ${canon}`); }
      this.mapCand = null;
      return;
    }
    // free text (map list unavailable): fuzzy-merge with names already seen, new names need two matching reads
    const name = raw;
    const known = Object.keys(this.sess.maps).concat(this.mapCur ? [this.mapCur] : [])
      .find(k => k !== UNKNOWN_MAP && k !== LEGACY_UNKNOWN && sim(k, name) >= 0.8);
    if (known) {
      if (known !== this.mapCur) { this.mapCur = known; this.event('map', `Map: ${known}`); }
      this.mapCand = null;
      return;
    }
    if (!this.mapCur || (this.mapCand && sim(this.mapCand, name) >= 0.85)) { this.mapCur = name; this.mapCand = null; this.event('map', `Map: ${name}`); }
    else this.mapCand = name;
  }
}
