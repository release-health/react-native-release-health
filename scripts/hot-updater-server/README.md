# hot-updater demo server

Local, single-process update server for the `example-hot-updater` app: hot-updater's update-check and bundle management API backed by SQLite, with bundle files stored on the local disk. Nothing external is required.

Start it from the repo root:

```sh
yarn hot-updater-server
```

It listens on `http://localhost:3000/hot-updater`. Bundle metadata and files live in `scripts/hot-updater-server/data/` (gitignored); delete that directory to reset the demo server to a clean slate.

The `example-hot-updater/hot-updater.config.ts` CLI config and the app's `HotUpdater.wrap` baseURL both point at this server. Bundle management routes (`/api/*`, `/upload`, `/delete`, `/readText`, `/getDownloadUrl`) require the bearer token from that config; update checks and file downloads are public, like any OTA endpoint.

This is demo infrastructure. The token is a well-known placeholder and there is no TLS: run it on localhost only, and do not point production apps at it.
