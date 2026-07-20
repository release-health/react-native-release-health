# Limitations

What this library can and cannot detect, stated plainly. Every claim below was either observed during the recorded end-to-end demos or follows directly from how the detection works. If you find one we missed, please open an issue; this file only stays useful while it stays honest.

## Crash detection is a heuristic, not a crash reporter

The core signal is a clean-exit flag: the native module sets it on graceful background or terminate, and a launch that follows neither is treated as an abnormal exit. That means:

- **Force-quits look like crashes.** A user swiping the app away from the app switcher, the OS reclaiming memory in the background, or a device reboot all read as abnormal exits. During probation, one such exit counts against the update exactly like a crash. The default `crashLoopThreshold` of 2 tolerates a single unlucky exit chain poorly; raise it if your users force-quit a lot and you can afford slower verdicts.
- **There are no stack traces.** The library knows that a launch ended badly, not why. It correlates; it does not symbolicate. Pair it with a crash reporter for ground truth. The [Sentry sink](../packages/sink-sentry/README.md) tags every Sentry issue with `ota.update_id` and `ota.status` precisely so the two systems tell one story.
- **Crashes before the JS engine starts are only seen on the next launch.** A native-level crash during startup never reaches the JS fatal handler, but the abnormal-exit flag still catches it at the next launch, which is when the engine judges probation anyway. What the in-session `crash` event adds (fatal JS errors, with a message) is a bonus, not the backbone.
- **A crash after `markHealthy()` is not the engine's business.** Once an update is accepted, later crashes are ordinary crash-reporter territory. Probation is a launch-window verdict, not lifetime monitoring.

## Client rollback saves the device, not the fleet

Observed live in the hot-updater demo: with `autoRollback: true`, the device reverts to the embedded bundle with no server involvement, and the next launch is stable. But as long as the update server keeps serving the bad bundle, the device re-downloads it at the next check and the cycle repeats (an oscillation between the embedded bundle and the poison). Client rollback buys each device a working session; the fleet-level fix is always server-side: disable or roll back the release at the source. Treat `rollback_executed` as first aid and `rollback_recommended` as the page that makes a human disable the release.

expo-updates has no client rollback API at all, so that adapter is recommendation-only by design; rollback happens via `eas update:roll-back-to-embedded`.

## Vendor quirks the adapters absorb (or document)

- **expo-updates reports a server rollback as a download.** `eas update:roll-back-to-embedded` stages the embedded bundle as the newest update, so the event stream shows one `update_downloaded` carrying the embedded bundle's id. Harmless (nothing goes on probation, the marker is superseded by the next real update), but your dashboards will see it. Details in the [adapter README](../packages/adapter-expo-updates/README.md).
- **The expo-updates adapter uses an exported-but-hidden API.** Update state changes are observed through `addUpdatesStateChangeListener`, which expo-updates exports but marks internal. It is the same mechanism their own `useUpdates()` hook uses, and the adapter degrades to a warning instead of crashing if a future SDK renames it, but the dependency is real and worth knowing about.
- **hot-updater has no self-subscribable event stream carrying bundle ids**, so its adapter must be wired into `HotUpdater.wrap` callbacks by the host app. Forgetting to wire the callbacks silently costs you `update_downloaded` events (and with them, probation for fresh updates). The [adapter README](../packages/adapter-hot-updater/README.md) shows the wiring.
- **hot-updater's own crash guard only covers crashes before the first frame.** Observed on-device: a crash after the first frame leaves hot-updater's crash history untouched and the bad bundle happily reinstalls. That post-first-frame window is exactly what release-health covers; the two compose rather than overlap.

## The contract on your side

- **`markHealthy()` placement is load-bearing.** Call it when the first screen is genuinely interactive. Calling it unconditionally at mount defeats probation (a broken-but-rendering update gets accepted); never calling it on some code path leaves healthy updates parked at `suspect` until relaunch.
- **Intentional reloads must be announced.** Call `ReleaseHealth.notifyReload()` before applying an update with a same-session reload, or the reload is indistinguishable from a failed launch.
- **Development builds are excluded.** `__DEV__` short-circuits probation entirely, so nothing is verified in development. Verify rollout behavior with release builds (the demo runbooks do exactly this).
- **One pending update at a time.** A newer `update_downloaded` overwrites the pending marker. If you ship updates faster than users relaunch, only the newest one is on probation; the skipped ones are never judged.

## Scope, on purpose

No update delivery, no hosted dashboard, no symbolication. Delivery belongs to your OTA vendor; the event stream is exported through sinks so you can aggregate it wherever you already look (your backend via the HTTP sink, Sentry via the Sentry sink). Fleet-level decisions like "auto-disable this release when 30% of probations fail" require server-side aggregation and stay out of scope for an on-device library.
