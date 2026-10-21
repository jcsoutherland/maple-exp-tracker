// What the app keeps on this computer (its userData folder): its own settings, sessions waiting for the website's
// History, the website's Setup for the app's tracker, and a small log for tracking down problems.
const fs = require('fs');
const path = require('path');

/** the log is kept to about this size: the older half moves to overlay.old.log */
const LOG_MAX_BYTES = 1_000_000;

function createStore(dir) {
  const file = name => path.join(dir, name);
  function readJson(name, fallback) {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') log(`could not read ${name}: ${e.message}`);
      return fallback;
    }
  }
  /** written to a temporary file first, so a crash mid-write never leaves a broken file */
  function writeJson(name, value) {
    try {
      fs.writeFileSync(file(name + '.tmp'), JSON.stringify(value));
      fs.renameSync(file(name + '.tmp'), file(name));
    } catch (e) { log(`could not save ${name}: ${e.message}`); }
  }
  function log(text) {
    const line = `${new Date().toISOString()} ${text}\n`;
    try {
      const f = file('overlay.log');
      if (fs.existsSync(f) && fs.statSync(f).size > LOG_MAX_BYTES) fs.renameSync(f, file('overlay.old.log'));
      fs.appendFileSync(f, line);
    } catch (e) { console.error('overlay log:', e.message, line); }
  }

  const state = () => readJson('overlay.json', {});
  return {
    log,
    /** the overlay's own settings: position, tips, the last session's numbers, an auto-pause change not yet synced */
    state,
    saveState: patch => writeJson('overlay.json', { ...state(), ...patch }),
    /** sessions the app's tracker ended, waiting for the website's History */
    outbox: () => readJson('outbox.json', []),
    addToOutbox(session) {
      const list = readJson('outbox.json', []);
      if (!list.some(s => s.id === session.id)) writeJson('outbox.json', [...list, session]);
    },
    /** the website has these in History now */
    removeFromOutbox(ids) {
      const done = new Set(ids), list = readJson('outbox.json', []);
      if (list.some(s => done.has(s.id))) writeJson('outbox.json', list.filter(s => !done.has(s.id)));
    },
    /** the website's Setup (raw storage entries), or null before the first sync */
    setup: () => readJson('setup.json', null),
    saveSetup: bundle => writeJson('setup.json', bundle),
  };
}

module.exports = { createStore };
