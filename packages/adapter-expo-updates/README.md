# @release-health/adapter-expo-updates

[expo-updates](https://docs.expo.dev/versions/latest/sdk/updates/) adapter for [react-native-release-health](https://github.com/release-health/react-native-release-health): reports the active update id and edge-triggered download/error events so the health engine can put fresh OTA updates on probation and detect crash loops.

## Install

```sh
npm install @release-health/adapter-expo-updates react-native-release-health expo-updates
```

`expo-updates` is a peer dependency; the host app owns its version (SDK 55 or newer).

## Usage

```ts
import { ReleaseHealth } from 'react-native-release-health';
import { expoUpdatesAdapter } from '@release-health/adapter-expo-updates';

ReleaseHealth.init({
  adapter: expoUpdatesAdapter(),
  sinks: [
    /* httpSink(...), ... */
  ],
});
```

Optionally pass the module explicitly. This is equivalent at runtime, and it gives you a compile-time check that your installed expo-updates version still matches the shape the adapter expects:

```ts
import * as Updates from 'expo-updates';

expoUpdatesAdapter({ updatesModule: Updates });
```

When applying a downloaded update in the same session, tell the engine first so a reload during probation restarts the probation timer instead of counting against the update:

```ts
ReleaseHealth.notifyReload();
await Updates.reloadAsync();
```

## Behavior

- **Recommendation-only.** expo-updates has no client-side rollback API (rollbacks are server directives, for example `eas update:roll-back-to-embedded`), so the adapter does not implement `rollback()`. The engine detects this and stays in recommendation-only mode; `autoRollback: true` logs a warning instead of failing. Subscribe with `ReleaseHealth.onRollbackRecommended()` and trigger the server-side rollback from your own tooling.
- **`downloaded` fires once per new update id.** The adapter watches expo-updates state change events and emits on edges, not on every snapshot. A download that already happened before the adapter subscribed (a pending update from a previous session) is treated as baseline and not re-announced; the engine already recorded it, and re-announcing would reset the crash-loop counter.
- **`applied` is never emitted.** expo-updates applies updates on the next launch (or an explicit `reloadAsync()`); the engine detects the apply by comparing the active update id against its pending marker at launch.
- **Degrades gracefully.** In development builds, Expo Go, or when expo-updates is missing or misconfigured, the adapter reports the embedded bundle, emits no events, and logs a single warning. It never throws into the host app.

### Known limitation: server rollback-to-embedded

A server rollback-to-embedded (`eas update:roll-back-to-embedded`) is delivered by staging the embedded bundle as the newest update, so expo-updates reports the embedded manifest in the downloaded slot. The adapter therefore emits one `update_downloaded` carrying the embedded bundle's update id. This is harmless: on the next launch the embedded bundle runs, the active update id is null, so nothing is put on probation, and the marker is superseded by the next real update. It does mean a rollback-to-embedded shows up in your event stream as a `update_downloaded` for the embedded id rather than as a distinct rollback event.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `updatesModule` | `require('expo-updates')` | Alternative module implementation (tests, custom wrappers) |
| `warn` | `console.warn` | Warning channel |

## License

MIT
