# @release-health/adapter-hot-updater

## 0.1.0

### Minor Changes

- 56004e2: Initial release: hot-updater adapter for react-native-release-health. Reports the active bundle id (embedded detected via the minimum bundle id) and feeds the health engine through callback pass-throughs wired into HotUpdater.wrap (onUpdateProcessCompleted, onError, onNotifyAppReady), since hot-updater exposes no update event stream carrying a bundle id. Completed updates become downloaded events (deduplicated per session); fleet rollbacks arrive as ROLLBACK and are deliberately not reported as downloads; hot-updater's own crash recoveries surface as error events for the reverted bundle. Implements rollback() by staging a revert to the embedded bundle through updateBundle, enabling autoRollback. Degrades to an inert embedded-only adapter with a single warning when hot-updater is missing.
