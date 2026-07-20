import { defineConfig } from 'hot-updater';
import { expo } from '@hot-updater/expo';
import {
  standaloneRepository,
  standaloneStorage,
} from '@hot-updater/standalone';

// Local demo server (scripts/hot-updater-server). Start it with
// `yarn hot-updater-server` at the repo root before deploying.
const SERVER_URL = 'http://localhost:3000/hot-updater';

// The demo server accepts this token on localhost only. If you point this
// config at anything other than the local demo server, replace it with a real
// secret and keep it out of source control.
const AUTH_TOKEN = 'demo-local-token';

export default defineConfig({
  updateStrategy: 'appVersion',
  build: expo({ sourcemap: false }),
  storage: standaloneStorage({
    baseUrl: SERVER_URL,
    commonHeaders: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  }),
  database: standaloneRepository({
    baseUrl: SERVER_URL,
    commonHeaders: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
    },
  }),
});
