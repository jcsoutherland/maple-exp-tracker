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
  now?: () => number;
}

interface Bar { buf: number[]; cur: number | null; max: number | null; votes: Record<number, number>; regen: number }
/** EXP earned where the map name couldn't be read or isn't a real map */
export const UNKNOWN_MAP = 'Cannot determine';
const LEGACY_UNKNOWN = 'Undefined';

const newBar = (): Bar => ({ buf: [], cur: null, max: null, votes: {}, regen: 0 });

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
  private strikes = 0;
  // map
  mapCur: string | null = null;
  private mapCand: string | null = null;
  private mapMiss = 0;
  // bars
  hp = newBar();
  mp = newBar();
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
    this.exp = null; this.pend = null; this.drop = null; this.strikes = 0;
    this.hp.cur = this.mp.cur = null; this.hp.buf = []; this.mp.buf = []; this.logPrev = [];
  }

  private gain(d: number) { const s = this.sess; s.exp += d; const m = this.mapName; s.maps[m] = (s.maps[m] || 0) + d; }
  private setTotal(r: ExpReading) {
    if (r.pct >= 1 && (!this.totalPct || r.pct > this.totalPct || this.totalStale)) { this.total = r.exp * 100 / r.pct; this.totalPct = r.pct; this.totalStale = false; }
  }

  /** Feed one EXP bar reading. Returns true when a level-up was detected. */
  onExp(r: ExpReading): boolean {
    if (this.exp == null) { this.exp = r.exp; this.pct = r.pct; this.setTotal(r); return false; }
    if (this.total == null && r.pct >= 1) {
      if (r.exp >= this.exp && r.exp - this.exp < 1e7) this.gain(r.exp - this.exp);
      this.exp = r.exp; this.pct = r.pct; this.setTotal(r); return false;
    }
    // a misread digit shifts exp but not %, so compare the % predicted from exp with the % read
    const total = this.total;
    const fits = (exp: number) => !!total && Math.abs(exp * 100 / total - r.pct) <= 0.02 + r.pct * 0.006 / this.totalPct;
    if (total && !fits(r.exp)) { // repair a stray extra digit ("1250728" for 125,072) when exactly one deletion fits the %
      const d = String(r.exp), fixes = new Set<number>();
      for (let i = 0; i < d.length; i++) { const c = +(d.slice(0, i) + d.slice(i + 1)); if (fits(c)) fixes.add(c); }
      if (fixes.size === 1) r = { ...r, exp: [...fixes][0] };
    }
    const consistent = total ? fits(r.exp) : r.exp >= this.exp;
    const bigDrop = !!total && this.exp - r.exp > total * 0.12; // deaths cost ≤10%, so a bigger drop means the bar rolled over
    if (consistent && !bigDrop) {
      this.strikes = 0; this.pend = null;
      const d = r.exp - this.exp;
      if (d > 0) { this.gain(d); this.exp = r.exp; this.pct = r.pct; this.drop = null; this.setTotal(r); }
      else if (d < 0) {
        // EXP went backwards (death without a safety charm): require a second matching read before logging it
        if (this.drop && Math.abs(this.drop.exp - r.exp) <= Math.max(2, (total || 0) * 0.0002)) {
          const lost = this.exp - r.exp;
          this.sess.expLost += lost; this.sess.deaths++;
          this.event('death', `EXP lost: -${fmtN(lost)} (death?)`);
          this.exp = r.exp; this.pct = r.pct; this.drop = null;
        } else this.drop = r;
      } else this.drop = null;
      return false;
    }
    // inconsistent: level-up candidate or bad read
    if (bigDrop || (r.exp < this.exp && this.pct != null && r.pct < this.pct)) {
      const g = Math.max(0, (total || this.exp) - this.exp) + r.exp;
      // confirmed twice -> level up (but nobody earns half a level between two reads: that's a misread)
      if (this.pend && r.exp >= this.pend.exp && r.pct >= this.pend.pct && (!total || g < total * 0.5)) {
        this.gain(g);
        const s = this.sess;
        s.level = (s.level || 0) + 1; s.levelUps++;
        this.event('level', `Level up! → ${s.level}`);
        this.exp = r.exp; this.pct = r.pct; this.total = null; this.totalPct = 0; this.setTotal(r); this.pend = null; this.strikes = 0;
        return true;
      }
      this.pend = r;
      return false;
    }
    // rebaseline after repeated disagreement (e.g. a drifting total estimate) only if the new reads agree with each
    // other AND imply about the same level total; a consistently misread digit on a still frame must not get in
    if (total && r.pct >= 1 && Math.abs(r.exp * 100 / r.pct / total - 1) > 0.03) return false;
    if (this.reb && Math.abs(this.reb.exp - r.exp) < this.reb.exp * 0.01) this.strikes++; else { this.strikes = 1; this.reb = r; }
    if (this.strikes >= 4) { this.exp = r.exp; this.pct = r.pct; this.totalStale = true; this.setTotal(r); this.strikes = 0; this.reb = null; }
    return false;
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
    else if (d >= min) { s.rec += d; (s.jumps ??= []).push(d); } // a potion (or two between reads)
    else if (d > 0) b.regen += d;
    b.cur = cur;
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
