import { useEffect, useRef, useState } from 'react';

/**
 * The app's number box: a plain text box (no spinner arrows). Type freely; the value is applied on Enter or when the
 * box loses focus (clamped to min/max then), Escape undoes the typing. While the box is selected the mouse wheel
 * steps the value. Use it for every numeric setting so they all behave the same.
 */
export function NumberInput({ value, onChange, min = -Infinity, max = Infinity, step = 1, width, className, title, disabled }: {
  value: number | null; onChange: (v: number) => void; min?: number; max?: number; step?: number;
  width?: number; className?: string; title?: string; disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const commit = (text: string) => {
    const v = parseFloat(text.replace(/[^\d.-]/g, ''));
    if (Number.isFinite(v)) onChange(clamp(step >= 1 ? Math.round(v) : v));
    setDraft(null);
  };
  // the wheel only acts on a focused box (scrolling the page past it does nothing); a native listener, since React's
  // wheel handler is passive and can't stop the page from scrolling along
  const live = useRef({ value, step, clamp, onChange });
  // the newest value, including wheel steps not yet rendered (several ticks can land within one frame)
  if (live.current.value !== value) live.current.value = value;
  Object.assign(live.current, { step, clamp, onChange });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // one step per mouse-wheel notch (~100 px of scroll); a trackpad's many small deltas add up to steps the same way
    let acc = 0;
    const wheel = (e: WheelEvent) => {
      if (document.activeElement !== el) return;
      e.preventDefault();
      acc += e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1);
      const notches = Math.trunc(acc / 100);
      if (!notches) return;
      acc -= notches * 100;
      const l = live.current, next = l.clamp((l.value ?? 0) - notches * l.step);
      if (next === l.value) return;
      l.value = next;
      setDraft(null);
      l.onChange(next);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  return (
    <input ref={ref} type="text" inputMode="numeric" className={'num' + (className ? ' ' + className : '')} title={title} disabled={disabled}
      style={width ? { width } : undefined}
      value={draft ?? (value ?? '')}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { if (draft != null) commit(draft); }}
      onKeyDown={e => {
        if (e.key === 'Enter') { if (draft != null) commit(draft); }
        else if (e.key === 'Escape') setDraft(null);
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setDraft(null); onChange(clamp((value ?? 0) + (e.key === 'ArrowUp' ? step : -step))); }
      }} />
  );
}
