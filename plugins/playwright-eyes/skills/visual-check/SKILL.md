---
name: visual-check
description: Look at the rendered UI before calling UI work done. Use after building or changing any page, screen, component or dashboard, or when asked to "check how it looks", "screenshot it" or "review the UI visually".
---

# Visual check

Code that compiles is not UI that works. Before saying UI work is finished, open it and look.

## Steps

1. **Find the running app.** Use the dev server URL the project already uses (check package.json scripts, README, or the terminal). If nothing is running, ask before starting one.
2. **Screenshot at two widths** with the Playwright tools: desktop (1440px) and phone (390px). For a dashboard, also take one at 1280px, the most common office laptop width.
3. **Check the states, not only the happy path.** Where the page has them, capture: empty, loading, error, and a lot of data (long names, many rows, large numbers). Thai text runs longer than English; check it doesn't break layouts.
4. **Critique the screenshots, not the code.** For each one, answer:
   - Squint test: blur your eyes. What do you see first? Is that the most important thing on the page?
   - Is there one clear focal point, or is everything the same weight?
   - Does color mean something (status, attention), or is it decoration?
   - Is anything cramped, misaligned, cut off or overflowing?
   - Does it match the rest of the app (spacing, fonts, components)?
5. **Fix, then screenshot again.** Repeat until the critique has no real problems left. Stop after three rounds and report what's still open rather than looping.
6. **Report** what you checked, what you fixed, and anything you couldn't verify.

## Don't

- Don't claim something "looks good" without a screenshot taken after the last change.
- Don't redesign beyond the task: note bigger problems, fix only what was asked.
