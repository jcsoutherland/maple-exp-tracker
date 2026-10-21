/**
 * A small diagnostics log kept on this computer: once a minute how each screen reading is doing, plus session events
 * and errors. Nothing leaves the computer; Setup → Save diagnostics downloads it to share when something goes wrong.
 * The newest DIAG_MAX lines are kept (about three hours of a running session).
 */
const KEY = 'met.diag', DIAG_MAX = 600;

let lines: string[] | null = null;
let listener: ((line: string) => void) | null = null;

function load(): string[] {
  if (lines) return lines;
  try { lines = JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]; } catch { lines = []; }
  return lines;
}

/** Add a line (kind: heartbeat, event, error, link, …). */
export function diag(kind: string, text: string) {
  const line = `${new Date().toISOString()} ${kind}: ${text}`;
  const all = load();
  all.push(line);
  if (all.length > DIAG_MAX) all.splice(0, all.length - DIAG_MAX);
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* storage full or blocked: the line is still in memory */ }
  listener?.(line);
}

/** Each new line goes here too (the app's tracker hands them to the app's own log file). */
export function onDiag(fn: (line: string) => void) { listener = fn; }

/** Errors anywhere on the page go into the log as well. */
export function captureErrors() {
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    diag('error', args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(' ').slice(0, 500));
    original(...args);
  };
  window.addEventListener('error', e => diag('error', `${e.message} (${e.filename}:${e.lineno})`));
  window.addEventListener('unhandledrejection', e => diag('error', `unhandled: ${String((e.reason as Error)?.message ?? e.reason)}`));
}

/** The log as a file to save. */
export function downloadDiag() {
  const blob = new Blob([load().join('\n') + '\n'], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `maple-tracker-diagnostics-${new Date().toISOString().slice(0, 16).replace(':', '')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}
