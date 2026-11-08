// One command for a working local setup: `pnpm bootstrap` (after `pnpm install`).
// 1. Creates .env from .env.example if missing, and adds any variable it lacks. It never changes a
//    value that is already set (except an S3 key that Garage has retired, see step 3); secrets it
//    generates are random per machine, including CONNECTOR_SECRET_KEY when it is empty.
// 2. Starts PostgreSQL, Garage (S3), and Mailpit with Docker Compose and waits until healthy.
// 3. Gives Garage its storage layout, the dev bucket, and the access key, then writes the key to .env.
// 4. Stops, with the fix, if the database was migrated by the old migration history (ADR 0003).
// 5. Applies database migrations.
// 6. Writes a development license signed with the committed dev key and sets LICENSE_FILE.
// Safe to run again: every step checks before it acts, and no data volume is removed.
// Plain Node with no dependencies, so it runs the same on Windows, macOS, and Linux.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(ROOT, '.env');
const ENV_EXAMPLE = join(ROOT, '.env.example');
const COMPOSE_FILE = join(ROOT, 'deploy', 'compose.dev.yaml');
const MIGRATIONS_DIR = join(ROOT, 'packages', 'db', 'migrations');
const KEY_NAME = 'ssdashboard-dev';
// The development license (spec 0009): written here, signed with the committed dev-only key.
const DEV_LICENSE_FILE = join(ROOT, '.env.license.json');
const DEV_LICENSE_KEY = join(
  ROOT,
  'apps',
  'api',
  'src',
  'platform',
  'license',
  'dev-license-key.pem',
);
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

/**
 * Sets a variable to a new value even when it already holds one, adding the line when absent.
 * Only for secrets this script generated itself (a retired S3 key); `fillEnv` is the default and
 * never overwrites a value the user set.
 */
function replaceEnv(key, value) {
  const text = readEnv();
  writeFileSync(
    ENV_FILE,
    lineFor(key).test(text)
      ? text.replace(lineFor(key), () => `${key}=${value}`)
      : `${text.endsWith('\n') ? text : `${text}\n`}${key}=${value}\n`,
    { mode: 0o600 },
  );
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

/**
 * Generates the development connector key (spec 0015, AC-2: 32 random bytes, base64) into .env when
 * it is empty or absent, so connecting a store works locally. Never prints the value, and never
 * replaces a key that is set: credentials sealed under it would become unreadable.
 */
function prepareConnectorKey() {
  if (fillEnv('CONNECTOR_SECRET_KEY', randomBytes(32).toString('base64'))) {
    say('  generated CONNECTOR_SECRET_KEY in .env');
  }
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
  let keyId = valueOf('S3_ACCESS_KEY_ID');
  if (!garage('key', 'list').includes(keyId)) {
    // A key with our name but another id would block the import, so clear it first.
    if (garageOk('key', 'info', KEY_NAME)) garage('key', 'delete', '--yes', KEY_NAME);
    try {
      garage('key', 'import', '--yes', '-n', KEY_NAME, keyId, valueOf('S3_SECRET_ACCESS_KEY'));
      say(`  imported key ${keyId}`);
    } catch (error) {
      // Garage keeps a tombstone for every deleted key id and refuses to import it again, so a
      // retired id in .env is replaced by a fresh pair. Any other failure stays fatal.
      const detail = `${error?.stderr ?? ''}${error?.message ?? ''}`;
      if (!detail.includes('KeyAlreadyExists')) throw error;
      const retired = keyId;
      keyId = `GK${hex(12)}`;
      replaceEnv('S3_ACCESS_KEY_ID', keyId);
      replaceEnv('S3_SECRET_ACCESS_KEY', hex(32));
      garage('key', 'import', '--yes', '-n', KEY_NAME, keyId, valueOf('S3_SECRET_ACCESS_KEY'));
      say(`  replaced retired key ${retired} with ${keyId} (written to .env)`);
    }
  }
  garage('bucket', 'allow', '--read', '--write', '--owner', bucket, '--key', keyId);
}

/**
 * Stops when the dev database holds a migration hash that matches no current migration file: it
 * was migrated by the history that the baseline replaced (spec 0002, A2), and migrating it now
 * would fail halfway. Drizzle's hash is the sha256 of a migration file's SQL text.
 */
function checkMigrationHistory() {
  const url = new URL(
    valueOf('MIGRATION_DATABASE_URL') || 'postgres://ssdashboard@localhost/ssdashboard',
  );
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.slice(1));
  // PostgreSQL resolves table names at parse time, so the hashes are read by a second query,
  // and only once the first one has found the table.
  const psql = (sql) =>
    compose(['exec', '-T', 'postgres', 'psql', '-U', user, '-d', database, '-At', '-c', sql]);
  let output;
  try {
    if (psql("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL").trim() !== 't') {
      return; // Never migrated: nothing from an old history to find.
    }
    output = psql("SELECT coalesce(string_agg(hash, ' '), '') FROM drizzle.__drizzle_migrations");
  } catch (error) {
    // Only a database that does not exist yet means there is no old history to find; any other
    // failure (a wrong password, a stopped container) must not let the migration run blind.
    const detail = `${error?.stderr ?? ''}${error?.message ?? ''}`;
    if (new RegExp(`database "${database}" does not exist`).test(detail)) return;
    fail(`could not check the migration history:
${detail.trim()}`);
  }
  const known = new Set(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .map((name) =>
        createHash('sha256')
          .update(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))
          .digest('hex'),
      ),
  );
  const unknown = output
    .trim()
    .split(/\s+/)
    .filter((hash) => hash !== '' && !known.has(hash));
  if (unknown.length > 0) {
    fail(
      [
        'this dev database was migrated by the old migration history, which the baseline replaced',
        '(docs/adr/0003-reset-migrations-to-one-baseline.md). Drop the dev volume and start again:',
        '    docker compose -f deploy/compose.dev.yaml down -v',
        '    pnpm bootstrap',
        'Warning: down -v removes every database in the shared dev volume, so other checkouts on this',
        'server lose theirs too. To clear only this checkout, drop just its own database instead.',
      ].join('\n'),
    );
  }
}

/**
 * Writes a development license for this install to .env.license.json (git ignored by `.env.*`)
 * and points LICENSE_FILE at it when LICENSE_FILE is empty (spec 0009, *Configuration required*).
 * It grants Warehouse for ever and Operations for a year, bound to the database's install row, and
 * is signed with the committed dev key through the api's `sign-license` command (built by
 * `pnpm db:migrate`). A production process or a release build (any APP_VERSION but 0.0.0-dev) refuses it
 * (`dev_key_in_production`). A license that still
 * fits this install and has more than 30 days of Operations left is kept.
 */
function writeDevLicense() {
  const url = new URL(
    valueOf('MIGRATION_DATABASE_URL') || 'postgres://ssdashboard@localhost/ssdashboard',
  );
  const install = compose([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    decodeURIComponent(url.username),
    '-d',
    decodeURIComponent(url.pathname.slice(1)),
    '-At',
    '-c',
    "SELECT id || ' ' || client_code FROM install",
  ]).trim();
  const [tenantId, clientCode] = install.split(' ');
  if (!tenantId || !clientCode) fail('the install row is missing; migrations did not finish.');
  const today = new Date().toISOString().slice(0, 10);
  const later = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  let keep = false;
  if (existsSync(DEV_LICENSE_FILE)) {
    try {
      const envelope = JSON.parse(readFileSync(DEV_LICENSE_FILE, 'utf8'));
      const payload = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'));
      keep =
        payload.tenantId === tenantId &&
        payload.clientCode === clientCode &&
        payload.operationsExpiresOn > later(30);
    } catch {
      keep = false;
    }
  }
  if (keep) {
    say('  kept the development license (it fits this install)');
  } else {
    const signer = join(ROOT, 'apps', 'api', 'dist', 'platform', 'license', 'sign-license.js');
    if (!existsSync(signer)) fail('the api build is missing; run `pnpm db:migrate` first.');
    const signed = spawnSync(
      process.execPath,
      [
        signer,
        '--private-key',
        DEV_LICENSE_KEY,
        '--key-id',
        'dev-1',
        '--license-id',
        `DEV-${today}`,
        '--client-code',
        clientCode,
        '--tenant-id',
        tenantId,
        '--bundles',
        'warehouse,operations',
        '--operations-expires-on',
        later(365),
        '--issued-on',
        today,
        '--out',
        DEV_LICENSE_FILE,
      ],
      { cwd: ROOT, stdio: 'inherit' },
    );
    if (signed.status !== 0) fail('signing the development license failed.');
    say('  wrote .env.license.json (Warehouse, and Operations for a year)');
  }
  // Forward slashes work on every platform and need no escaping in .env.
  if (fillEnv('LICENSE_FILE', DEV_LICENSE_FILE.replaceAll('\\', '/'))) {
    say('  set LICENSE_FILE in .env');
  }
}

if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) {
  fail('Docker Compose was not found. Install and start Docker Desktop, then run this again.');
}

step('checking .env', () => {
  prepareEnv();
  prepareConnectorKey();
});
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
step('checking the migration history', checkMigrationHistory);
step('applying database migrations', () => {
  const migrate = spawnSync('pnpm', ['db:migrate'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (migrate.status !== 0) fail('pnpm db:migrate failed. Did you run `pnpm install` first?');
});
step('writing the development license', writeDevLicense);

say(`ready in ${seconds(STARTED)}. Start the apps with:  pnpm dev`);
console.log(`
  Back office   http://localhost:3000   (web)
  Api           http://localhost:3001   (api, with the worker)
  Mail          http://localhost:8025   (Mailpit: every email the apps send lands here)
  Objects       ${valueOf('S3_ENDPOINT')}   (Garage S3, bucket ${valueOf('S3_BUCKET')}; keys are in .env)
  Database      localhost:5433          (PostgreSQL)
`);
