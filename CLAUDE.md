# CLAUDE.md — MS Classic Training Tracker

## Mission

Give every MapleStory Classic player an honest, effortless picture of how their training is going, so they can
train smarter, without installing anything, creating an account or handing over their data.

## Main goal

A free tracker at https://mapleclassic.training that watches the player's game window and fills in their session
by itself: EXP, mesos, drops, potions and profit. It should be accurate enough that players trust it and simple
enough that they never need to read instructions.

## What matters most

1. **Trustworthy numbers.** A wrong number is worse than a missing one. If a reading is doubtful, leave it out
   rather than guess.
2. **EXP tracking:** EXP gained, EXP per hour, time to the next level, and EXP lost to deaths.
3. **Loot and profit:** mesos and drops picked up, potions used and what they cost, and profit per hour.
4. **Session history:** every session saved per character, so players can compare days and maps.
5. **Zero-effort setup:** share the game window, press Start, and play. The defaults should just work.
6. **Overlay:** key stats kept next to the game (a pop-out window, or the desktop overlay app).

## Principles we never break

- **Private by default.** No accounts, no servers and no analytics. Player data stays on their own computer.
- **A good neighbour.** The community fan sites we get game data from are free resources. Never add load to them:
  read from our own mirror first.
- **Plain language.** Everything a player sees is in friendly, everyday words that tell them what to do next.
- **Never lose a session.** A crash or a closed tab must not wipe out a player's progress.
- **`main` is live.** Pushing to `main` publishes the website straight away. Treat it as production.

## Where things are

- `README.md`: the player's guide. `DEVELOPMENT.md`: how it works under the hood. Update them when behaviour changes.
- `src/` is the website, and `desktop/` is the desktop overlay app. `dev/` holds testing and debugging tools.
  `prototype/` is the old version, kept for reference only; don't edit it.
- Gameplay recordings are used for testing but **must never be committed**.

```powershell
npm run dev      # run locally at http://localhost:5173
npm test         # unit tests
npm run build    # type-check + production build
npm run overlay  # preview the desktop overlay app's next version against npm run dev (close the installed app first)
$env:MAPLE_VIDEO = "C:\path\to\recording.mp4"; npm run replay   # replay a recording through the app
```

## Code Style

- Functions should do one thing. If you need the word "and" to describe it, split it.
- Name variables after what they contain, functions after what they do.
- Don't abbreviate names. `getUserProfile` not `getUsrProf`. Clarity beats brevity.
- No commented-out code. Delete it. Git remembers.
- Handle errors explicitly. Don't swallow exceptions or ignore error returns.
- Keep files under 300 lines. If a file is growing, extract a module.
- Imports go at the top, grouped: stdlib, external packages, internal modules.
- Prefer small, focused functions.
- Use early returns over nested conditionals.
- Keep code simple. No over-engineering.
- No unnecessary comments or docstrings.

## Testing

- Write tests that verify behavior, not implementation details.
- Each test should have one clear assertion. Name it after what it proves.
- Use `describe` blocks to group related tests. Use `it` or `test` for individual cases.
- Test the public API of modules, not internal functions.
- Prefer real dependencies over mocks. Only mock external services (APIs, databases).
- Every bug fix must include a regression test that fails without the fix.
- Run the full test suite before marking any task complete.

## Workflow Orchestration

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions).
- If something goes sideways, STOP and re-plan immediately. Don't keep pushing.
- Use plan mode for verification steps, not just building.
- Write detailed specs upfront to reduce ambiguity.

### 2. Subagent Strategy
- Use subagents liberally to keep the main context window clean.
- Offload research, exploration and parallel analysis to subagents.
- For complex problems, throw more compute at it via subagents.
- One task per subagent for focused execution.

### 3. Self-Improvement Loop
- After ANY correction from the user, update CLAUDE.md with a rule to prevent the same mistake.
- Write rules for yourself that are specific and actionable.
- Ruthlessly iterate on these rules until the mistake rate drops.

### 4. Verification Before Done
- Never mark a task complete without proving it works.
- Diff behavior between `main` and your changes when relevant.
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness.
- After finishing a task, run typecheck, tests and lint before calling it done.

### 5. Demand Elegance (Balanced)
- For non-trivial changes, pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution."
- Skip this for simple, obvious fixes. Don't over-engineer.
- Challenge your own work before presenting it.

### 6. Autonomous Bug Fixing
- When given a bug report, just fix it. Don't ask for hand-holding.
- Point at logs, errors and failing tests, then resolve them.
- Zero context switching required from the user.
- Go fix failing CI tests without being told how.

## Task Management

1. **Plan First:** write a plan with checkable items before coding.
2. **Verify Plan:** check in with the user before starting implementation.
3. **Track Progress:** mark items complete as you go.
4. **Explain Changes:** give a high-level summary at each step.
5. **Document Results:** note what was done and any follow-ups needed.
6. **Capture Lessons:** update CLAUDE.md after corrections.

## Core Principles

- **Simplicity First:** make every change as simple as possible, with minimal code impact.
- **No Laziness:** find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact:** changes should only touch what's necessary. Avoid introducing bugs.

## Preferences

- Ask before committing to git.
- Prefer editing existing files over creating new ones.
- Run tests after making changes.

## Lessons learned

<!-- Claude adds a rule here after each correction (see Self-Improvement Loop). -->
