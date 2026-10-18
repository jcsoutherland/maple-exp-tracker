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

`src/core` has no React dependency, so a desktop shell (Electron) can reuse it later.

## How it reads the screen

| What | When | How |
|---|---|---|
| Pickup log | Change check every 66 ms (never waits on OCR) | Each pixel is scored as "bright, greyish, brighter than its surroundings" and lines are cut on the log's fixed 13px (720p) grid; new lines are found by correlating line slots with the previous frame. A new line is copied out at once into a short queue (≤60 lines, ≤30 s) that two OCR workers read. Yellow lines (EXP / party bonus) are skipped when spotted, and so is anything not shaped like a log line (players or monsters behind the log): a real line ends on the learned right edge and spans ≥ 30% of the width. A line that doesn't parse is re-snapshotted while still on screen (≤4 tries) and counted once |
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
- downloads item icons and monster images only if the mirror doesn't have them yet, gently (~4 requests/s, within a time budget per run),
- publishes them with the site at `/data/` (kept between runs in the Actions cache; never committed).

The app reads `/data/` first and only asks the original site for a file the mirror doesn't have yet (`src/core/mirror.ts`); each device also keeps what it loaded in IndexedDB.

## Deploy

Pushing to `main` builds the site and publishes it to GitHub Pages (`.github/workflows/deploy.yml`). The workflow also runs weekly and on demand to refresh the mirror; a push only tops the mirror up for 5 minutes, a weekly or manual run for up to 30.
