# MS Classic Training Tracker

A lightweight, browser-based overlay for **MapleStory Classic World**. It watches your game window (screen capture + OCR) and keeps a running session log. No install, no backend, and everything stays on your machine.

- **EXP gained** from the EXP bar, which stays exact even when individual reads fail. Also shows EXP/hr, last-10-minute rate, and time to level. A gain bigger than the monsters on your map can give in the time since the last read (best monster × 2 kills/s × 2 for party/event bonus; 1,000 EXP/kill when the map is unknown) is a misread and never counted. A level-up needs the level number to go up, or the new level to need more EXP than the old one.
- **EXP lost** from deaths without a safety charm, tracked separately from gains.
- **Mesos and item drops** from the pickup log, with names matched to the real item list, plus icons and NPC prices.
- **EXP per map.** Maps under 1,000 EXP are dropped when a session is saved, and map names that can't be read or aren't real maps (checked against the OSMS map list) count as "Cannot determine".
- **Potions used**, counted from the HP/MP gauges 10× a second (each sharp rise is a potion, even while you are being hit), with cost and net mesos. Put your potions on the **Hotbar** (Potions tab) where they sit in the game: the number on each of those quickslot slots is read about 3× a second (template matching of the game's digit font, no OCR), so a drop of N is exactly N potions used, even when you drink while being hit, and pickups never count. While a stat's potions are counted this way, other recovery (a party skill) isn't mistaken for potions. A per-item summary sits next to the Live stats.
- **History per character**, with copyable summaries and JSON export/import. **Archive** tucks sessions into per-day groups with that day's totals; **Clear history** deletes a character's sessions.
- **Monsters**: every monster on your map plus the ones your etc drops come from (matched by the item description), as tiles with their animated image (OSMS, cached on your device), level, EXP and drop count; the latest drop's monster is highlighted and each name links to its meowdb page.
- **Character sheet**: when a session starts, a look is made instantly for your job and level from a built-in lookup table (`src/core/avatar/catalog.ts`, ids/levels/scores only, regenerated with `node dev/build-catalog.mjs`): every equipped item is the best for the job at that level (upgrade ladders scored on the job's main stat — DEX for bowmen, LUK/DEX for thieves, STR for warriors, INT for mages — from the OSMS item stats), plus the job's strongest weapon; skin, hair and face are one of a fixed pool of 10 looks per gender (🎲 picks another), and the gear upgrades as you level. Gender is picked next to your name (male by default). It's drawn with real MapleStory sprites from the [maplestory.io](https://maplestory.io) renderer in a dark spotlit room, facing the stats: idle, plus the weapon's own attack while EXP or loot comes in. Frames come from maplestory.io's CDN (see the data mirror below) and are cached on your device.
- **Auto-pause** after 45 s without EXP or loot (set it on Live or in Setup, 0 = off); it resumes by itself the moment you fight again (a new pickup-log line, MP spent on a skill, or the EXP bar moving), and the idle time isn't counted. **Stop capture** ends the window share.
- **Pop-out overlay** using Document Picture-in-Picture, which stays on top of the game.

## Use it

1. Open the site in Chrome or Edge, or run it locally (see below).
2. Click **Share game window** and pick the MapleStory window, not the whole screen. Run the game windowed or borderless.
3. Go to **Setup**, then **Grab frame**, then **Test OCR**. Each region should read correctly. If one doesn't, select it and drag a new box or adjust its threshold.
4. Go to **Live**, check name/class/level, and click **▶ Start session**. Use **⧉ Pop-out overlay** for the mini window.

Default regions are measured for a 1280×720 game window and stored as fractions of the frame, so they scale with the capture size.

## How it reads the screen

| What | When | How |
|---|---|---|
| Pickup log | Change check every 66 ms (never waits on OCR) | Each pixel is scored as "bright, greyish, brighter than its surroundings" and lines are cut on the log's fixed 13px grid; new lines are found by correlating line slots with the previous frame. A new line is copied out at once (~22 KB snapshot) into a short queue (≤60 lines, ≤30 s) that two OCR workers read in the background, so a fast party log isn't missed while OCR is busy. EXP and party-bonus lines are recognised by their yellow colour (and by shape) and skipped without OCR (the EXP bar counts EXP exactly). A line that doesn't parse is re-snapshotted while still on screen (≤4 tries) and counted once |
| HP / MP numbers | Every 1 s | Digits OCR, max value by decaying vote, 5-read median (for the display; potions only if the gauge is unreadable) |
| HP / MP gauges | Every 100 ms | Pixel colour, no OCR: how much of the bar is red / blue. A rise above the regen cutoff is a potion. The game flashes a bar for ~0.5 s when it changes, so the level from before the flash is kept and compared with the level after |
| EXP bar | Every 5 s | Digits OCR, validated against the shown %. A stray digit is repaired, and a death needs two matching reads |
| Map name | Every 10 s if the title pixels changed (every 2 s while unknown), and every 5k EXP | Must match the real map list, else "Cannot determine" |
| Name / class | Once per session | The name is "zoomed and enhanced" (6× smooth upscale + Otsu threshold), each i/l is checked against its pixels, and it needs 2 of 3 reads to agree; a name you type is never replaced |
| Level | Session start, every minute, and when the EXP bar rolls over | Colour-separated digits, 2 of 3 reads must agree; it never goes down |
| Quickslot counts | ~3×/s, only slots holding a potion | Each digit matched against templates of the game's font (per digit position, on the brightest colour channel so the potion picture behind doesn't matter); a new count needs two matching reads. Templates come from `node dev/build-glyphs.mjs` |

All of these are adjustable in **Setup → Read schedule**. Timers run in a Web Worker, so a background tab isn't throttled.

Item, map and monster data comes from [OSMS Data Explorer](https://osmsdataexplorer.com) by @ohmi, character sprites from [maplestory.io](https://maplestory.io), and the EXP table (built in) as listed on meowdb.com.

### Data mirror

To keep traffic to those community sites tiny, the app doesn't download from them per user. A weekly GitHub Action runs `dev/mirror-data.mjs`, which:
- refreshes the three OSMS lists (trimmed to the fields the app uses) at most once a week,
- downloads item icons and monster images **only if the mirror doesn't have them yet**, gently (~4 requests/s, within a time budget per run),
- publishes them with the site at `/data/` (kept between runs in the Actions cache; never committed to this repo).

The app reads everything from `/data/` and only asks the original site for a file the mirror doesn't have yet. So OSMS sees a handful of requests per week however many people use the tracker. Character frames aren't mirrored: maplestory.io takes ~30 s to render a combination it hasn't drawn before but serves one it has from its CDN in milliseconds, and the fixed pool of looks means nearly every request is such a cache hit. Each device also keeps what it loaded in IndexedDB. Locally, `npm run mirror` builds `public/data/` (`MIRROR_BUDGET_MIN=5 npm run mirror` for a short top-up).

## Project layout

```
src/core/      framework-free engine: capture, imaging, OCR (pluggable), parsers, tracker, OSMS data, storage
src/app/       Controller: runs the read schedule and owns session state
src/ui/        React UI (tabs, setup editor, avatar, PiP overlay)
dev/           replay + debug harnesses (drive the real app in headless Chrome)
prototype/     the original single-file version, kept for reference
```

`src/core` has no React dependency, so a desktop shell (Electron) can reuse it later.

## Development

```powershell
npm install
npm run dev          # http://localhost:5173
npm test             # tracker / parser unit tests (Vitest)
npm run build        # type-check + production build to dist/

# replay a gameplay recording through the real app at the live schedule and print every event
$env:MAPLE_VIDEO = "C:\path\to\recording.mp4"; npm run replay

# print every potion the HP/MP gauge reader finds in a recording
$env:MAPLE_VIDEO = "C:\path\to\recording.mp4"; node dev/debug-gauge.mjs
```

Gameplay recordings are git-ignored. Keep them out of the repo.

## Deploy

Pushing to `main` builds the site and publishes it to GitHub Pages (`.github/workflows/deploy.yml`); the workflow also runs weekly (and on demand) to refresh the data mirror. The first mirror fill (~2,100 images) takes about 10 minutes; a push only tops it up for 5 minutes.
