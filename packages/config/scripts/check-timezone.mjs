#!/usr/bin/env node
// The time zone release step (spec 0004, AC-22): prints the time zone data of Node (`tz`, `icu`),
// the `NODE_VERSION` build argument of the `app` and `web` images (fails when they differ), and the
// PostgreSQL server version of the database in `.env`, then runs the AC-21 operating day test
// (`packages/db/test/operating-day-dst.e2e-spec.ts`). Exits non zero when any step fails, so a
// release is not tagged. Needs the dev Postgres (deploy/compose.dev.yaml) and a migrated database.
//
// Usage: node check-timezone.mjs   (run from anywhere; `pnpm check:timezone` at the repo root)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TEST_FILE = 'test/operating-day-dst.e2e-spec.ts';

/**
 * The default of the `ARG NODE_VERSION=` line of a Dockerfile, or `undefined` when it has none.
 * That default is what both images build with unless a build argument overrides it.
 */
export function nodeVersionArg(dockerfileText) {
  const match = /^ARG\s+NODE_VERSION=(\S+)\s*$/m.exec(dockerfileText);
  return match ? match[1] : undefined;
}

/**
 * Compares the `NODE_VERSION` of the app and web Dockerfiles. Returns the problems found, empty
 * when both images build from the same Node version.
 */
export function nodeVersionProblems(appVersion, webVersion) {
  if (appVersion === undefined) return ['deploy/Dockerfile.app has no ARG NODE_VERSION default'];
  if (webVersion === undefined) return ['deploy/Dockerfile.web has no ARG NODE_VERSION default'];
  if (appVersion !== webVersion) {
    return [
      `NODE_VERSION differs: deploy/Dockerfile.app has ${appVersion}, deploy/Dockerfile.web has ${webVersion}`,
    ];
  }
  return [];
}

/**
 * A readable reason for a failed connection. A refused connection is an `AggregateError` with an
 * empty message, so this falls back to the error code, then to the inner errors' messages.
 */
export function errorReason(error) {
  const parts = [];
  if (error?.message) parts.push(error.message);
  if (error?.code && !parts.some((part) => part.includes(error.code))) parts.push(error.code);
  if (parts.length === 0 && Array.isArray(error?.errors)) {
    for (const inner of error.errors) {
      const reason = inner?.message || inner?.code;
      if (reason && !parts.includes(reason)) parts.push(reason);
    }
  }
  return parts.length > 0 ? parts.join(': ') : String(error);
}

/**
 * A warning when the running Node's major version is not the one the images build with, or
 * `undefined` when they match (or the Dockerfile version is not a plain number to compare).
 */
export function nodeMajorWarning(runningVersion, imageVersion) {
  if (imageVersion === undefined) return undefined;
  const running = String(runningVersion).replace(/^v/, '').split('.')[0];
  const image = String(imageVersion).replace(/^v/, '').split('.')[0];
  if (!/^\d+$/.test(image) || running === image) return undefined;
  return `WARNING: this check runs on Node ${running}, but the images use Node ${imageVersion}. The tz and icu printed above are not the images' data; the release step must run on Node ${imageVersion}.`;
}

/** The URL to ask for the PostgreSQL version: the owner URL when set, else the app URL. */
export function databaseUrl(env) {
  return env.MIGRATION_DATABASE_URL || env.DATABASE_URL || undefined;
}

/** A connection URL with its password hidden, safe to print. */
export function hidePassword(url) {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = '***';
  return parsed.toString();
}

async function serverVersion(url) {
  // `pg` is a dependency of packages/db, not of this package.
  const requireFromDb = createRequire(join(ROOT, 'packages', 'db', 'package.json'));
  const pg = requireFromDb('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query('SHOW server_version');
    return String(rows[0].server_version);
  } finally {
    await client.end();
  }
}

async function main() {
  const rootEnv = join(ROOT, '.env');
  if (!databaseUrl(process.env) && existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const problems = [];

  console.log(`Node ${process.version}: tz ${process.versions.tz}, icu ${process.versions.icu}`);

  const appVersion = nodeVersionArg(readFileSync(join(ROOT, 'deploy', 'Dockerfile.app'), 'utf8'));
  const webVersion = nodeVersionArg(readFileSync(join(ROOT, 'deploy', 'Dockerfile.web'), 'utf8'));
  console.log(`NODE_VERSION build argument: app ${appVersion}, web ${webVersion}`);
  problems.push(...nodeVersionProblems(appVersion, webVersion));
  const warning = nodeMajorWarning(process.version, appVersion);
  if (warning) console.warn(warning);

  const url = databaseUrl(process.env);
  if (!url) {
    console.error('Set MIGRATION_DATABASE_URL or DATABASE_URL (or create the root .env).');
    return 1;
  }
  try {
    console.log(`PostgreSQL server_version: ${await serverVersion(url)} (${hidePassword(url)})`);
  } catch (error) {
    console.error(`Could not read the PostgreSQL version: ${errorReason(error)}`);
    return 1;
  }

  for (const problem of problems) console.error(problem);
  if (problems.length > 0) return 1;

  const dbDir = join(ROOT, 'packages', 'db');
  const requireFromDb = createRequire(join(dbDir, 'package.json'));
  const vitest = join(dirname(requireFromDb.resolve('vitest/package.json')), 'vitest.mjs');
  const run = spawnSync(
    process.execPath,
    [vitest, 'run', '--config', './vitest.config.e2e.ts', TEST_FILE],
    { cwd: dbDir, stdio: 'inherit', env: process.env },
  );
  if (run.status !== 0) {
    console.error('The operating day test failed: do not tag this release.');
    return 1;
  }
  console.log('Time zone check passed.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
