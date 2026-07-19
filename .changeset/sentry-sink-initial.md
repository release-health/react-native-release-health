---
"@release-health/sink-sentry": minor
---

Initial release: Sentry sink that tags every Sentry event with `ota.update_id` and `ota.status`, records release-health activity as `ota` breadcrumbs, and captures rollback recommendations as Sentry messages. Peer + duck-typed client, no hard dependency on @sentry/react-native; degrades to a no-op when Sentry is missing.
