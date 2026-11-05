// One command for a working local setup: `pnpm bootstrap` (after `pnpm install`).
// 1. Creates .env from .env.example if missing, and adds any variable it lacks. It never changes a
//    value that is already set; secrets it generates are random per machine.
// 2. Starts PostgreSQL, Garage (S3), and Mailpit with Docker Compose and waits until healthy.
// 3. Gives Garage its storage layout, the dev bucket, and the access key, then writes the key to .env.
// 4. Applies database migrations.
// Safe to run again: every step checks before it acts, and no data volume is removed.
// Plain Node with no dependencies, so it runs the same on Windows, macOS, and Linux.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(ROOT, '.env');
const ENV_EXAMPLE = join(ROOT, '.env.example');
const COMPOSE_FILE = join(ROOT, 'deploy', 'compose.dev.yaml');
const KEY_NAME = 'ssdashboard-dev';
const STARTED = Date.now();

const seconds = (since) => `${((Date.now() - since) / 1000).toFixed(1)}s`;
const say = (message) => console.log(`bootstrap: ${message}`);

function fail(message) {
  console.error(`bootstrap: ${message}`);
  process.exit(1);
}

/** Runs a step, printing how long it took. */
function step(title, run) {
  const began = Date.now();
  say(title);
  const result = run();
  say(`  done in ${seconds(began)}`);
  return result;
}

const hex = (bytes) => randomBytes(bytes).toString('hex');

/** Matches `KEY=value` on its own line. */
const lineFor = (key) => new RegExp(`^${key}=(.*)$`, 'm');

/** Active (not commented out) `KEY=value` pairs of an env file, in order. */
function pairsOf(text) {
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1], m[2]]);
}

const readEnv = () => readFileSync(ENV_FILE, 'utf8');

function valueOf(key) {
  return lineFor(key).exec(readEnv())?.[1]?.trim() ?? '';
}

/** Sets a variable whose value is empty or absent; returns whether it wrote. */
function fillEnv(key, value) {
  let text = readEnv();
  const found = lineFor(key).exec(text);
  if (found && found[1].trim() !== '') return false;
  text = found
    ? text.replace(lineFor(key), () => `${key}=${value}`)
    : `${text.endsWith('\n') ? text : `${text}\n`}${key}=${value}\n`;
  writeFileSync(ENV_FILE, text, { mode: 0o600 });
  return true;
}

function prepareEnv() {
  if (!existsSync(ENV_EXAMPLE)) fail('.env.example is missing; run this from a full clone.');
  const example = readFileSync(ENV_EXAMPLE, 'utf8');
  if (!existsSync(ENV_FILE)) {
    // A new file gets its own session secret instead of the shared placeholder.
    writeFileSync(
      ENV_FILE,
      example.replace(lineFor('BETTER_AUTH_SECRET'), () => `BETTER_AUTH_SECRET=${hex(32)}`),
      { mode: 0o600 },
    );
    say('created .env from .env.example with a new BETTER_AUTH_SECRET');
    return;
  }
  const have = new Set(pairsOf(readEnv()).map(([key]) => key));
  const added = [];
  for (const [key, value] of pairsOf(example)) {
    if (have.has(key)) continue;
    fillEnv(key, key === 'BETTER_AUTH_SECRET' ? hex(32) : value);
    added.push(key);
  }
  say(
    added.length > 0
      ? `kept your .env and added the missing variables: ${added.join(', ')}`
      : 'kept your existing .env (nothing missing)',
  );
}

function compose(args, options = {}) {
  return execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
}

/** Runs the Garage command line tool inside its container; returns stdout, throws on failure. */
function garage(...args) {
  return compose(['exec', '-T', '-e', 'RUST_LOG=error', 'garage', '/garage', ...args]);
}

function garageOk(...args) {
  try {
    garage(...args);
    return true;
  } catch {
    return false;
  }
}

function waitFor(what, check) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (check()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  fail(`${what} did not become ready within 30 seconds.`);
}

function prepareGarage() {
  const unassigned = /^(\w{16})\s.*NO ROLE ASSIGNED/m.exec(garage('status'));
  if (unassigned) {
    const layout = garage('layout', 'show');
    const version = Number(/layout version:\s*(\d+)/i.exec(layout)?.[1] ?? '0');
    garage('layout', 'assign', '-z', 'dc1', '-c', '1G', unassigned[1]);
    garage('layout', 'apply', '--version', String(version + 1));
    say('  assigned the storage layout');
  }
  waitFor('the Garage layout', () => garageOk('bucket', 'list'));

  const bucket = valueOf('S3_BUCKET');
  if (!bucket) fail('S3_BUCKET is empty in .env.');
  if (!garageOk('bucket', 'info', bucket)) {
    garage('bucket', 'create', bucket);
    say(`  created bucket ${bucket}`);
  }

  // The key pair lives in .env. Garage shows a secret only at creation, so a key that Garage has
  // but .env lacks cannot be recovered and is replaced.
  const hasKeyId = valueOf('S3_ACCESS_KEY_ID') !== '';
  const hasSecret = valueOf('S3_SECRET_ACCESS_KEY') !== '';
  if (hasKeyId !== hasSecret) {
    fail('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are set together or not at all in .env.');
  }
  if (!hasKeyId) {
    fillEnv('S3_ACCESS_KEY_ID', `GK${hex(12)}`);
    fillEnv('S3_SECRET_ACCESS_KEY', hex(32));
    say('  generated an S3 access key in .env');
  }
  const keyId = valueOf('S3_ACCESS_KEY_ID');
  if (!garage('key', 'list').includes(keyId)) {
    // A key with our name but another id would block the import, so clear it first.
    if (garageOk('key', 'info', KEY_NAME)) garage('key', 'delete', '--yes', KEY_NAME);
    garage('key', 'import', '--yes', '-n', KEY_NAME, keyId, valueOf('S3_SECRET_ACCESS_KEY'));
    say(`  imported key ${keyId}`);
  }
  garage('bucket', 'allow', '--read', '--write', '--owner', bucket, '--key', keyId);
}

if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) {
  fail('Docker Compose was not found. Install and start Docker Desktop, then run this again.');
}

step('checking .env', prepareEnv);
step('starting PostgreSQL, Garage, and Mailpit', () => {
  try {
    compose(['up', '-d', '--wait'], { inherit: true });
  } catch {
    fail(
      'docker compose failed. If a port is already taken (5433, 3900, 1025, 8025), stop what holds it.',
    );
  }
});
step('preparing the Garage bucket and key', prepareGarage);
step('applying database migrations', () => {
  const migrate = spawnSync('pnpm', ['db:migrate'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (migrate.status !== 0) fail('pnpm db:migrate failed. Did you run `pnpm install` first?');
});

say(`ready in ${seconds(STARTED)}. Start the apps with:  pnpm dev`);
console.log(`
  Back office   http://localhost:3000   (web)
  Api           http://localhost:3001   (api, with the worker)
  Mail          http://localhost:8025   (Mailpit: every email the apps send lands here)
  Objects       ${valueOf('S3_ENDPOINT')}   (Garage S3, bucket ${valueOf('S3_BUCKET')}; keys are in .env)
  Database      localhost:5433          (PostgreSQL)
`);
