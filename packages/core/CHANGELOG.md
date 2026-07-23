# react-native-release-health

## 0.1.0

### Minor Changes

- 618ae66: Add an optional `Sink.attach(context)` lifecycle. Sinks that implement it receive a `SinkContext` at startup with `getSnapshot()` and `onStatusChange()`, so they can observe health-status transitions (probation, suspect, failed) that are states rather than events. Existing sinks are unaffected.
- 5756c11: Add the health engine and public API: `ReleaseHealth.init()` with pluggable OTA adapters and sinks, `markHealthy()` probation tracking with crash-loop detection and rollback recommendations, `onRollbackRecommended()`, and the `useReleaseHealth()` hook.
