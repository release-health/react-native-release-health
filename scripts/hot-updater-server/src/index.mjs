/**
 * Local demo update server for example-hot-updater.
 *
 * One process provides everything the demo needs on localhost:
 * - hot-updater update-check + bundle management API (@hot-updater/server,
 *   SQLite via kysely) under /hot-updater
 * - bundle file storage on the local disk, exposed through the four endpoints
 *   the @hot-updater/standalone CLI plugins expect (/upload, /delete,
 *   /readText, /getDownloadUrl) plus a /files/ download route for the app
 *
 * Run with `yarn hot-updater-server` from the repo root. Data lives in
 * scripts/hot-updater-server/data/ (gitignored). This is demo infrastructure:
 * the bearer token is a well-known placeholder, so never expose the port
 * beyond localhost.
 */
import { mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { createHotUpdater } from '@hot-updater/server';
import { kyselyAdapter } from '@hot-updater/server/adapters/kysely';
import { createMigrator } from '@hot-updater/server/db';
import SQLite from 'better-sqlite3';
import { Hono } from 'hono';
import { Kysely, SqliteDialect } from 'kysely';

const PORT = 3000;
const BASE_PATH = '/hot-updater';
const AUTH_TOKEN = 'demo-local-token';
const STORAGE_PROTOCOL = 'standalone';
// Storage uris are standalone://local/<key>: the host segment acts like an S3
// bucket name so the whole key lives in the pathname. The deploy pipeline
// derives the shared content-addressed asset root by replacing the bundle-id
// path segment, which only works when the key is not in the host position.
const STORAGE_HOST = 'local';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, '..', 'data');
const STORAGE_DIR = path.join(DATA_DIR, 'storage');
const DB_PATH = path.join(DATA_DIR, 'db.sqlite');

mkdirSync(STORAGE_DIR, { recursive: true });

/** Resolves a storage key to an absolute path, refusing traversal outside. */
const storagePathFor = (key) => {
  const resolved = path.resolve(STORAGE_DIR, key);
  if (resolved !== STORAGE_DIR && !resolved.startsWith(STORAGE_DIR + path.sep)) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return resolved;
};

const keyFromStorageUri = (storageUri) => {
  const url = new URL(storageUri);
  if (
    url.protocol.replace(':', '') !== STORAGE_PROTOCOL ||
    url.host !== STORAGE_HOST
  ) {
    throw new Error(`Unsupported storage uri: ${storageUri}`);
  }
  return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
};

/**
 * Runtime storage plugin for the update-check handler: resolves the
 * standalone:// uris written by /upload to this server's own /files route
 * (using the origin the client called us on, so simulators and emulators both
 * reach the right host) and reads manifests straight from disk.
 */
const diskStorage = {
  name: 'localDiskStorage',
  supportedProtocol: STORAGE_PROTOCOL,
  profiles: {
    runtime: {
      getDownloadUrl: async (storageUri, context) => {
        const key = keyFromStorageUri(storageUri);
        const origin = context?.origin ?? `http://localhost:${PORT}`;
        const encoded = key.split('/').map(encodeURIComponent).join('/');
        return { fileUrl: `${origin}${BASE_PATH}/files/${encoded}` };
      },
      readText: async (storageUri) => {
        try {
          return await fs.readFile(
            storagePathFor(keyFromStorageUri(storageUri)),
            'utf8'
          );
        } catch {
          return null;
        }
      },
    },
  },
};

// better-sqlite3 refuses to bind JS booleans, but the hot-updater queries use
// them (enabled/should_force_update are boolean columns). Coerce to 0/1 at the
// statement boundary.
const coerceParam = (value) =>
  typeof value === 'boolean' ? (value ? 1 : 0) : value;
const coerceParams = (args) =>
  args.map((arg) =>
    Array.isArray(arg) ? arg.map(coerceParam) : coerceParam(arg)
  );

class BoolSafeSQLite extends SQLite {
  prepare(...prepareArgs) {
    const statement = super.prepare(...prepareArgs);
    for (const method of ['run', 'get', 'all', 'iterate']) {
      const original = statement[method].bind(statement);
      statement[method] = (...args) => original(...coerceParams(args));
    }
    return statement;
  }
}

const db = new Kysely({
  dialect: new SqliteDialect({ database: new BoolSafeSQLite(DB_PATH) }),
});

const hotUpdater = createHotUpdater({
  database: kyselyAdapter({ db, provider: 'sqlite' }),
  storages: [diskStorage],
  basePath: BASE_PATH,
  routes: { updateCheck: true, bundles: true },
});

const migration = await createMigrator(hotUpdater).migrateToLatest();
if (migration.operations.length > 0) {
  await migration.execute();
  console.log(
    `[hot-updater-server] applied ${migration.operations.length} schema migration step(s)`
  );
}

const app = new Hono();

const requireToken = async (c, next) => {
  if (c.req.header('authorization') !== `Bearer ${AUTH_TOKEN}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};

// Storage endpoints consumed by the @hot-updater/standalone CLI plugins.
// The key names a directory; the stored object is `${key}/${filename}` with
// the filename taken from the multipart upload, and the returned storageUri
// names the full object path. The deploy pipeline relies on this shape when
// it derives the shared content-addressed asset root from the bundle's uri.
app.post(`${BASE_PATH}/upload`, requireToken, async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  const key = form.get('key');
  if (!(file instanceof Blob) || typeof key !== 'string' || key.length === 0) {
    return c.json({ error: 'Expected multipart fields: file, key' }, 400);
  }
  const filename =
    typeof file.name === 'string' && file.name.length > 0 ? file.name : 'file';
  const objectKey = `${key.replace(/\/+$/, '')}/${filename}`;
  const target = storagePathFor(objectKey);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, new Uint8Array(await file.arrayBuffer()));
  const encoded = objectKey.split('/').map(encodeURIComponent).join('/');
  return c.json({
    storageUri: `${STORAGE_PROTOCOL}://${STORAGE_HOST}/${encoded}`,
  });
});

app.delete(`${BASE_PATH}/delete`, requireToken, async (c) => {
  const { storageUri } = await c.req.json();
  await fs.rm(storagePathFor(keyFromStorageUri(storageUri)), { force: true });
  return c.json({ ok: true });
});

app.post(`${BASE_PATH}/readText`, requireToken, async (c) => {
  const { storageUri } = await c.req.json();
  const text = await diskStorage.profiles.runtime.readText(storageUri);
  if (text === null) {
    return c.json({ error: 'Not found' }, 404);
  }
  return c.text(text);
});

app.post(`${BASE_PATH}/getDownloadUrl`, requireToken, async (c) => {
  const { storageUri } = await c.req.json();
  const origin = new URL(c.req.url).origin;
  const { fileUrl } = await diskStorage.profiles.runtime.getDownloadUrl(
    storageUri,
    { origin }
  );
  return c.json({ fileUrl });
});

// Bundle downloads for the app (and for CLI existence checks).
app.get(`${BASE_PATH}/files/*`, async (c) => {
  const key = decodeURIComponent(
    new URL(c.req.url).pathname.slice(`${BASE_PATH}/files/`.length)
  );
  try {
    const data = await fs.readFile(storagePathFor(key));
    return c.body(data, 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.byteLength),
    });
  } catch {
    return c.json({ error: 'Not found' }, 404);
  }
});

// Bundle management API used by the CLI and console: token-gated.
app.all(`${BASE_PATH}/api/*`, requireToken, (c) =>
  hotUpdater.handler(c.req.raw, { origin: new URL(c.req.url).origin })
);

// Update checks from the app: public, like any OTA update endpoint.
app.all(`${BASE_PATH}/*`, (c) =>
  hotUpdater.handler(c.req.raw, { origin: new URL(c.req.url).origin })
);

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(
    `[hot-updater-server] listening on http://localhost:${info.port}${BASE_PATH}`
  );
  console.log(`[hot-updater-server] data dir: ${DATA_DIR}`);
});
