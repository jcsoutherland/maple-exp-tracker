# MS Classic Training Tracker

A training tracker for **MapleStory Classic World** that runs in your browser. It watches your game window and keeps track of your session for you: EXP, mesos, drops, potions and more. Nothing to install, and everything stays on your computer.

**Open it:** https://mapleclassic.training (Chrome or Edge)

## What it tracks

- **EXP**: total gained, EXP per hour, EXP per map, time to your next level, and EXP lost to deaths
- **Mesos and drops**: everything you pick up, with item icons and what an NPC pays for it
- **Potions**: exactly how many of each potion you drink and what they cost
- **Loot & profit**: mesos plus drops minus potions, and your profit per hour
- **Monsters**: what lives on your map, their level, EXP and weaknesses, and what you're training on
- **Level goal**: pick a target level and see how much EXP and time it will take
- **History**: every session saved per character, grouped by day if you archive them

## Getting started

1. Run MapleStory in **windowed** or **borderless** mode.
2. Open the site and click **Share game window**. Pick the MapleStory window (not your whole screen).
3. Open the **Setup** tab and click **Grab frame**, then **Test OCR**. Each box on the picture should sit on the thing it reads (map name, HP, MP, EXP, pickup log and so on). If one is off, select it in the list and drag a new box over the right spot.
4. Go to the **Live** tab, check your name, class and level, and click **▶ Start session**.

That's it. Play as usual and the dashboard fills in by itself. When you're done, **■ End & save** saves the session to the History tab and clears the dashboard for your next one.

## Counting your potions

1. Open your **quickslot** in the game so your potions are visible.
2. On the **Potions** tab, drag each potion from the lists onto the hotbar slot where it sits in your game.
3. In **Setup → Test OCR**, the **Quickslot** row shows the number it reads on each of those slots. If it's wrong, drag the quickslot box so its grid lines sit on the slot borders.

Each potion's count is then read live: when it goes down you drank one, and potions you pick up aren't counted. Potions that aren't on your hotbar are counted as the **Active** potion at the top of each list.

## The tabs

- **Live**: your session at a glance: character, stats, monsters, potions, level goal, kills estimate, charts, activity and loot & profit.
- **Potions**: your hotbar and potion lists (drag one to the top to make it Active).
- **Drops**: everything picked up this session, with links to player prices on meowdb and meso.watch.
- **Killcount**: your all-time leaderboard per character: roughly how many of each monster you've killed (once a monster passes 50), with the EXP it gave you, time spent on it, your top map for it, and when you first and last hunted it. Kills are an estimate, worked out from EXP and etc drops, and a session's kills are added when it ends. Clearing History doesn't touch it; **Clear leaderboard** starts it over.
- **History**: past sessions per character. **Archive sessions** groups them by day with daily totals, **Clear history** deletes a character's sessions, and you can export or import them as a JSON file.
- **Setup**: screen regions, read speeds and other settings.

## Tips

- **Auto-pause**: after 45 seconds without EXP or loot the session pauses itself (idle time isn't counted) and resumes the moment you fight again. Change the time on the Live tab (0 = off).
- **⧉ Pop-out overlay** opens a small always-on-top window with your key stats, to keep next to the game (or the desktop overlay app, once you have it).
- **⏹ Stop sharing** stops sharing your game window. A session that's running is ended and saved to History first.
- After a session ends, its numbers stay on the Live tab until you start the next one.
- Number boxes: type a value and press Enter, or click a box and use the mouse wheel.
- The 🎲 on your character picks a different look; your gear always matches your class and level.
- Your history lives in this browser. If you clear your browser's site data it's gone, so use **Export JSON** on the History tab to keep a backup.

## Desktop overlay app

The ⬇ button next to Pop-out overlay gets the overlay as its own small Windows app: always on top of the game, with no address bar.

- **Start session (▶)** shares the game and starts tracking in one click. It asks whether to share **With Windows** (the app reads the game, no browser needed) or **In the browser** (this website reads it).
- **⏸ / ▶** pause and resume, and the red **■** ends the session and saves it. The game stays shared, ready for the next one.
- **Super compact**: the small button in the bottom-right corner shrinks the overlay to one row with just EXP/h, time to level and pause/resume. The same button (or right-click → ⋯ menu) brings everything back, and the overlay remembers which you used last.
- The **⋯** menu has **Open full stats** (this website), **Share game window** or **Stop sharing**, auto-pause, always on top, tips and more.
- **Your full stats and history are on this website.** Sessions tracked through Windows come into History by themselves whenever the app and this page are open at the same time. While some are waiting, ⋯ shows **Sync stats**.
- While the app tracks, this page shows the same session live, and its buttons work on it too.
- The app uses your Setup from this website (open the website once while the app is running and it copies it over). Change Setup here, and the app picks it up the next time both are open.

## Something not right?

- **Save diagnostics** (Setup tab) saves a small log of what the tracker did over the last few hours. Share it when you report a problem.

- **Nothing is being read**: make sure you shared the game window (not a browser tab or your whole screen) and that the game isn't minimized.
- **The overlay says MapleStory is minimized**: Windows can't share a minimized window. Bring the game back up and press Start session again.
- **A number is read wrong**: run **Setup → Test OCR** and check that box sits on the right spot.
- **Drops missed in a busy party**: the pickup log can scroll faster than it can be read; solo and small parties are the most accurate.

Building or changing the tracker itself? See [DEVELOPMENT.md](DEVELOPMENT.md).
