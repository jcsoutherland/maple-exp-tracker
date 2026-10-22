# Development notes

How the MS Classic Training Tracker works under the hood. The player's guide is the [README](README.md).

## Development

```powershell
npm install
npm run dev          # http://localhost:5173
npm test             # tracker / parser unit tests (Vitest)
npm run build        # type-check + production build to dist/
npm run mirror       # build the data mirror in public/data (MIRROR_BUDGET_MIN=5 for a short top-up)

# replay a gameplay recording through the real app at the live schedule and print every event
# (LOG_HZ=15 for the live log rate, HOTBAR / REGIONS / LEVEL / CLASS / DIAG options: see the top of dev/replay.mjs)
$env:MAPLE_VIDEO = "C:\path\to\recording.mp4"; npm run replay

# print every potion the HP/MP gauge reader finds in a recording
$env:MAPLE_VIDEO = "C:\path\to\recording.mp4"; node dev/debug-gauge.mjs

# rebuild the quickslot digit templates from a labelled recording (labels at the top of the script)
$env:MAPLE_VIDEO = "C:\path\to\recording.mp4"; node dev/build-glyphs.mjs
```

Gameplay recordings are git-ignored. Keep them out of the repo.

## Project layout

```
src/core/      framework-free engine: capture, imaging, OCR (pluggable), parsers, tracker, potion counts, data, storage
src/app/       Controller: runs the read schedule and owns session state
src/ui/        React UI (tabs, setup editor, character stage, panels, PiP overlay)
dev/           replay / debug harnesses (drive the real app in headless Chrome), catalog, glyph and mirror builders
prototype/     the original single-file version, kept for reference
```

`src/core` has no React dependency. `desktop/` is the overlay app (Electron), described below.

## How it reads the screen

| What | When | How |
|---|---|---|
| Pickup log | Change check every 66 ms (never waits on OCR) | Each pixel is scored as "bright, greyish, brighter than its surroundings" and lines are cut on the log's fixed 13px (720p) grid; new lines are found by correlating line slots with the previous frame. A new line is copied out at once (its original pixels too) into a short queue (≤60 lines, ≤30 s) and read by **PaddleOCR** (`src/core/ocr/paddle.ts`: the PP-OCRv5 English line recogniser, Apache-2.0, run with onnxruntime-web; the model is in the data mirror), which reads the original colour image far better than Tesseract over busy scenery. Tesseract stays for the status bar, name and level, and the log falls back to it if the model can't load. Yellow lines (EXP / party bonus) are skipped when spotted, and so is anything not shaped like a log line (players or monsters behind the log): a real line ends on the learned right edge and spans ≥ 30% of the width. A line that doesn't parse is re-snapshotted while still on screen (≤4 tries) and counted once |
| HP / MP numbers | Every 1 s | Digits OCR, max value by decaying vote, 5-read median (for the display) |
| HP / MP gauges | Every 100 ms | Pixel colour: how much of the bar is red / blue. A rise above the regen cutoff is a potion when the hotbar doesn't count that stat. The game flashes a bar for ~0.5 s when it changes, so the level from before the flash is compared with the level after |
| Quickslot counts | ~3×/s, only slots holding a potion | Each digit matched against templates of the game's font (`src/core/potcount.ts`, per digit position, on the brightest colour channel so the potion picture behind doesn't matter); a new count needs two matching reads. A drop of N is N potions used, a rise is a pickup |
| EXP bar | Every 5 s | Digits OCR, validated against the shown %. A gain bigger than the map's best monster × 2 kills/s × 2 (party / event bonus) × seconds since the last read (1,000 EXP/kill when the map's monsters are unknown) is a misread and never counted. A death needs two matching reads |
| Level | Session start, every minute, and when the EXP bar rolls over | Colour-separated digits, 2 of 3 reads must agree, never goes down. A roll-over is a level-up only when the level number goes up or the new level clearly needs more EXP |
| Map name | Every 10 s if the title pixels changed (every 2 s while unknown), and every 5k EXP | Must match the real map list, else "Cannot determine" |
| Name / class | Once per session | The name is "zoomed and enhanced" (6× upscale + Otsu threshold), each i/l is checked against its pixels, and 2 of 3 reads must agree; a typed name is never replaced |

All of these are adjustable in **Setup → Read schedule**. Timers run in a Web Worker, so a background tab isn't throttled. Default regions are measured for the 720p UI and stored as fractions of the frame, so they scale with the capture size.

## Character

`src/core/avatar/catalog.ts` (ids / levels / scores only, regenerated with `node dev/build-catalog.mjs`) lists, per job branch and gender, upgrade ladders scored on the job's main stat (DEX for bowmen, LUK/DEX for thieves, STR for warriors, INT for mages). A look wears the best item of each slot for the level plus the job's strongest weapon, and is one of a fixed pool of 10 skin / hair / face combinations per gender. Frames come from the [maplestory.io](https://maplestory.io) renderer: a combination it hasn't drawn before takes ~30 s, one it has comes from its CDN in milliseconds, which is why the pool is fixed. Frames are cached on the device.

## Data and the mirror

Item, map and monster data comes from [OSMS Data Explorer](https://osmsdataexplorer.com) by @ohmi; the EXP table (`src/core/exptable.ts`) is built in, as listed on meowdb.com.

To keep traffic to those community sites tiny, the app doesn't download from them per user. The deploy workflow runs `dev/mirror-data.mjs` (weekly, on push and on demand), which:
- refreshes the three OSMS lists (trimmed to the fields the app uses) at most once a week,
- downloads the PaddleOCR model once, and item icons and monster images only if the mirror doesn't have them yet, gently (~4 requests/s, within a time budget per run),
- publishes them with the site at `/data/` (kept between runs in the Actions cache; never committed).

The app reads `/data/` first and only asks the original site for a file the mirror doesn't have yet (`src/core/mirror.ts`); each device also keeps what it loaded in IndexedDB.

## Monster leaderboard

`src/core/leaderboard.ts` (pure, tested) estimates kills per monster, stored apart from History in `met.kills` as `char → { clearedAt?, sessions: id → per-monster EXP, time, drops, time per map }`. It's stored per session, so syncing, re-importing and backfilling never count twice.

- **While a session runs**, the tracker credits each EXP gain to a monster only when it's fairly clear which one is being fought: that monster's etc drop came on this map in the last 5 minutes, or it's the map's only regular monster (`soleMob` in `data/osms.ts`). It adds the time since the previous gain, capped at 60 s. This is stored as `Session.kills`.
- **Older sessions** (no `kills`) are estimated from EXP per map. A map's EXP is split between the monsters living there that dropped etc items that session, with kills in proportion to drops (as if they drop alike); with none, it goes to the map's single regular monster, else nowhere. Time is split the same way. Each stored session carries the rule version (`RULE`); raising it makes every session still in History be worked out again.
- **`controller.syncLeaderboard()`** folds every History session not yet on the board, once the monster data has loaded. It runs on load, when a session is saved, on desktop sync and on JSON import. Sessions that ended before a character's `clearedAt` are skipped.
- **Kills shown** = `max(round(EXP ÷ the monster's base EXP), etc drops)`. Only monsters with 50+ kills are listed.

## Desktop overlay app

`desktop/` is a small Electron app: the overlay window (`overlay.html`), the main process (`main.js`: windows, menu, buttons, updates), the link (`link.js`), what it keeps on disk (`store.js`: `overlay.json`, `outbox.json`, `setup.json`, `overlay.log` in its userData folder) and the game lookup (`game.js`).

- **Two kinds of tracker page connect to it** over a WebSocket on 127.0.0.1:47821 (only the site's own origins): the website in a browser, and the app's own tracker. The app's tracker is the live site loaded with `?desktop=1` in a hidden window. It tracks when the game is shared through Windows, and gets the MapleStory window with no picker.
- **The website is home**: full stats, History and Setup. It connects by itself once the app has connected from that browser (`appSeen()`); before that, only on Pop-out or ⬇.
- **Messages** (`src/app/desktopLink.ts` ↔ `desktop/link.js`):
  - `stats`: the overlay's numbers, once a second.
  - `setup`: from the website, its Setup as raw storage entries. The app saves it and passes it to its tracker.
  - `saved`: from the app's tracker, a finished session. It goes into `outbox.json` straight away.
  - `sessions` / `ack`: the outbox goes to the website, which merges it into History by id, and the app then drops it.
  - `mirror`: the app's tracker's session, relayed to the website once a second. The controller's `remote` shows it, and the website's buttons then go back as `cmd`.
  - `pendingIdle` / `idleResolved`: an auto-pause time set on the overlay while the app tracked. The website wins only if it changed its own since the last sync (`resolveIdle`).
  - `diag`: diagnostics lines from the app's tracker, written to `overlay.log`.
- **One tracker at a time**: the overlay shows the tracker with a running session, then a paused one, then one sharing. The website greys out sharing while the app tracks.
- **Diagnostics**: `src/core/diaglog.ts` keeps a heartbeat a minute while sharing or tracking (each timer's last run, busy reads, capture, OCR, link), plus events and errors. Setup → Save diagnostics downloads it.
- **Previewing the next version**: close the installed app, run `npm run dev`, then `npm run overlay`. Run from the project, the app's tracker loads localhost:5173 (or `MAPLE_SITE`), its files go to a separate "(preview)" folder (or `OVERLAY_USER_DATA`), it never updates itself, and ⋯ shows "(preview)" by the version. Dev hooks `OVERLAY_SHOT`, `OVERLAY_TEST_START` and `OVERLAY_TEST_CMD` are described in `main.js`.
- **Releases**: the app's tracker loads the live site, so a site change the app depends on must deploy with the app release. Build with `npm run dist` and publish a release tagged `overlay-vX.Y.Z` with Setup.exe, its .blockmap, latest.yml, and the installer again as MapleTrackerOverlay.exe.

## Deploy

Pushing to `main` builds the site and publishes it to GitHub Pages (`.github/workflows/deploy.yml`). The workflow also runs weekly and on demand to refresh the mirror; a push only tops the mirror up for 5 minutes, a weekly or manual run for up to 30.
