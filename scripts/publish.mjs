#!/usr/bin/env node
// Real counterpart of publish-dry.mjs, run by the tag-triggered release
// workflow: publish every non-private workspace to npm with provenance,
// skipping versions the registry already has so a re-run after a partial
// failure (or the one-time token bootstrap) is safe.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_BASE = 'https://registry.npmjs.org';
const IS_WINDOWS = process.platform === 'win32';

// See publish-dry.mjs: Windows needs a shell for the .cmd shims, and a
// pre-joined command string avoids the deprecated args-with-shell form.
function runCommand(file, args, options) {
  return IS_WINDOWS
    ? spawnSync([file, ...args].join(' '), { ...options, shell: true })
    : spawnSync(file, args, options);
}

function parseWorkspacesListOutput(text) {
  const trimmed = text.trim();
  if (trimmed === '') {
    return [];
  }
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function listPublishableWorkspaces() {
  const result = runCommand('yarn', ['workspaces', 'list', '--no-private', '--json'], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });

  if (result.error) {
    throw new Error(`Could not run "yarn workspaces list": ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `"yarn workspaces list --no-private --json" exited with code ${result.status}:\n${result.stderr}`,
    );
  }

  return parseWorkspacesListOutput(result.stdout);
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;

async function isVersionPublished(name, version) {
  const url = `${REGISTRY_BASE}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (response.status === 200) return true;
      if (response.status === 404) return false;

      if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
        await delay(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw new Error(
        `registry returned ${response.status} ${response.statusText} for ${url} ` +
          '(neither 200 nor 404) - refusing to guess whether the version is published',
      );
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await delay(RETRY_DELAY_MS * attempt);
        continue;
      }
    }
  }

  throw new Error(
    `registry lookup failed for ${name}@${version} after ${MAX_ATTEMPTS} attempts: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function runNpmPublish(cwd) {
  const result = runCommand('npm', ['publish', '--provenance', '--access', 'public'], {
    cwd,
    stdio: 'inherit',
  });

  if (result.error) {
    return { ok: false, reason: `failed to spawn npm: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `npm publish exited with code ${result.status}` };
  }
  return { ok: true };
}

// Publish dependencies before dependents (core before the adapters and sinks)
// so an install that races the release never sees a dependent whose internal
// deps are not on the registry yet. Counting in-repo deps is enough to order
// this workspace graph; no full topo sort needed.
function sortByInternalDependencyCount(packages) {
  const names = new Set(packages.map((pkg) => pkg.name));
  const countInternal = (pkg) =>
    Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).filter((dep) => names.has(dep))
      .length;
  return [...packages].sort((a, b) => countInternal(a) - countInternal(b));
}

async function main() {
  const workspaces = listPublishableWorkspaces();

  if (workspaces.length === 0) {
    console.log('publish - no publishable (non-private) workspaces found; nothing to do.');
    return;
  }

  const packages = [];
  const failed = [];

  for (const workspace of workspaces) {
    const pkgJsonPath = path.join(ROOT_DIR, workspace.location, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      if (!pkg.name || !pkg.version) {
        failed.push({
          name: workspace.name,
          reason: `${pkgJsonPath} is missing "name" or "version"`,
        });
        continue;
      }
      packages.push({ ...pkg, location: workspace.location });
    } catch (error) {
      failed.push({
        name: workspace.name,
        reason: `could not read ${pkgJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const skipped = [];
  const published = [];

  for (const pkg of sortByInternalDependencyCount(packages)) {
    let alreadyPublished;
    try {
      alreadyPublished = await isVersionPublished(pkg.name, pkg.version);
    } catch (error) {
      failed.push({
        name: pkg.name,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (alreadyPublished) {
      console.log(`SKIP     ${pkg.name}@${pkg.version} - already on npm.`);
      skipped.push(`${pkg.name}@${pkg.version}`);
      continue;
    }

    console.log(`PUBLISH  ${pkg.name}@${pkg.version}`);
    const outcome = runNpmPublish(path.join(ROOT_DIR, pkg.location));
    if (!outcome.ok) {
      failed.push({ name: pkg.name, reason: outcome.reason });
      continue;
    }
    published.push(`${pkg.name}@${pkg.version}`);
  }

  console.log('');
  console.log('publish summary');
  console.log(`  skipped (already published): ${skipped.length > 0 ? skipped.join(', ') : 'none'}`);
  console.log(
    `  published:                   ${published.length > 0 ? published.join(', ') : 'none'}`,
  );
  console.log(`  failed:                      ${failed.length}`);

  if (failed.length > 0) {
    console.error('');
    console.error('publish FAILED for:');
    for (const failure of failed) {
      console.error(`  - ${failure.name}: ${failure.reason}`);
    }
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(
      `publish - unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exitCode = 1;
  });
}
