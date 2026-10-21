import type { Controller } from './controller';
import { inDesktopApp, type LinkHandlers } from './desktopLink';
import { resolveIdle, setupBundle } from './desktopSync';

/** when the website last sent its Setup to the app (an auto-pause change made after it wins over the overlay's) */
const SYNC_AT_KEY = 'met.desktopSyncAt';
const loadSyncAt = () => { try { return Number(localStorage.getItem(SYNC_AT_KEY)) || 0; } catch { return 0; } };
const saveSyncAt = (t: number) => { try { localStorage.setItem(SYNC_AT_KEY, String(t)); } catch (e) { console.warn('could not save the sync time', e); } };
/** how often the website checks whether its Setup changed */
const SETUP_CHECK_MS = 3000;

/** What a tracker page does with the desktop app's messages. */
export function linkHandlers(c: Controller): LinkHandlers {
  let timer = 0, lastSent = '', syncedBefore = 0;
  const pushSetup = () => {
    const bundle = setupBundle(localStorage), json = JSON.stringify(bundle);
    if (json === lastSent || !c.desktop.sendSetup(bundle)) return;
    lastSent = json;
    saveSyncAt(Date.now());
  };
  return {
    cmd: (cmd, value) => c.overlayCmd(cmd, value),
    sessions: list => { c.importSessions(list); c.desktop.ack(list.map(s => s.id)); },
    pendingIdle: p => {
      const value = resolveIdle(p, c.settings.idleChangedAt, syncedBefore);
      if (value != null) c.updateSettings({ idlePauseSec: value });
      c.desktop.idleResolved();
    },
    mirror: snap => c.applyMirror(snap),
    setup: bundle => { if (inDesktopApp()) c.applySetup(bundle); },
    connected: () => {
      if (inDesktopApp()) return;
      syncedBefore = loadSyncAt(); lastSent = '';
      clearInterval(timer);
      timer = window.setInterval(pushSetup, SETUP_CHECK_MS);
      pushSetup();
    },
  };
}
