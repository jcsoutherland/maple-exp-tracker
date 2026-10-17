import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { Controller } from '../app/controller';
import { itemIcon } from '../core/data/osms';

export const CtrlContext = createContext<Controller | null>(null);

/** Re-render whenever the controller notifies (tick results, session changes). */
export function useCtrl(): Controller {
  const c = useContext(CtrlContext)!;
  useSyncExternalStore(c.subscribe, c.getVersion);
  return c;
}

/** Item icon object URL (fetched once from OSMS, then from IndexedDB). */
export function useItemIcon(id: number | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (id) itemIcon(id).then(u => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [id]);
  return url;
}

let toastTimer = 0;
export function toast(msg: string) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 3000);
}
