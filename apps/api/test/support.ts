import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createDatabase, type DatabaseConnection } from '@ssdashboard/db';

// These suites run the built entry points exactly as the image does, so build first:
// `pnpm build`. They need the dev database (deploy/compose.dev.yaml) for DATABASE_URL.
export const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const ROOT_ENV = new URL('../../../.env', import.meta.url);

export const UNREACHABLE_DB = 'postgres://nobody:nothing@127.0.0.1:1/none';

export function requireBuild(entry: string): string {
  const path = `${DIST}${entry}`;
  if (!existsSync(path))
    throw new Error(`${path} is missing. Run \`pnpm build\` before the e2e tests.`);
  return path;
}

export function devDatabaseUrl(): string {
  if (!process.env.DATABASE_URL && existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL (or create the root .env) to run the e2e tests.');
  return url;
}

/** The owner role's URL: it creates scratch databases and migrates them. */
export function ownerDatabaseUrl(): string {
  devDatabaseUrl();
  return process.env.MIGRATION_DATABASE_URL ?? devDatabaseUrl();
}

export async function withAdmin<T>(
  run: (admin: DatabaseConnection['pool']) => Promise<T>,
): Promise<T> {
  const { pool } = createDatabase(ownerDatabaseUrl(), { max: 1 });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}

export async function createScratchDatabase(): Promise<{ name: string; url: string }> {
  const name = `ssd_test_${randomBytes(4).toString('hex')}`;
  await withAdmin((client) => client.query(`CREATE DATABASE ${name}`));
  const url = new URL(ownerDatabaseUrl());
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

export async function dropScratchDatabase(name: string): Promise<void> {
  await withAdmin((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

export interface RunningProcess {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

/** Starts a built entry point with exactly the given env (plus PATH), like a container. */
export function start(entry: string, env: Record<string, string>): RunningProcess {
  const child = spawn(process.execPath, [requireBuild(entry)], {
    env: {
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      NODE_ENV: 'production',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  return { child, output: () => output, exited };
}

/** Runs a built entry point to completion and returns its exit code and output. */
export async function run(
  entry: string,
  env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  const proc = start(entry, env);
  const code = await proc.exited;
  return { code, output: proc.output() };
}

/** Polls the URL until it answers, or fails early if the process exits. */
export async function waitForHttp(
  url: string,
  proc: RunningProcess,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.child.exitCode !== null) throw new Error(`process exited early:\n${proc.output()}`);
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`${url} did not answer within ${timeoutMs}ms:\n${proc.output()}`);
}

export async function stop(proc: RunningProcess | undefined): Promise<void> {
  if (!proc || proc.child.exitCode !== null) return;
  proc.child.kill();
  await proc.exited;
}
