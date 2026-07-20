# Demo: crash-looping OTA update on hot-updater, with automatic client rollback

The same crash-loop procedure as [demo.md](./demo.md), on the hot-updater adapter instead of expo-updates, and fully local: the update server runs on your machine, so no accounts or cloud services are needed. It also demonstrates the two things this adapter does that the expo-updates one cannot: client-side automatic rollback (`autoRollback: true`), and rollbacks arriving as a discriminated status instead of a phantom download.

This is the acceptance test for `@release-health/adapter-hot-updater`.

## One-time setup (all local)

1. `yarn install && yarn build` at the repo root.
2. No accounts, tokens, or cloud resources. The demo server stores bundle metadata in SQLite and bundle files on disk under `scripts/hot-updater-server/data/` (delete that directory to reset).

## Per-run setup

Three terminals at the repo root:

```sh
yarn receiver            # terminal 1: release-health event stream (port 8787)
yarn hot-updater-server  # terminal 2: local update server (port 3000)
```

Terminal 3 runs the commands below. If you have run the demo before, reset the server first: stop it, `rm -rf scripts/hot-updater-server/data`, start it again.

## Build a release app

Updates only work in release builds; development builds always run the embedded bundle.

```sh
cd example-hot-updater
npx expo prebuild -p ios --no-install
cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install && cd ..
xcodebuild ONLY_ACTIVE_ARCH=YES \
  -workspace ios/ReleaseHealthHotUpdaterExample.xcworkspace \
  -scheme ReleaseHealthHotUpdaterExample -configuration Release \
  -sdk iphonesimulator -derivedDataPath ios/build \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet
xcrun simctl install booted \
  ios/build/Build/Products/Release-iphonesimulator/ReleaseHealthHotUpdaterExample.app
```

## Baseline (start recording here)

```sh
xcrun simctl launch booted releasehealth.hotupdater.example
```

The screen shows status `stable`, active update `embedded bundle`, and matching bundle and embedded-bundle ids. The receiver prints `session_start update=embedded`.

## Deploy the crashing update

In `example-hot-updater/src/App.tsx`, flip both demo switches:

```diff
-const DEMO_CRASH = false;
+const DEMO_CRASH = true;
-const AUTO_ROLLBACK = false;
+const AUTO_ROLLBACK = true;
```

Deploy it, then flip both back (the deploy bundles the working tree at deploy time):

```sh
npx hot-updater deploy -p ios -t 1.0.0 -c production -m "intentional crash demo"
```

The crash fires 4 seconds after launch: after `init()` records the session and the sink flushes, before the 15 second healthy timeout, and well after the first frame, which matters because hot-updater's own crash guard only covers crashes before the first frame. This demo exercises exactly the window that guard does not.

## Drive the crash loop

Each cycle is terminate plus launch; `HotUpdater.wrap` checks for updates at every entry, downloads in the background, and applies on the next launch.

```sh
# Download launch: picks up the poison update
xcrun simctl terminate booted releasehealth.hotupdater.example
xcrun simctl launch booted releasehealth.hotupdater.example
# receiver: session_start update=embedded, then update_downloaded update=<poison id>

# Poison launch 1: update active, on probation, crashes at +4s
xcrun simctl terminate booted releasehealth.hotupdater.example
xcrun simctl launch booted releasehealth.hotupdater.example
# receiver: session_start update=<poison id>, then crash (fatal)

# Poison launch 2: crash loop detected, rollback recommended AND executed
xcrun simctl terminate booted releasehealth.hotupdater.example
xcrun simctl launch booted releasehealth.hotupdater.example
# receiver: session_start, update_apply_failed reason=crash-loop,
#           rollback_recommended reason=crash-loop, rollback_executed success=true
# The banner "Rollback recommended for <id> (crash-loop)" is visible until the +4s crash.

# Recovery launch: the client-side rollback has staged the embedded bundle
xcrun simctl terminate booted releasehealth.hotupdater.example
xcrun simctl launch booted releasehealth.hotupdater.example
# receiver: session_start update=embedded, no crash
```

`rollback_executed success=true` is the adapter's `rollback()` staging a revert to the embedded bundle through hot-updater's `updateBundle`; no server action was involved in the recovery.

## Roll the fleet back

Watch the recovery launch's receiver line: right after recovering, the app downloads the poison update again. Client-side rollback saves the device, but the server is still serving the bad bundle to every device on app version 1.0.0 (hot-updater's own crash history does not apply, because these crashes happen after the first frame). The fleet fix is server-side, here by disabling the bundle through the management API:

```sh
curl -X PATCH -H 'Authorization: Bearer demo-local-token' \
  -H 'Content-Type: application/json' -d '{"enabled": false}' \
  http://localhost:3000/hot-updater/api/bundles/<poison id>
```

(The hot-updater console, `npx hot-updater console` in `example-hot-updater/`, does the same from a UI.)

```sh
# The re-downloaded poison runs once more; the server now responds with a
# ROLLBACK directive, which hot-updater stages while the bundle crashes at +4s
xcrun simctl terminate booted releasehealth.hotupdater.example
xcrun simctl launch booted releasehealth.hotupdater.example

# Back on the embedded bundle for good; no further downloads
xcrun simctl terminate booted releasehealth.hotupdater.example
xcrun simctl launch booted releasehealth.hotupdater.example
```

Note what is absent from the event stream: the ROLLBACK directive never appears as an `update_downloaded`. hot-updater reports rollbacks as a discriminated status and the adapter suppresses them, unlike the expo-updates rollback-to-embedded, which surfaces as a download of the embedded bundle id (see the known limitation in the expo-updates adapter README).

## Expected event stream

| Step | Events (receiver) |
| --- | --- |
| Baseline | `session_start update=embedded` |
| Download launch | `session_start update=embedded`, `update_downloaded update=<poison>` |
| Poison launch 1 | `session_start update=<poison>`, `crash fatal jsMessage="...intentional startup crash"` |
| Poison launch 2 | `session_start update=<poison>`, `update_apply_failed reason=crash-loop`, `rollback_recommended reason=crash-loop`, `rollback_executed success=true`, `crash fatal` |
| Recovery (client) | `session_start update=embedded`, then `update_downloaded update=<poison>` again (server still serves it) |
| Disable bundle + relaunch | `session_start update=<poison>`, `crash fatal` (ROLLBACK directive staged silently; no phantom download) |
| Final launch | `session_start update=embedded`, nothing further |

## Recording

```sh
# iOS simulator (Ctrl-C to stop):
xcrun simctl io booted recordVideo --codec h264 --force docs/assets/demo-hot-updater-ios.mov
```

## Troubleshooting

- **No `update_downloaded` after deploying**: check the update server terminal for errors and confirm the app can reach `http://localhost:3000/hot-updater/version`. The simulator shares the host network; a physical device needs your machine's LAN IP in `UPDATE_SERVER_URL` and the deploy config.
- **`Check failed` or downloads hang in the app**: the demo server must be started before the app launches; `HotUpdater.wrap` checks once at entry.
- **The app keeps crash-looping after the client rollback**: expected until the bundle is disabled server-side; that is the point of the fleet-rollback section above.
- **Reset everything**: terminate the app, `xcrun simctl uninstall booted releasehealth.hotupdater.example`, stop the server, `rm -rf scripts/hot-updater-server/data`, reinstall and relaunch.
