import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as envModule from '../src/config/env.js';

// Why this test exists: each Compose service gets an explicit `environment` list (spec 0002,
// AC-2), and each entry point validates its env at startup. When the two drift, the container
// exits 1 with `Invalid environment` on a real install while every other test passes: `migrate`
// once called the api's `loadEnv()` without receiving PUBLIC_URL or BETTER_AUTH_SECRET, so no
// install could start (spec 0005 verify, R1). This test builds each service's env from
// deploy/compose.yaml exactly as Compose would (filled from deploy/.env.example the way
// deploy/bootstrap.sh fills it), and runs the loader that service's entry point really calls.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const COMPOSE = readFileSync(`${ROOT}deploy/compose.yaml`, 'utf8');
const ENV_EXAMPLE = readFileSync(`${ROOT}deploy/.env.example`, 'utf8');
const DOCKERFILE = readFileSync(`${ROOT}deploy/Dockerfile.app`, 'utf8');

type Raw = Record<string, string>;
type Service = { keys: Raw; environment: Raw | undefined; envMerges: string[] };

/** Removes a trailing ` # comment`, leaving quoted text alone. */
function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value: string): string {
  const v = value.trim();
  const first = v[0];
  return v.length >= 2 && (first === '"' || first === "'") && v.endsWith(first)
    ? v.slice(1, -1)
    : v;
}

/** Splits `key: value`; null when the line is not a mapping entry. */
function splitKey(line: string): { key: string; value: string } | null {
  const match = /^(?:"([^"]*)"|'([^']*)'|([^\s:"'][^:]*?))\s*:(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return null;
  return { key: match[1] ?? match[2] ?? match[3] ?? '', value: (match[4] ?? '').trim() };
}

const MERGE = /^(\*[\w-]+|\[\s*\*[\w-]+(\s*,\s*\*[\w-]+)*\s*\])$/;
const aliases = (value: string) => [...value.matchAll(/\*([\w-]+)/g)].map((m) => m[1] ?? '');

// A small reader for the shape deploy/compose.yaml uses: top level `x-*: &anchor` maps of
// `KEY: value`, and services whose `environment:` is a block map of `KEY: value` entries plus
// `<<: *a` / `<<: [*a, *b]` merges. It FAILS CLOSED: a list form environment, an inline one,
// `env_file` (which would hand a service the whole .env), or anything deeper than one level
// inside `environment` throws instead of being skipped.
function readCompose(text: string): {
  anchors: Map<string, { own: Raw; merges: string[] }>;
  services: Record<string, Service>;
} {
  const anchors = new Map<string, { own: Raw; merges: string[] }>();
  const services: Record<string, Service> = {};
  let top = '';
  let anchor: { own: Raw; merges: string[] } | undefined;
  let service: Service | undefined;
  let inEnvironment = false;
  const fail = (why: string, raw: string): never => {
    throw new Error(`compose.yaml: ${why}: ${raw.trim()}`);
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trimEnd();
    if (!line.trim()) continue;
    const indent = (/^ */.exec(line)?.[0] ?? '').length;
    if (line[indent] === '\t') fail('tab indentation', raw);
    const entry = splitKey(line);

    if (indent === 0) {
      top = entry?.key ?? fail('unreadable top level line', raw);
      const name = /&([\w-]+)/.exec(entry?.value ?? '')?.[1];
      anchor = top.startsWith('x-') && name ? { own: {}, merges: [] } : undefined;
      if (anchor && name) anchors.set(name, anchor);
      service = undefined;
      inEnvironment = false;
      continue;
    }
    if (anchor) {
      if (indent !== 2 || !entry) fail('an anchor must be a flat block map', raw);
      if (entry?.key === '<<') {
        if (!MERGE.test(entry.value)) fail('a merge must be <<: *anchor or <<: [*a, *b]', raw);
        anchor.merges.push(...aliases(entry.value));
      } else if (entry) {
        anchor.own[entry.key] = unquote(entry.value);
      }
      continue;
    }
    if (top !== 'services') continue;

    if (indent === 2) {
      if (!entry || entry.value !== '') fail('a service must be a block mapping', raw);
      service = { keys: {}, environment: undefined, envMerges: [] };
      services[entry?.key ?? ''] = service;
      inEnvironment = false;
    } else if (indent === 4) {
      if (!service || !entry) fail('unreadable service key', raw);
      if (entry?.key === 'env_file') fail('env_file hands a service the whole .env', raw);
      inEnvironment = entry?.key === 'environment';
      if (inEnvironment && entry?.value !== '') fail('environment must be a block map', raw);
      if (inEnvironment && service) service.environment = {};
      if (service && entry) service.keys[entry.key] = entry.value;
    } else if (inEnvironment) {
      if (indent !== 6) fail('environment entries must be one level deep', raw);
      if (line.trim().startsWith('-')) fail('list form environment is not supported', raw);
      if (!entry) fail('unreadable environment entry', raw);
      if (entry?.key === '<<') {
        if (!MERGE.test(entry.value)) fail('a merge must be <<: *anchor or <<: [*a, *b]', raw);
        service?.envMerges.push(...aliases(entry.value));
      } else if (entry && service?.environment) {
        service.environment[entry.key] = unquote(entry.value);
      }
    }
  }
  return { anchors, services };
}

/** The raw (uninterpolated) env a service receives: its own keys win over merged ones. */
function rawEnvironment(text: string, name: string): Raw {
  const { anchors, services } = readCompose(text);
  const service = services[name];
  if (!service?.environment) throw new Error(`compose.yaml: service ${name} has no environment`);
  const resolve = (alias: string, seen: string[] = []): Raw => {
    const found = anchors.get(alias);
    if (!found) throw new Error(`compose.yaml merges unknown anchor *${alias}`);
    if (seen.includes(alias)) throw new Error(`compose.yaml anchor *${alias} merges itself`);
    const result = { ...found.own };
    for (const parent of found.merges) {
      for (const [key, value] of Object.entries(resolve(parent, [...seen, alias]))) {
        result[key] ??= value;
      }
    }
    return result;
  };
  const result = { ...service.environment };
  for (const alias of service.envMerges) {
    for (const [key, value] of Object.entries(resolve(alias))) result[key] ??= value;
  }
  return result;
}

/** Compose's `${NAME}`, `${NAME:-default}`, `${NAME-default}`, `${NAME:?err}`, `${NAME?err}`. */
function interpolate(value: string, dotenv: Raw): string {
  const out = value.replace(
    /\$\{([A-Za-z_]\w*)(?:(:?[-?])([^}]*))?\}|\$\$/g,
    (whole, name: string | undefined, op: string | undefined, arg: string | undefined) => {
      if (whole === '$$') return '\u0000';
      const set = name !== undefined && name in dotenv;
      const present = set && dotenv[name ?? ''] !== '';
      const ok = op?.startsWith(':') ? present : set;
      if (op?.endsWith('?') && !ok) throw new Error(`compose: ${name} is required: ${arg}`);
      if (op?.endsWith('-') && !ok) return arg ?? '';
      return dotenv[name ?? ''] ?? '';
    },
  );
  if (out.includes('$')) throw new Error(`compose: unsupported interpolation in ${value}`);
  return out.replaceAll('\u0000', '$');
}

/** `.env.example` after deploy/bootstrap.sh: every `__GENERATED__` secret is 64 hex characters. */
function bootstrapDotenv(text: string): Raw {
  const dotenv: Raw = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_]\w*)=(.*)$/.exec(line);
    if (!match) continue;
    const value = unquote(match[2] ?? '');
    dotenv[match[1] ?? ''] = value === '__GENERATED__' ? 'ab12'.repeat(16) : value;
  }
  return dotenv;
}

// What the app image itself sets (deploy/Dockerfile.app, runtime stage). Compose values win.
const IMAGE_ENV: Raw = { NODE_ENV: 'production', PORT: '3001', APP_VERSION: '0.0.0-dev' };

/** The env a container of this service starts with. */
function containerEnv(service: string): Raw {
  const dotenv = bootstrapDotenv(ENV_EXAMPLE);
  const env = { ...IMAGE_ENV };
  for (const [key, value] of Object.entries(rawEnvironment(COMPOSE, service))) {
    env[key] = interpolate(value, dotenv);
  }
  return env;
}

/**
 * The env loader an entry point really calls: a direct `loadXEnv()` call in the file, or, for a
 * Nest entry point, the one `ConfigModule` provides. Read from the source, so pointing an entry
 * point at another loader changes what this test runs.
 */
function loaderOf(file: string): { name: string; load: () => unknown } {
  const source = readFileSync(`${SRC}${file}`, 'utf8');
  let calls = [...source.matchAll(/\b(load\w*Env)\(\)/g)].map((m) => m[1] ?? '');
  if (calls.length === 0) {
    if (!/\bNestFactory\./.test(source)) throw new Error(`${file} loads no env`);
    const config = readFileSync(`${SRC}config/config.module.ts`, 'utf8');
    calls = [...config.matchAll(/\b(load\w*Env)\(\)/g)].map((m) => m[1] ?? '');
  }
  const [name, ...others] = new Set(calls);
  if (!name || others.length > 0) throw new Error(`${file} must call exactly one env loader`);
  const load: unknown = (envModule as Record<string, unknown>)[name];
  if (typeof load !== 'function') throw new Error(`${name} is not exported by config/env.ts`);
  return { name, load: load as () => unknown };
}

/** Runs the loader against exactly `env`, nothing from the machine running the test. */
function startsWith(load: () => unknown, env: Raw): { ok: boolean; error: string } {
  const saved = process.env;
  process.env = { ...env };
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
  try {
    load();
    return { ok: true, error: '' };
  } catch (error) {
    if (!String(error).includes('process.exit(1)')) throw error;
    return { ok: false, error: errors.join('\n') };
  } finally {
    process.env = saved;
  }
}

// Each service, the entry point it runs, and the names it cannot start without.
// create-admin runs in the api's container: `docker compose run --rm api node dist/create-admin.js`.
const ENTRY_POINTS = [
  {
    service: 'api',
    file: 'main.ts',
    required: ['BETTER_AUTH_SECRET', 'DATABASE_URL', 'PUBLIC_URL'],
  },
  {
    service: 'api',
    file: 'create-admin.ts',
    required: ['BETTER_AUTH_SECRET', 'DATABASE_URL', 'PUBLIC_URL'],
  },
  {
    service: 'worker',
    file: 'worker.ts',
    required: ['BETTER_AUTH_SECRET', 'DATABASE_URL', 'PUBLIC_URL'],
  },
  { service: 'migrate', file: 'migrate.ts', required: ['MIGRATION_DATABASE_URL'] },
];

describe('deploy/compose.yaml gives each entry point the env it validates', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs each service the entry point this test maps it to', () => {
    const { services } = readCompose(COMPOSE);

    expect(services['migrate']?.keys['command']).toContain('dist/migrate.js');
    expect(services['worker']?.keys['command']).toContain('dist/worker.js');
    expect(services['api']?.keys).not.toHaveProperty('command');
    expect(DOCKERFILE).toMatch(/^CMD \["node", "dist\/main\.js"\]$/m);
    expect(DOCKERFILE).toMatch(/NODE_ENV=production/);
    expect(DOCKERFILE).toMatch(/PORT=3001/);
  });

  it.each(ENTRY_POINTS)('$service starts $file with only its compose env', ({ service, file }) => {
    const { name, load } = loaderOf(file);

    const result = startsWith(load, containerEnv(service));

    expect(result.error, `${file} (${name}) rejects the ${service} service's env`).toBe('');
    expect(result.ok).toBe(true);
  });

  it.each(ENTRY_POINTS)(
    '$service: $file stops when a name it needs is removed, and only then',
    ({ service, file, required }) => {
      const { load } = loaderOf(file);
      const env = containerEnv(service);

      const needed = Object.keys(rawEnvironment(COMPOSE, service))
        .filter((name) => {
          const without = Object.fromEntries(Object.entries(env).filter(([key]) => key !== name));
          return !startsWith(load, without).ok;
        })
        .sort();

      expect(needed).toEqual(required);
    },
  );

  it('keeps the auth and mail secrets out of migrate, and the owner password in migrate only', () => {
    const migrate = rawEnvironment(COMPOSE, 'migrate');
    for (const name of [
      'PUBLIC_URL',
      'BETTER_AUTH_SECRET',
      'SMTP_PASSWORD',
      'POSTMARK_SERVER_TOKEN',
    ]) {
      expect(migrate, `migrate must not receive ${name}`).not.toHaveProperty(name);
    }
    for (const service of ['api', 'worker']) {
      const env = rawEnvironment(COMPOSE, service);
      expect(env, `${service} must not receive the owner URL`).not.toHaveProperty(
        'MIGRATION_DATABASE_URL',
      );
      expect(Object.values(env).join(' ')).not.toContain('POSTGRES_PASSWORD');
    }
  });
});

describe('the compose env reader', () => {
  const base = (service: string) => `x-a: &a\n  A: one\nservices:\n${service}`;

  it('merges anchors under the keys a service sets itself', () => {
    const text = base('  api:\n    environment:\n      <<: *a\n      A: own\n      B: "two"\n');

    expect(rawEnvironment(text, 'api')).toEqual({ A: 'own', B: 'two' });
  });

  it.each([
    ['a list form environment', '  api:\n    environment:\n      - A=b\n'],
    ['an inline environment', '  api:\n    environment: { A: b }\n'],
    ['an env_file', '  api:\n    env_file: .env\n    environment:\n      A: b\n'],
    ['a nested environment value', '  api:\n    environment:\n      A:\n        B: c\n'],
    ['a merge of something else', '  api:\n    environment:\n      <<: {a: b}\n'],
    ['an unknown anchor', '  api:\n    environment:\n      <<: *missing\n'],
  ])('throws on %s', (_case, service) => {
    expect(() => rawEnvironment(base(service), 'api')).toThrow(/compose/);
  });

  it('interpolates the forms compose.yaml uses, and refuses the rest', () => {
    const dotenv = { SET: 'x', EMPTY: '' };

    expect(interpolate('${SET}/${EMPTY:-d}/${EMPTY-d}/${MISSING-d}/$$', dotenv)).toBe('x/d//d/$');
    expect(() => interpolate('${EMPTY:?need it}', dotenv)).toThrow(/EMPTY is required/);
    expect(() => interpolate('$SET', dotenv)).toThrow(/unsupported/);
  });
});
