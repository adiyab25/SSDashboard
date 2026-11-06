import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Why this test exists: the api trusts the first X-Forwarded-For entry as the client address
// (identity/sign-in/client-info.ts, auth.factory.ts ipAddressHeaders) for sign-in lockout and
// rate limits.
// That is only safe while Caddy is the sole way in, because Caddy overwrites X-Forwarded-For.
// Publishing a port on api, web or any other service would let a client forge its address.

const DEPLOY_DIR = fileURLToPath(new URL('../../../deploy/', import.meta.url));
const COMPOSE = `${DEPLOY_DIR}compose.yaml`;

type Service = Record<string, string>;
type Parsed = { services: Record<string, Service>; portsKeys: number };

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

/** Splits `key: value` (key may be quoted); null when the line is not a mapping entry. */
function splitKey(line: string): { key: string; value: string } | null {
  const match = /^(?:"([^"]*)"|'([^']*)'|([^\s:"'][^:]*?))\s*:(?:\s+(.*))?$/.exec(line.trim());
  if (!match) return null;
  return { key: match[1] ?? match[2] ?? match[3] ?? '', value: (match[4] ?? '').trim() };
}

const aliases = (value: string) => [...value.matchAll(/\*([\w-]+)/g)].map((m) => m[1] ?? '');

// A deliberately small reader for the shape deploy/compose.yaml uses (no YAML parser is a
// dependency of this package): top-level `x-*: &anchor` maps (which may merge other anchors),
// `services:` with two-space service names, four-space service keys, and `<<: *a` /
// `<<: [*a, *b]` merges. It records each key's unquoted inline value, which is all these checks
// need. It FAILS CLOSED: any line under `services:` it cannot map (flow maps, include, extends,
// odd indentation, alias values) throws instead of being skipped.
function parseCompose(text: string): Parsed {
  const anchors = new Map<string, { own: Service; merges: string[] }>();
  const services: Record<string, Service> = {};
  const merges = new Map<Service, string[]>();
  let portsKeys = 0;
  let top = '';
  let anchor: { own: Service; merges: string[] } | undefined;
  let current: Service | undefined;
  let currentMerges: string[] = [];
  let hasKey = false;

  const fail = (why: string, raw: string): never => {
    throw new Error(`compose.yaml: ${why}: ${raw.trim()}`);
  };

  const record = (
    target: Service,
    mergeList: string[],
    key: string,
    value: string,
    raw: string,
  ) => {
    if (value.startsWith('{')) fail('flow style mappings are not supported', raw);
    if (key === 'include' || key === 'extends') fail(`"${key}" is not supported`, raw);
    if (key === '<<') {
      if (!/^(\*[\w-]+|\[\s*\*[\w-]+(\s*,\s*\*[\w-]+)*\s*\])$/.test(value)) {
        fail('a merge must be <<: *anchor or <<: [*a, *b]', raw);
      }
      mergeList.push(...aliases(value));
      return;
    }
    if (value.startsWith('*')) fail('alias values are not supported', raw);
    if (key === 'ports') portsKeys++;
    target[key] = unquote(value);
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trimEnd();
    if (!line.trim()) continue;
    const lead = /^\s*/.exec(line)?.[0] ?? '';
    if (lead.includes('\t')) fail('tab indentation', raw);
    const indent = lead.length;
    const entry = splitKey(line);

    if (indent === 0) {
      if (!entry) fail('unreadable top level line', raw);
      top = entry?.key ?? '';
      if (top === 'include' || top === 'extends') fail(`"${top}" is not supported`, raw);
      current = undefined;
      anchor = undefined;
      const name = /&([\w-]+)/.exec(entry?.value ?? '')?.[1];
      if (top.startsWith('x-') && name) {
        anchor = { own: {}, merges: [] };
        anchors.set(name, anchor);
      }
      continue;
    }
    if (top.startsWith('x-')) {
      if (anchor && indent === 2) {
        if (!entry) fail('unreadable anchor line', raw);
        record(anchor.own, anchor.merges, entry?.key ?? '', entry?.value ?? '', raw);
      }
      continue;
    }
    if (top !== 'services') continue;

    if (indent === 2) {
      if (!entry || entry.value !== '') fail('a service must be a block mapping', raw);
      current = {};
      currentMerges = [];
      merges.set(current, currentMerges);
      services[entry?.key ?? ''] = current;
      hasKey = false;
    } else if (indent === 4) {
      if (!current) fail('a service key outside a service', raw);
      if (!entry) fail('unreadable service key', raw);
      record(current ?? {}, currentMerges, entry?.key ?? '', entry?.value ?? '', raw);
      hasKey = true;
    } else if (indent > 4 && hasKey) {
      // Nested content (environment, list items). Only the keys that change exposure matter.
      if (entry && (entry.key === 'include' || entry.key === 'extends')) {
        fail(`"${entry.key}" is not supported`, raw);
      }
    } else {
      fail('unexpected indentation', raw);
    }
  }

  const resolving = new Set<string>();
  const resolve = (name: string): Service => {
    const found = anchors.get(name);
    if (!found) throw new Error(`compose.yaml merges unknown anchor *${name}`);
    if (resolving.has(name)) throw new Error(`compose.yaml anchor *${name} merges itself`);
    resolving.add(name);
    const result: Service = { ...found.own };
    for (const parent of found.merges) {
      for (const [key, value] of Object.entries(resolve(parent))) {
        if (!(key in result)) result[key] = value;
      }
    }
    resolving.delete(name);
    return result;
  };

  // Merged keys never override a key the service sets itself (YAML merge semantics).
  for (const [service, names] of merges) {
    for (const name of names) {
      for (const [key, value] of Object.entries(resolve(name))) {
        if (!(key in service)) service[key] = value;
      }
    }
  }
  return { services, portsKeys };
}

/** Names of the services that publish a port or use host networking. */
function publishing(services: Record<string, Service>): string[] {
  return Object.entries(services)
    .filter(
      ([, service]) => 'ports' in service || service['network_mode']?.toLowerCase() === 'host',
    )
    .map(([name]) => name);
}

/** Text level backstop for whatever the reader above might have missed. */
function rawProblems(text: string, parsedPortsKeys: number): string[] {
  const lines = text.split(/\r?\n/).map(stripComment);
  const problems: string[] = [];
  const rawPorts = lines.filter((line) => /^\s*["']?ports["']?\s*:/.test(line)).length;
  if (rawPorts !== parsedPortsKeys) {
    problems.push(`${rawPorts} ports keys in the text but the reader found ${parsedPortsKeys}`);
  }
  if (lines.some((line) => /network_mode["']?\s*:\s*["']?host\b/i.test(line))) {
    problems.push('network_mode host appears in the text');
  }
  return problems;
}

const WHY =
  'The api trusts the first X-Forwarded-For entry as the client address for sign-in lockout and ' +
  'rate limits, which is only safe because Caddy is the sole entry point and overwrites that header. ' +
  'A published port on any other service lets clients reach it directly and forge the address, ' +
  'dodging per IP limits. Route traffic through caddy instead of publishing the port.';

describe('deploy/compose.yaml network exposure', () => {
  const text = readFileSync(COMPOSE, 'utf8');
  const { services, portsKeys } = parseCompose(text);

  it.each(['api', 'web', 'worker', 'migrate', 'postgres'])(
    '%s publishes no ports and does not use host networking',
    (name) => {
      const service = services[name];
      expect(service, `service ${name} is missing from compose.yaml`).toBeDefined();
      expect(service, `${name} must not publish ports. ${WHY}`).not.toHaveProperty('ports');
      expect(service, `${name} must not use host networking. ${WHY}`).not.toHaveProperty(
        'network_mode',
      );
    },
  );

  it('only caddy publishes ports', () => {
    expect(services['caddy'], 'caddy is missing from compose.yaml').toHaveProperty('ports');
    expect(publishing(services), `Only caddy may publish ports. ${WHY}`).toEqual(['caddy']);
  });

  it('has no ports key or host networking the reader missed', () => {
    expect(rawProblems(text, portsKeys), WHY).toEqual([]);
    expect(portsKeys, 'only caddy has a ports key').toBe(1);
  });

  it('has no compose override file, which docker compose loads automatically', () => {
    for (const name of ['compose.override.yaml', 'compose.override.yml']) {
      expect(existsSync(`${DEPLOY_DIR}${name}`), `deploy/${name} must not exist. ${WHY}`).toBe(
        false,
      );
    }
  });
});

describe('the compose reader fails closed', () => {
  const base = (service: string) => `services:\n  caddy:\n    ports:\n      - "80:80"\n${service}`;

  it('sees a port published by a service other than caddy', () => {
    const { services } = parseCompose(base('  api:\n    ports:\n      - "3001:3001"\n'));

    expect(publishing(services)).toEqual(['caddy', 'api']);
  });

  it('sees a port published through an anchor, including one that merges another anchor', () => {
    const text = [
      'x-base: &base',
      '  ports: ["3001:3001"]',
      'x-app: &app',
      '  <<: *base',
      '  restart: always',
      'services:',
      '  api:',
      '    <<: *app',
      '',
    ].join('\n');

    expect(publishing(parseCompose(text).services)).toEqual(['api']);
  });

  it('keeps a key the service sets itself over a merged one', () => {
    const text = 'x-a: &a\n  restart: no\nservices:\n  api:\n    <<: *a\n    restart: always\n';

    expect(parseCompose(text).services['api']).toEqual({ restart: 'always' });
  });

  it.each([
    ['a quoted network_mode', '  api:\n    network_mode: "host"\n'],
    ['a single quoted network_mode', "  api:\n    'network_mode': 'host'\n"],
    ['a trailing comment', '  api:\n    network_mode: host # why not\n'],
    ['a quoted ports key', '  api:\n    "ports":\n      - "3001:3001"\n'],
  ])('sees %s', (_case, service) => {
    const parsed = parseCompose(base(service));

    expect(publishing(parsed.services)).toContain('api');
  });

  it.each([
    ['a flow style service', '  api: { image: x, ports: ["3001:3001"] }\n'],
    ['a flow style key', '  api:\n    environment: { A: b }\n'],
    ['an include', '  api:\n    include:\n      - other.yaml\n'],
    ['an extends', '  api:\n    extends:\n      file: other.yaml\n'],
    ['a nested extends', '  api:\n    build:\n      extends: other\n'],
    ['an odd indent', '  api:\n   image: x\n'],
    ['content right under a service name', '  api:\n      image: x\n'],
    ['a service given as an alias', '  api: *app\n'],
    ['an alias value', '  api:\n    ports: *p\n'],
    ['a tab indent', '  api:\n\tports: x\n'],
    ['a merge of something else', '  api:\n    <<: {a: b}\n'],
  ])('throws on %s', (_case, service) => {
    expect(() => parseCompose(base(service))).toThrow(/compose\.yaml/);
  });

  it('throws on a top level include and on an unknown merge', () => {
    expect(() => parseCompose('services:\n    image: x\n')).toThrow(/outside a service/);
    expect(() => parseCompose('include:\n  - other.yaml\n')).toThrow(/include/);
    expect(() => parseCompose('services:\n  api:\n    <<: *missing\n')).toThrow(/unknown anchor/);
  });

  it('backstop: a ports key nested where the reader does not look is caught', () => {
    const text = base('  api:\n    deploy:\n      ports:\n        - "1:1"\n');
    const { services, portsKeys } = parseCompose(text);

    expect(publishing(services)).toEqual(['caddy']);
    expect(rawProblems(text, portsKeys)).not.toEqual([]);
  });

  it('backstop: network_mode host in any quoting is caught, a plain caddy file is not', () => {
    for (const value of ['host', '"host"', "'host'"]) {
      expect(rawProblems(base(`  api:\n    network_mode: ${value}\n`), 1)).not.toEqual([]);
    }
    expect(rawProblems(base('  api:\n    network_mode: bridge\n'), 1)).toEqual([]);
    expect(rawProblems(base('  api:\n    # network_mode: host\n'), 1)).toEqual([]);
  });
});
