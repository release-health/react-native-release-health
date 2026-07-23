#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_BASE = 'https://registry.npmjs.org';
const IS_WINDOWS = process.platform === 'win32';

// Windows needs a shell to resolve the yarn/npm .cmd shims, but passing an args
// array together with `shell: true` is deprecated (DEP0190): Node would only
// concatenate them. All arguments here are static and space-free, so pre-join
// them into the single command string the shell expects.
function runCommand(file, args, options) {
  return IS_WINDOWS
    ? spawnSync([file, ...args].join(' '), { ...options, shell: true })
    : spawnSync(file, args, options);
}

export function parseWorkspacesListOutput(text) {
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

export function buildVersionUrl(name, version) {
  return `${REGISTRY_BASE}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

export function classifyRegistryStatus(status) {
  if (status === 200) return 'published';
  if (status === 404) return 'not-published';
  return 'ambiguous';
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 400;

async function isVersionPublished(name, version) {
  const url = buildVersionUrl(name, version);
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      const outcome = classifyRegistryStatus(response.status);

      if (outcome === 'published') return true;
      if (outcome === 'not-published') return false;

      if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
        await delay(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw new Error(
        `registry returned ${response.status} ${response.statusText} for ${url} ` +
          '(neither 200 nor 404) - treating as ambiguous, not "unpublished"',
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

function runNpmPublishDryRun(cwd) {
  const result = runCommand('npm', ['publish', '--dry-run'], {
    cwd,
    stdio: 'inherit',
  });

  if (result.error) {
    return { ok: false, reason: `failed to spawn npm: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { ok: false, reason: `npm publish --dry-run exited with code ${result.status}` };
  }
  return { ok: true };
}

async function main() {
  const workspaces = listPublishableWorkspaces();

  if (workspaces.length === 0) {
    console.log('publish:dry - no publishable (non-private) workspaces found; nothing to do.');
    return;
  }

  const skipped = [];
  const dryRun = [];
  const failed = [];

  for (const workspace of workspaces) {
    const pkgJsonPath = path.join(ROOT_DIR, workspace.location, 'package.json');

    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    } catch (error) {
      failed.push({
        name: workspace.name,
        reason: `could not read ${pkgJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const { name, version } = pkg;
    if (!name || !version) {
      failed.push({
        name: workspace.name,
        reason: `${pkgJsonPath} is missing "name" or "version"`,
      });
      continue;
    }

    let published;
    try {
      published = await isVersionPublished(name, version);
    } catch (error) {
      failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    if (published) {
      console.log(`SKIP     ${name}@${version} - already on npm, nothing new to dry-run.`);
      skipped.push(`${name}@${version}`);
      continue;
    }

    console.log(`DRY-RUN  ${name}@${version} - not on npm yet, running npm publish --dry-run.`);
    const outcome = runNpmPublishDryRun(path.join(ROOT_DIR, workspace.location));
    if (!outcome.ok) {
      failed.push({ name, reason: outcome.reason });
      continue;
    }
    dryRun.push(`${name}@${version}`);
  }

  console.log('');
  console.log('publish:dry summary');
  console.log(`  skipped (already published): ${skipped.length > 0 ? skipped.join(', ') : 'none'}`);
  console.log(`  dry-run ran successfully:    ${dryRun.length > 0 ? dryRun.join(', ') : 'none'}`);
  console.log(`  failed:                      ${failed.length}`);

  if (failed.length > 0) {
    console.error('');
    console.error('publish:dry FAILED for:');
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
      `publish:dry - unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exitCode = 1;
  });
}
