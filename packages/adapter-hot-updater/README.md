# @release-health/adapter-hot-updater

[hot-updater](https://hot-updater.dev) adapter for [react-native-release-health](https://github.com/release-health/react-native-release-health): reports the active bundle id and download/error events so the health engine can put fresh OTA updates on probation and detect crash loops.

## Install

```sh
npm install @release-health/adapter-hot-updater react-native-release-health @hot-updater/react-native
```

`@hot-updater/react-native` is a peer dependency; the host app owns its version (0.35 or newer).

## Usage

hot-updater delivers the id of a completed update through the `onUpdateProcessCompleted` callback on `HotUpdater.wrap` (or `HotUpdater.init`), not through a subscribable event stream. Create the adapter once, pass it to `ReleaseHealth.init`, and wire its callbacks into `HotUpdater.wrap`:

```tsx
import { HotUpdater } from '@hot-updater/react-native';
import { ReleaseHealth } from 'react-native-release-health';
import { hotUpdaterAdapter } from '@release-health/adapter-hot-updater';

const adapter = hotUpdaterAdapter({ hotUpdater: HotUpdater });

ReleaseHealth.init({
  adapter,
  sinks: [
    /* httpSink(...), ... */
  ],
});

function App() {
  /* ... */
}

export default HotUpdater.wrap({
  baseURL: '<your-update-server-url>',
  updateStrategy: 'appVersion',
  onUpdateProcessCompleted: adapter.onUpdateProcessCompleted,
  onError: adapter.onError,
  onNotifyAppReady: adapter.onNotifyAppReady,
})(App);
```

Passing `HotUpdater` explicitly (rather than letting the adapter `require` it) also gives you a compile-time check that your installed hot-updater version still matches the shape the adapter expects.

When you reload to apply a downloaded update in the same session, tell the engine first so a reload during probation restarts the probation timer instead of counting against the update:

```ts
ReleaseHealth.notifyReload();
await HotUpdater.reload();
```

## Behavior

- **Events are host-wired.** hot-updater's only public event, `onProgress`, carries no bundle id, so the adapter cannot subscribe on its own. Wire `onUpdateProcessCompleted`, `onError`, and `onNotifyAppReady` as shown above. All three are safe to pass detached and never throw.
- **`downloaded` fires once per new bundle id.** A completed `UPDATE` is reported once; a repeat of the same id within a session is suppressed so the engine's crash-loop counter is not reset.
- **Rollbacks are discriminated, not spurious.** A fleet rollback (triggered from the hot-updater console) reaches the client as `status: 'ROLLBACK'`, which the adapter does not report as a download. Your event stream never shows a rollback as a phantom `update_downloaded`.
- **Client-side rollback.** The adapter implements `rollback()`, which reverts to the embedded bundle through hot-updater's `updateBundle`. Set `autoRollback: true` on `ReleaseHealth.init` to revert automatically when a crash loop is detected. `rollback()` stages the revert; it does not reload, so the embedded bundle takes effect on the next launch (or call `HotUpdater.reload()` yourself after `ReleaseHealth.notifyReload()`).
- **Degrades gracefully.** When hot-updater is missing or its native module is unavailable (development, misconfiguration), the adapter reports the embedded bundle, emits no events, omits `rollback()`, and logs a single warning. It never throws into the host app.

## Works with hot-updater's built-in crash detection

hot-updater ships its own native crash guard: it verifies a newly installed bundle on the first launch and automatically reverts to a working bundle if startup fails before the first frame. release-health covers the complementary window, from the first frame until your app calls `markHealthy()`, where the update rendered but the app is not actually usable.

The two fit together:

- A crash **before the first frame** is handled by hot-updater. It reverts the bundle and reports it through `onNotifyAppReady` as `{ status: 'RECOVERED', crashedBundleId }`; the adapter surfaces that as an `error` for the reverted bundle so your sinks record the failed apply.
- A crash or hang **after the first frame**, before `markHealthy()`, is handled by release-health: the update goes on probation, consecutive failed launches trip the crash-loop threshold, and `onRollbackRecommended` fires (and `autoRollback` reverts, if enabled).

Call `ReleaseHealth.markHealthy()` once your first screen is genuinely interactive so the probation window closes as soon as the update has proven itself.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `hotUpdater` | `require('@hot-updater/react-native').HotUpdater` | Alternative module implementation (tests, custom wrappers) |
| `warn` | `console.warn` | Warning channel |

## License

MIT
