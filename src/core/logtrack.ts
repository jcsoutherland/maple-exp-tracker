/**
 * Follows the pickup log by the lines the font matcher recognises (logmatch.ts), for the Ideal UI ratio where the
 * matcher reads the screen pixel for pixel.
 *
 * Each frame gives one token per line slot (bottom-up, the newest line at the bottom): the line's text when it was
 * read, or just "something's there". New lines push the older ones up, so the frame's tokens are the previous frame's
 * shifted up by the number of new lines; that shift is the one that lines up the most recognised lines. Comparing
 * whole texts (with their amounts) rather than pixels, a moving bright background can't fake a new line, and a repeat
 * of the same line is told apart by the lines above it, by the log growing, or by brightness (a line only ever fades,
 * so one that got much brighter is a new line).
 *
 * Every line is a LogLine that moves up with the log. Its text is filled in the first time any frame reads it (a line
 * covered by a player when it arrives is read once it shows); that's when it's counted.
 */
export interface SlotToken {
  /** the line's text as read by the matcher (null = not read) */
  text: string | null;
  /** the text pixels' brightness (lines fade over time), read or not */
  lum: number;
  /** a line seems to be there (its ")" shows), read or not */
  ink: boolean;
}
export interface LogLine {
  text: string | null;
  /** its brightness when last read */
  lum?: number;
  /** on screen before following started: never counted */
  pre: boolean;
  /** its text came from OCR (may be garbled: never used to line the log up) */
  ocr?: boolean;
  /** when it arrived (the caller's clock), and what reading it got (an OCR attempt, for a line the matcher couldn't read) */
  born?: number;
  item?: unknown;
}

/** a line can look this much brighter between two frames and still be the same line (faded text over a bright,
 *  moving background measures ±60 from frame to frame on the beach) */
const BRIGHTER = 70;
/** a line that has just arrived is at least this bright (fresh lines measure 200–250, even over the beach) */
const FRESH = 165;

export class LogFollower {
  private prev: SlotToken[] | null = null;
  /** the lines in the slots, bottom-up (index = slot) */
  lines: (LogLine | null)[] = [];

  /** How far the log moved up between two frames (new lines), from the recognised lines. */
  static shift(prev: SlotToken[], cur: SlotToken[]): number {
    let best = 0, bestScore = -Infinity;
    for (let k = 0; k < cur.length; k++) {
      let sc = -0.01 * k;
      // a new line must show in slot i, at full brightness (a faded old line, or scenery, can't be new)
      for (let i = 0; i < k; i++) if ((!cur[i].ink && cur[i].text == null) || cur[i].lum < FRESH) sc -= 1;
      for (let j = 0; j + k < cur.length && j < prev.length; j++) {
        const a = prev[j], b = cur[j + k];
        if (a.text != null && b.text != null) sc += a.text !== b.text ? -1.5 : !(b.lum > a.lum + BRIGHTER) ? 1 : -1;
        // a line (read or not) where there was none: it must be new (low slots only: lines fade out from the top)
        else if ((b.text != null || b.ink) && !a.ink && a.text == null && j < 3) sc -= 0.3;
      }
      if (sc > bestScore + 1e-9) { bestScore = sc; best = k; }
    }
    return best;
  }

  /**
   * Feed one frame's slots (bottom-up). Returns the new lines (their text may still be unknown) and the lines whose
   * text this frame read for the first time (excluding lines from before following started).
   */
  update(cur: SlotToken[]): { added: LogLine[]; identified: LogLine[] } {
    const added: LogLine[] = [], identified: LogLine[] = [];
    if (!this.prev) {
      this.lines = cur.map(t => (t.ink || t.text != null ? { text: t.text, lum: t.lum, pre: true } : null));
    } else {
      // a line that can't be read this frame (faded, or a player in front) is still the line we last read there
      const prev = this.prev.map((t, j) => { const ln = this.lines[j]; return t.text == null && ln?.text != null && !ln.ocr ? { text: ln.text, lum: ln.lum ?? Infinity, ink: true } : t; });
      const k = LogFollower.shift(prev, cur);
      for (let i = 0; i < k; i++) added.push({ text: null, pre: false });
      this.lines = [...added.slice().reverse(), ...this.lines].slice(0, cur.length);
      // (added[0] is the oldest of the new lines: it sits highest, in slot k-1)
      for (let j = cur.length - 1; j >= 0; j--) { // oldest first
        const t = cur[j];
        let ln = this.lines[j];
        if (!ln && (t.ink || t.text != null)) ln = this.lines[j] = { text: null, pre: true }; // a line we never saw arrive
        if (ln && ln.text == null && t.text != null) { ln.text = t.text; if (!ln.pre) identified.push(ln); }
        if (ln && t.text != null && t.text === ln.text) ln.lum = t.lum;
      }
    }
    this.prev = cur;
    return { added, identified };
  }
}
