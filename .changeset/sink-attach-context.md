---
"react-native-release-health": minor
---

Add an optional `Sink.attach(context)` lifecycle. Sinks that implement it receive a `SinkContext` at startup with `getSnapshot()` and `onStatusChange()`, so they can observe health-status transitions (probation, suspect, failed) that are states rather than events. Existing sinks are unaffected.
