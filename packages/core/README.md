# react-native-release-health

[![CI](https://github.com/release-health/react-native-release-health/actions/workflows/ci.yml/badge.svg)](https://github.com/release-health/react-native-release-health/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/react-native-release-health)](https://www.npmjs.com/package/react-native-release-health)

Vendor-neutral OTA rollout safety for React Native. Tag every session with the active update and native version, put fresh updates on probation, detect failed or crash-looping rollouts on the device, recommend (or trigger) rollback, and export the whole story to any sink. Works with your OTA vendor, not against it.

<img src="https://raw.githubusercontent.com/release-health/react-native-release-health/main/docs/assets/demo-expo-updates.gif" width="300" alt="A crashing OTA update is put on probation, crashes, and on the next launch release-health reports status failed and recommends a rollback">

A deliberately crashing update goes on probation, crashes, and on the relaunch release-health declares it failed and recommends a rollback. Real recording, reproducible from the [demo runbook](https://github.com/release-health/react-native-release-health/blob/main/docs/demo.md).

## Why

OTA delivery pipelines are excellent; the feedback loop about whether a rollout actually works on devices is missing. A broken update applies, crashes on launch, and crashes again on relaunch, while the dashboard only shows downloads going up. release-health closes the loop on the device: fresh updates must prove themselves interactive within a probation window, consecutive failed launches trip a crash-loop verdict, and the verdict arrives as a typed event you can alert on or automate.

## Install

```sh
npm install react-native-release-health
```

You will also want an adapter for your OTA vendor and at least one sink:

- [@release-health/adapter-expo-updates](https://github.com/release-health/react-native-release-health/tree/main/packages/adapter-expo-updates) for expo-updates / EAS Update
- [@release-health/adapter-hot-updater](https://github.com/release-health/react-native-release-health/tree/main/packages/adapter-hot-updater) for hot-updater (includes client-side rollback)
- [@release-health/sink-http](https://github.com/release-health/react-native-release-health/tree/main/packages/sink-http) posts events to any endpoint
- [@release-health/sink-sentry](https://github.com/release-health/react-native-release-health/tree/main/packages/sink-sentry) tags Sentry issues with `ota.update_id` and `ota.status`

Requires react-native 0.76 or newer with the New Architecture (the native module is a TurboModule; the legacy bridge is not supported). Expo apps work without a config plugin.

## Usage

```tsx
import { useEffect } from 'react';
import { ReleaseHealth, useReleaseHealth } from 'react-native-release-health';
import { expoUpdatesAdapter } from '@release-health/adapter-expo-updates';
import { httpSink } from '@release-health/sink-http';

ReleaseHealth.init({
  adapter: expoUpdatesAdapter(),
  sinks: [httpSink({ url: 'https://telemetry.example.com/release-health' })],
});

function App() {
  const { status, activeUpdateId } = useReleaseHealth();

  useEffect(() => {
    // Call when your first screen is actually usable, not merely rendered.
    ReleaseHealth.markHealthy();
  }, []);

  useEffect(
    () =>
      ReleaseHealth.onRollbackRecommended(({ updateId, reason }) => {
        // reason: 'crash-loop' | 'apply-failed'
      }),
    []
  );

  return <YourApp />;
}
```

## API

### `ReleaseHealth.init(options)`

Starts the engine. Call once, as early as possible.

| Option | Default | Description |
| --- | --- | --- |
| `adapter` | required | Your OTA vendor integration (`OtaAdapter`) |
| `sinks` | `[]` | Where events go; the state machine runs regardless |
| `healthyTimeoutMs` | `15000` | Deadline for `markHealthy()` after a fresh update launches |
| `crashLoopThreshold` | `2` | Consecutive failed launches before the update is declared failed. The default fires on the second launch, after one crashed launch |
| `autoRollback` | `false` | Run `adapter.rollback()` automatically on a failed verdict, where the adapter supports it |
| `cohort` | none | Rollout cohort label attached to `session_start` |

### `ReleaseHealth.markHealthy()`

Closes the probation window for the active update. Call it when your first screen is genuinely interactive: data loaded, navigation responsive. Calling it from a splash screen defeats the purpose.

### `ReleaseHealth.onRollbackRecommended(cb)`

Subscribes to failed-update verdicts. Fires with `{ updateId, reason: 'crash-loop' | 'apply-failed' }`. Returns an unsubscribe function.

### `ReleaseHealth.notifyReload()`

Tell the engine you are about to intentionally reload (for example applying a downloaded update with `Updates.reloadAsync()`). A reload during probation restarts the probation timer instead of counting as a failed launch.

### `useReleaseHealth()`

React hook returning `{ status, activeUpdateId, nativeVersion, buildNumber, cohort }` and re-rendering on transitions.

Statuses: `starting`, `stable` (embedded or accepted bundle), `probation` (fresh update waiting for `markHealthy()`), `healthy`, `suspect` (timeout elapsed, not yet failed), `failed` (crash loop or apply failure; rollback recommended).

### The event stream

Sinks receive typed `ReleaseHealthEvent`s, each with `sessionId` and `timestamp`: `session_start`, `update_downloaded`, `update_apply_success`, `update_apply_failed`, `crash`, `healthy`, `rollback_recommended`, `rollback_executed`. See the [repo README](https://github.com/release-health/react-native-release-health#the-event-stream) for the field-by-field table.

### Writing an adapter

```ts
interface OtaAdapter {
  getActiveUpdateId(): Promise<string | null>; // null = embedded bundle
  getEmbeddedVersion(): Promise<string>;
  onEvent(cb: (e: OtaAdapterEvent) => void): Unsubscribe;
  rollback?(): Promise<boolean>; // optional; omit if the vendor has no client rollback
}
```

Without `rollback()`, the engine runs in recommendation-only mode; `autoRollback` logs a warning instead of failing. Adapters must never throw into the host app.

### Writing a sink

```ts
interface Sink {
  onEvent(event: ReleaseHealthEvent): void;
  flush?(): Promise<void>;
  attach?(context: SinkContext): void; // observe live status, e.g. to tag a crash reporter
}
```

Sink exceptions are swallowed and logged by the engine; a misbehaving sink cannot take the app down.

## How failure detection works

The native module (TurboModule, Swift/Objective-C and Kotlin, persisting to UserDefaults and SharedPreferences) records a clean-exit flag on graceful background or terminate. A launch that follows neither is treated as an abnormal exit. Fatal JS errors are additionally caught in-session via the global error handler. The engine counts consecutive failed probation launches and judges at launch start, so the verdict lands even when the crash killed the process before anything could be sent. `__DEV__` short-circuits probation, so dev reloads never count.

This is a heuristic, and the library is honest about it: it detects "the app did not exit cleanly", not "the app crashed with this stack trace". Force-quits and OS kills read as abnormal exits too. Pair it with a crash reporter for ground truth (the Sentry sink exists exactly for that), and read [docs/limitations.md](https://github.com/release-health/react-native-release-health/blob/main/docs/limitations.md) before relying on it.

## Zero-dependency bias

The core package has no runtime dependencies beyond react and react-native as peers. Persistence uses UserDefaults and SharedPreferences directly. Adapters and sinks reach their vendor SDKs as duck-typed peers and degrade to safe no-ops with one actionable warning when the peer is missing.

## License

MIT
