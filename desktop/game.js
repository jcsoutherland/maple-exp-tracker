// Finding the game: its window (to share through Windows, with no picker) and whether it's running at all.
const { execFile } = require('child_process');
const { desktopCapturer } = require('electron');

/** the MapleStory window, found by its title (a minimized window can't be shared, so it isn't found) */
async function findGame() {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  return sources.find(s => /^maplestory/i.test(s.name.trim())) ?? sources.find(s => /maplestory/i.test(s.name) && !/tracker|overlay/i.test(s.name)) ?? null;
}

/** Is the game running at all? (rejects when Windows can't say) */
function gameProcessRunning() {
  return new Promise((resolve, reject) => execFile('tasklist', ['/FI', 'IMAGENAME eq MapleStory.exe', '/NH'], { windowsHide: true }, (err, out) => {
    if (err) reject(err);
    else resolve(/maplestory\.exe/i.test(out));
  }));
}

module.exports = { findGame, gameProcessRunning };
