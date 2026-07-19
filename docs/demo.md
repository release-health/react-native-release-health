# Demo: crash-looping OTA update, rollback recommended on the 2nd launch

This procedure publishes an intentionally broken update to the example app with EAS Update, watches the health engine put it on probation, and shows `rollback_recommended` firing on the update's second launch. It is the acceptance test for the expo-updates adapter and the source of the README screen recording.

## One-time setup (needs an Expo account)

```sh
npm install -g eas-cli
eas login
cd example
eas init                # links the app to an EAS project and writes extra.eas.projectId
```

After `eas init`, put the project id into `example/app.json` under `updates.url`:

```json
"updates": {
  "url": "https://u.expo.dev/<projectId>",
  ...
}
```

The channel and branch are created at publish time (see below), so there is nothing else to set up here.

## Per-machine setup

```sh
yarn install
yarn build
yarn receiver           # terminal 1: local event receiver on port 8787
```

macOS notes: CocoaPods needs `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` in this repo. The Android emulator reaches the receiver at `http://10.0.2.2:8787` (handled automatically by the example app).

## Build a release app

expo-updates is inert in development builds, so the demo needs a release build:

```sh
cd example
npx expo prebuild                              # sync app.json changes into ios/ and android/
npx expo run:ios --configuration Release       # iOS simulator
npx expo run:android --variant release         # or: Android emulator
```

## Baseline (start recording here)

1. Launch the app. The receiver prints `session_start` with `updateId: null` (embedded bundle).
2. Tap **Mark healthy**. The receiver prints `healthy`.

## Publish the crashing update

3. In `example/src/App.tsx`, flip the demo switch:

   ```diff
   -const DEMO_CRASH = false;
   +const DEMO_CRASH = true;
   ```

   The switch schedules a fatal error 4 seconds after startup: late enough for the engine to record the launch and for the sink to flush, early enough to beat the 15 second healthy timeout, and it leaves the rollback banner readable on screen before the app dies.

4. Publish it, then revert the local edit (the broken code now lives only on the update server):

   ```sh
   cd example
   eas update --branch production --message "intentional crash demo"
   eas channel:create production   # links the "production" channel to the branch just created
   git checkout -- src/App.tsx
   ```

   The release build requests channel `production` (via the `expo-channel-name` request header), so the channel has to exist and point at the branch. Publishing first creates the branch; `eas channel:create production` then connects them. Skip the channel command on later runs once it exists.

## Drive the crash loop

5. In the app: tap **Check for update**, then **Download update**. The receiver prints `update_downloaded` with the new update id. The "Pending update" section shows the armed marker.
6. Tap **Apply downloaded update (reload)**. The app reloads into the broken update (launch 1): the receiver prints `session_start` with the update id, status shows `probation`, and 4 seconds later the app crashes (`crash` with `fatal: true`).
7. Relaunch the app from the home screen (launch 2). The engine sees a probation launch that ended abnormally, hits the crash-loop threshold, and the receiver prints:

   ```
   session_start        { updateId: <bad update> }
   update_apply_failed  { updateId: <bad update>, reason: 'crash-loop' }
   rollback_recommended { updateId: <bad update>, reason: 'crash-loop' }
   ```

   The red "Rollback recommended" banner is visible on screen until the demo crash fires again 4 seconds later. This is the acceptance criterion: the second launch of a crash-looping update produces the recommendation.

## Roll the fleet back

The adapter is recommendation-only (expo-updates has no client-side rollback API), so recovery is a server directive:

```sh
eas update:roll-back-to-embedded --branch production
```

8. Relaunch the app twice: the first launch picks up the rollback directive (and reports `update_downloaded` for the embedded bundle's id, see the note below), the next one runs the embedded bundle again (`session_start` with `updateId: null`, and no further crashes).

Note: after `rollback_recommended` fires, the engine clears the pending marker, so a third launch of the broken update reports `stable` even though the bad bundle is still running. That is by design: the update was judged once, the verdict is out, and recovery is the server's job. Wire `ReleaseHealth.onRollbackRecommended()` to your own tooling to trigger the directive automatically.

Note: a rollback-to-embedded stages the embedded bundle as the newest update, so the launch that picks it up emits one `update_downloaded` carrying the embedded bundle's id. This is expected and harmless (the embedded launch reports a null active id, so nothing goes on probation). See the adapter README's "Known limitation" section.

## Expected event stream

| Step | Events at the receiver |
| --- | --- |
| Baseline launch | `session_start (updateId: null)`, `healthy` |
| Download | `update_downloaded` |
| Apply + launch 1 | `session_start (updateId set)`, `crash (fatal)` |
| Relaunch (launch 2) | `session_start`, `update_apply_failed (crash-loop)`, `rollback_recommended (crash-loop)` |
| After server rollback | `session_start (updateId: null)` |

## Recording

```sh
# iOS simulator (Ctrl-C to stop):
xcrun simctl io booted recordVideo --codec h264 docs/assets/demo-ios.mov

# Android emulator:
adb shell screenrecord /sdcard/demo.mp4
adb pull /sdcard/demo.mp4 docs/assets/demo-android.mp4
```

Start the recording before the baseline launch and stop it after the rollback banner appears on launch 2.
