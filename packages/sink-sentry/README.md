# @release-health/sink-sentry

[Sentry](https://docs.sentry.io/platforms/react-native/) sink for [react-native-release-health](https://github.com/release-health/react-native-release-health): tags every Sentry event with the active OTA update and rollout health status, and records release-health activity as breadcrumbs. Pair it with a crash reporter so your issues are segmented by which update they happened on.

## Install

```sh
npm install @release-health/sink-sentry react-native-release-health @sentry/react-native
```

`@sentry/react-native` is a peer dependency; the host app owns its version and its own `Sentry.init()`. Verified against `@sentry/react-native` 7.11.0 (Expo SDK 55).

## Usage

Initialize Sentry first, then pass it to the sink:

```ts
import * as Sentry from '@sentry/react-native';
import { ReleaseHealth } from 'react-native-release-health';
import { sentrySink } from '@release-health/sink-sentry';

Sentry.init({ dsn: 'https://...' });

ReleaseHealth.init({
  adapter: yourAdapter,
  sinks: [sentrySink({ sentry: Sentry })],
});
```

Passing `sentry` explicitly is recommended: it is equivalent at runtime to the default `require('@sentry/react-native')`, and it gives you a compile-time check that your installed Sentry version still matches the shape this sink expects.

## What it does

- **Tags.** On startup and on every health-status transition, the sink sets two scope tags:
  - `ota.update_id`: the active update id, or `embedded` when the app is running the bundle shipped in the binary.
  - `ota.status`: the engine status (`stable`, `probation`, `suspect`, `healthy`, `failed`, ...).

  Because the tags are re-applied on each transition, a crash captured while a fresh update is still on probation carries `ota.status: probation`, so you can find crashes that a rollout introduced.
- **Breadcrumbs.** Every release-health event is recorded as an `ota` breadcrumb (failures at level `warning`, everything else `info`), giving each Sentry issue the OTA timeline that led up to it.
- **Rollback recommendations.** A `rollback_recommended` event is also captured as a Sentry message at level `error`, so a failed rollout produces its own issue even when no crash reaches Sentry. Disable with `captureRecommendations: false`.

### Crashes are not double-captured

`crash` events are recorded as breadcrumbs only. Sentry's own error handler already captures the exception and creates the issue; this sink deliberately does not call `captureException` again, so you get one issue per crash (tagged with the OTA context above), not two.

### Native ground truth

Release-health detects native crashes heuristically (an abnormal previous exit), not with a symbolicated stack. Sentry is the ground truth for the crash itself; this sink's job is to attach the OTA rollout context to it. Use both together.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `sentry` | `require('@sentry/react-native')` | The Sentry module to drive; pass `import * as Sentry` for a compile-time shape check |
| `captureRecommendations` | `true` | Capture each `rollback_recommended` as a Sentry `error` message |
| `warn` | `console.warn` | Warning channel |

When `@sentry/react-native` is missing or incompatible, the sink logs a single actionable warning and degrades to a no-op. It never throws into the host app.

## License

MIT
