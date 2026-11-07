import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Hat } from '@ssdashboard/contracts';
import { createDatabase, type DatabaseConnection } from '@ssdashboard/db';
import { hashPassword } from 'better-auth/crypto';

/** The folder of the built entry points that the e2e suites start. */
// These suites run the built entry points exactly as the image does, so build first:
// `pnpm build`. They need the dev database (deploy/compose.dev.yaml) for DATABASE_URL.
export const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const ROOT_ENV = new URL('../../../.env', import.meta.url);

/** A database URL that refuses connections at once, for tests of how a process fails to start. */
export const UNREACHABLE_DB = 'postgres://nobody:nothing@127.0.0.1:1/none';

/** Returns the path of a built entry point, or throws telling the developer to run `pnpm build`. */
export function requireBuild(entry: string): string {
  const path = `${DIST}${entry}`;
  if (!existsSync(path))
    throw new Error(`${path} is missing. Run \`pnpm build\` before the e2e tests.`);
  return path;
}

/**
 * The dev database URL from the environment or the root `.env`. Throws when neither sets
 * `DATABASE_URL`.
 */
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

/** Runs a callback with a one connection pool as the owner role, and always closes the pool. */
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

/** Creates an empty, uniquely named scratch database as the owner and returns its name and URL. */
export async function createScratchDatabase(): Promise<{ name: string; url: string }> {
  const name = `ssd_test_${randomBytes(4).toString('hex')}`;
  await withAdmin((client) => client.query(`CREATE DATABASE ${name}`));
  const url = new URL(ownerDatabaseUrl());
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

/** Drops a scratch database, forcing out any connection still open to it. */
export async function dropScratchDatabase(name: string): Promise<void> {
  await withAdmin((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

const handedOut = new Set<number>();

/**
 * A free local port. Suites run in parallel workers, and asking the system for port 0 then
 * closing it lets two workers get the same number before either starts its server. Each worker
 * draws from its own block instead, and never repeats a port within its run.
 *
 * The blocks (10000 to 29999) sit below every OS's ephemeral range (Linux starts at 32768,
 * Windows and macOS at 49152). Ports in that range are handed to outgoing connections, so a
 * database pool or a fetch in the same run could take the port between the probe and the
 * server's listen (EADDRINUSE in CI).
 */
export async function freePort(): Promise<number> {
  const worker = Number(process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 0);
  const blockStart = 10_000 + (worker % 20) * 1_000;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = blockStart + Math.floor(Math.random() * 1_000);
    if (handedOut.has(port) || !(await canListen(port))) continue;
    handedOut.add(port);
    return port;
  }
  throw new Error(`No free port found in ${blockStart} to ${blockStart + 999}`);
}

/**
 * Probes the address the api binds (all interfaces) and the address the suites call (loopback).
 * Windows lets a socket bind 0.0.0.0 while another program holds only 127.0.0.1 on that port,
 * and then sends every loopback request to that program (Docker Desktop listens on
 * 127.0.0.1:12434 and answers a sign in with 403 `Origin not allowed`).
 */
async function canListen(port: number): Promise<boolean> {
  return (await canListenOn(port, '0.0.0.0')) && (await canListenOn(port, '127.0.0.1'));
}

function canListenOn(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

/** A child process started by `start`, with its output so far and a promise of its exit code. */
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
      // Required at startup since spec 0005; suites that test sign in pass their own.
      PUBLIC_URL: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e',
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

/**
 * Kills a started process and waits for it to exit; does nothing if it is absent or already
 * gone.
 */
export async function stop(proc: RunningProcess | undefined): Promise<void> {
  if (!proc || proc.child.exitCode !== null) return;
  proc.child.kill();
  await proc.exited;
}

/** What a test person wears: exact hats, with or without the `cost.view` grant (spec 0008). */
export interface TestAccess {
  hats: readonly Hat[];
  costView?: boolean;
}

/**
 * The hats a suite's everyday person wears when the suite does not say: the three working hats,
 * no `manager` and no cost. Named for what it is, not a role: pass exact hats when a test is about
 * one of them.
 */
export const WORKING_HATS: TestAccess = { hats: ['support', 'operations', 'warehouse'] };

/**
 * Replaces a person's hats and cost grant straight in the database, as the owner, so a suite can
 * plant any holding (a partner account id is needed for the `partner` hat only).
 */
export async function giveHats(
  owner: DatabaseConnection['pool'],
  userId: string,
  access: TestAccess,
  partnerAccountId: string | null = null,
): Promise<void> {
  const { hats, costView = false } = access;
  await owner.query('DELETE FROM hat_assignments WHERE user_id = $1::uuid', [userId]);
  await owner.query('DELETE FROM permission_grants WHERE user_id = $1::uuid', [userId]);
  for (const hat of hats) {
    await owner.query(
      'INSERT INTO hat_assignments (user_id, hat, partner_account_id) VALUES ($1::uuid, $2, $3)',
      [userId, hat, hat === 'partner' ? partnerAccountId : null],
    );
  }
  if (costView) {
    await owner.query(
      "INSERT INTO permission_grants (user_id, permission) VALUES ($1::uuid, 'cost.view')",
      [userId],
    );
  }
}

/**
 * Adds a staff account straight to the database with its hats ({@link WORKING_HATS} by default)
 * and signs it in through the running api, so a suite can call guarded routes. `base` must be the
 * api's `PUBLIC_URL`. Returns the cookie header.
 */
export async function signInAs(
  base: string,
  owner: DatabaseConnection['pool'],
  options: { email?: string; access?: TestAccess } = {},
): Promise<string> {
  const email = options.email ?? 'tester@example.com';
  const password = 'Test-Password-1';
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO users (name, email) VALUES ('Test Person', $1) RETURNING id`,
    [email],
  );
  const userId = rows[0]?.id as string;
  await giveHats(owner, userId, options.access ?? WORKING_HATS);
  await owner.query(
    `INSERT INTO accounts (user_id, provider_id, account_id, password)
     VALUES ($1::uuid, 'credential', $1::text, $2)`,
    [userId, await hashPassword(password)],
  );
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, password }),
  });
  const cookie = response.headers.getSetCookie().find((c) => c.includes('session_token'));
  if (!cookie) throw new Error(`sign in failed with ${response.status}`);
  return cookie.split(';')[0] as string;
}

/** An email captured by the test mail server, decoded into its parts. */
export interface CapturedMail {
  to: string;
  subject: string;
  /** The text part, decoded. */
  text: string;
  /** The html part, decoded. */
  html: string;
  raw: string;
}

function decodeBody(body: string, encoding: string): string {
  const kind = encoding.trim().toLowerCase();
  if (kind === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (kind === 'quoted-printable') {
    const bytes: number[] = [];
    const joined = body.replace(/=\r?\n/g, '');
    for (let i = 0; i < joined.length; i += 1) {
      const hex = joined.slice(i + 1, i + 3);
      if (joined[i] === '=' && /^[0-9A-F]{2}$/i.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
      } else bytes.push(...Buffer.from(joined[i] as string, 'utf8'));
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return body;
}

function decodeHeader(value: string): string {
  return value.replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_m, kind: string, data: string) =>
    kind.toUpperCase() === 'B'
      ? Buffer.from(data, 'base64').toString('utf8')
      : decodeBody(data.replace(/_/g, ' '), 'quoted-printable'),
  );
}

/** Reads a message as nodemailer writes it: a multipart/alternative with a text and an html part. */
export function parseMail(raw: string, to: string): CapturedMail {
  const unfolded = raw.replace(/\r\n[ \t]+/g, ' ');
  const header = (name: string) =>
    new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded.split(/\r\n\r\n/)[0] ?? '')?.[1] ?? '';
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(raw)?.[1];
  const parts = boundary ? raw.split(`--${boundary}`).slice(1, -1) : [raw];
  const part = (type: string) => {
    const found = parts.find((p) => new RegExp(`content-type:\\s*${type}`, 'i').test(p));
    if (!found) return '';
    const [head = '', ...rest] = found.replace(/^\r\n/, '').split(/\r\n\r\n/);
    const encoding = /content-transfer-encoding:\s*(\S+)/i.exec(head)?.[1] ?? '7bit';
    return decodeBody(rest.join('\r\n\r\n').replace(/\r\n$/, ''), encoding);
  };
  return {
    to,
    subject: decodeHeader(header('Subject')),
    text: part('text/plain'),
    html: part('text/html'),
    raw,
  };
}

/**
 * A tiny SMTP server that keeps every message it is given, so a suite can read the real email
 * the worker sends. No TLS and no login: it stands in for a client's mail server.
 */
export async function startSmtpCapture(): Promise<{
  port: number;
  messages: CapturedMail[];
  close: () => Promise<void>;
}> {
  const messages: CapturedMail[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let to = '';
    let data: string | undefined;
    let buffer = '';
    socket.write('220 localhost ESMTP capture\r\n');
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (data !== undefined) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          messages.push(parseMail(data, to));
          data = undefined;
          socket.write('250 OK queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 localhost\r\n');
        else if (verb === 'MAIL') socket.write('250 OK\r\n');
        else if (verb === 'RCPT') {
          to = /<([^>]*)>/.exec(line)?.[1] ?? '';
          socket.write('250 OK\r\n');
        } else if (verb === 'DATA') {
          data = '';
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'QUIT') {
          socket.end('221 Bye\r\n');
          return;
        } else socket.write('250 OK\r\n');
      }
    });
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Polls until the check returns a value, or fails with what was last seen. */
export async function eventually<T>(
  check: () => T | undefined | Promise<T | undefined>,
  options: { timeoutMs?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  for (;;) {
    const found = await check();
    if (found !== undefined) return found;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${options.what ?? 'a result'}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The secret in a `otpauth://` link, as bytes. Better Auth gives it in base32. */
function secretBytes(base32: string): Buffer {
  let bits = '';
  for (const char of base32.replace(/=+$/, '').toUpperCase()) {
    bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/**
 * A 6 digit authenticator app code for a base32 secret (RFC 6238: 30 second steps, SHA 1), so a
 * suite can sign in with a code the way a phone would. `offsetSteps` reaches a neighbouring step.
 */
export function totpCode(base32Secret: string, offsetSteps = 0, now = Date.now()): string {
  const counter = Math.floor(now / 30_000) + offsetSteps;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secretBytes(base32Secret)).update(message).digest();
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

/** The base32 secret out of the `otpauth://totp/...?secret=...` link Better Auth returns. */
export function secretFromUri(uri: string): string {
  const secret = new URL(uri).searchParams.get('secret');
  if (!secret) throw new Error(`no secret in ${uri}`);
  return secret;
}
