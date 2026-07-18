# Manual test matrix

Native behavior that unit tests cannot cover. Run this before each minor release, on both platforms, using the example app (`yarn example ios` / `yarn example android`).

## Clean-exit heuristic (phase 1)

| # | Steps | Expected on next launch | iOS | Android |
|---|---|---|---|---|
| 1 | Fresh install, first launch | "Previous launch exited cleanly" (no prior state) | | |
| 2 | Background the app (home gesture / recents), then relaunch | "Previous launch exited cleanly" | | |
| 3 | Force-kill the app (swipe away in app switcher, or stop the process from Xcode/Android Studio/`adb shell am force-stop`/`xcrun simctl terminate`), then relaunch | "Previous launch exited ABNORMALLY" | | |
| 4 | From state 3, background (not kill) and relaunch | "Previous launch exited cleanly" (flag resets each launch) | | |

Row 3 was verified on iOS on 2026-07-18 via `xcrun simctl terminate` (SIGKILL, no lifecycle notification) followed by relaunch: the reading flipped from "cleanly" to "ABNORMALLY" as expected. Row 2 (graceful backgrounding) relies on the OS delivering `UIApplicationDidEnterBackgroundNotification` / an `Activity` stopping with no others started, which requires a real Home-button gesture or app-switcher action, so scripted checks do not cover it. Needs a manual pass on a real device or simulator before the first release.

## Pending update + launch count (phase 1 storage only)

The example screen's "Simulate update download" / "Increment launch count" / "Clear pending update" buttons exercise the raw accessors. Confirm each button's effect is reflected immediately and survives an app restart (values are persisted, not in-memory).

| # | Steps | Expected | iOS | Android |
|---|---|---|---|---|
| 1 | Tap "Simulate update download" | Pending update shows a new update id + timestamp; launch count resets to 0 | pass 2026-07-18 | pass 2026-07-18 |
| 2 | Force-kill and relaunch | Same pending update still shown (persisted) | pass 2026-07-18 | pass 2026-07-18 |
| 3 | Tap "Increment launch count" a few times, force-kill, relaunch | Count persists across the relaunch | pass 2026-07-18 | pass 2026-07-18 |
| 4 | Tap "Clear pending update" | Pending update shows "None"; launch count resets to 0 | pass 2026-07-18 | pass 2026-07-18 |
