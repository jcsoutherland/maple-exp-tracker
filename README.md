# Maple EXP Tracker

A lightweight, browser-based overlay for **MapleStory Classic World**. It watches your game window (screen capture + OCR) and keeps a running session log. No install, no backend, and everything stays on your machine.

- **EXP gained** from the EXP bar, which stays exact even when individual reads fail. Also shows EXP/hr, last-10-minute rate, and time to level.
- **EXP lost** from deaths without a safety charm, tracked separately from gains.
- **Mesos and item drops** from the pickup log, with names matched to the real item list, plus icons and NPC prices.
- **EXP per map.** Maps under 1,000 EXP are dropped when a session is saved, and map names that can't be read or aren't real maps (checked against the OSMS map list) count as "Cannot determine".
- **HP/MP used**, converted to potion counts and cost (Meat, Lemon, Red/Orange/White/Blue Potion, Mana Elixir), plus net mesos.
- **History per character**, with copyable summaries and JSON export/import.
- **Pixel-art character sheet**: an original pixel-art explorer for your job (Warrior, Magician, Bowman, Thief or Beginner) idles, and plays its class attack while EXP or loot comes in.
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
| Pickup log | Change check every 66 ms; OCR only when a line appears | Each pixel is scored as "bright, greyish, brighter than its surroundings". Lines are cut on the log's fixed 13px grid, and new lines are found by correlating line slots with the previous frame, which survives fading. Each line is OCR'd when it appears, retried if it doesn't parse, and counted once |
| HP / MP | Every 1 s | Digits OCR, max value by decaying vote, 5-read median |
| EXP bar | Every 5 s | Digits OCR, validated against the shown %. A stray digit is repaired, and a death needs two matching reads |
| Map name | Every 10 s if the title pixels changed (every 2 s while unknown), and every 5k EXP | Must match the real map list, else "Cannot determine" |
| Name / class | Once per session | |
| Level | Session start and each detected level-up | |

All of these are adjustable in **Setup → Read schedule**. Timers run in a Web Worker, so a background tab isn't throttled.

Item and map data comes from [OSMS Data Explorer](https://osmsdataexplorer.com) by @ohmi. It's fetched on first use and cached in IndexedDB, so each file and icon is downloaded only once.

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
```

Gameplay recordings are git-ignored. Keep them out of the repo.

## Deploy

Pushing to `main` builds the site and publishes it to GitHub Pages (`.github/workflows/deploy.yml`).
