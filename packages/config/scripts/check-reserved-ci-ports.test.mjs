import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { reservedPortHits, reservedPortUses } from './check-reserved-ci-ports.mjs';

const SCRIPT = fileURLToPath(new URL('./check-reserved-ci-ports.mjs', import.meta.url));
const roots = [];

/** A throwaway repo root holding the given files (path to content). */
function repo(files) {
  const root = mkdtempSync(join(tmpdir(), 'reserved-ports-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const ports = (text) => reservedPortHits(text).map((hit) => hit.port);

describe('reservedPortHits', () => {
  it('flags a port in a URL, an env assignment, a flag, a mapping, and a JSON key', () => {
    assert.deepEqual(ports('API=http://localhost:4901/api'), [4901]);
    assert.deepEqual(ports('PORT=4900'), [4900]);
    assert.deepEqual(ports('E2E_PROD_PORT: 4910'), [4910]);
    assert.deepEqual(ports('"dev": "next dev --port 4949"'), [4949]);
    assert.deepEqual(ports('next start --port=4900'), [4900]);
    assert.deepEqual(ports('ports:\n  - "4932:5432"'), [4932]);
    assert.deepEqual(ports('{ "port": 4920 }'), [4920]);
    assert.deepEqual(ports('docker run -p 4932 x'), [4932]);
  });

  it('reports the line number', () => {
    assert.deepEqual(reservedPortHits('a\nb\nPORT=4905\n'), [{ line: 3, port: 4905 }]);
  });

  it('flags the first and last port of the block, and nothing just outside it', () => {
    assert.deepEqual(ports('PORT=4900\nPORT=4949'), [4900, 4949]);
    assert.deepEqual(ports('PORT=4899\nPORT=4950\nhttp://localhost:4850'), []);
  });

  it('ignores such numbers in other text and inside longer numbers', () => {
    assert.deepEqual(ports('we shipped 4920 items'), []);
    assert.deepEqual(ports('order id ab4920 and 14920'), []);
    assert.deepEqual(ports('PORT=49201'), []);
    assert.deepEqual(ports('http://localhost:49201'), []);
    assert.deepEqual(ports('"price": 4920'), []);
    assert.deepEqual(ports('postgres://x@localhost:5433/db'), []);
  });
});

describe('reservedPortHits in a Compose file', () => {
  const composePorts = (text) => reservedPortHits(text, { compose: true }).map((hit) => hit.port);

  it('flags the long form and bare list items', () => {
    assert.deepEqual(composePorts('ports:\n  - target: 5432\n    published: 4932'), [4932]);
    assert.deepEqual(composePorts('    published: "4910"'), [4910]);
    assert.deepEqual(
      composePorts('ports:\n  - 4900\n  - "4901"\n  - \'4902\''),
      [4900, 4901, 4902],
    );
  });

  it('does not flag bare list items elsewhere, or other list items', () => {
    assert.deepEqual(ports('list:\n  - 4900'), []);
    assert.deepEqual(composePorts('  - 49201\n  - 4920 items\n  - 3000'), []);
  });
});

describe('reservedPortUses', () => {
  it('applies the Compose forms to compose files only', () => {
    const root = repo({
      'deploy/compose.yaml': 'ports:\n  - target: 5432\n    published: 4932\n  - 4900\n',
      'package.json': '{ "x": [\n  - 4900\n] }\n',
    });
    assert.deepEqual(
      reservedPortUses(root).map((use) => [use.file, use.line, use.port]),
      [
        ['deploy/compose.yaml', 3, 4932],
        ['deploy/compose.yaml', 4, 4900],
      ],
    );
  });

  it('reads files with CRLF line endings', () => {
    const root = repo({ '.env.example': 'A=1\r\nPORT=4901\r\nB=2\r\n' });
    assert.deepEqual(reservedPortUses(root), [{ file: '.env.example', line: 2, port: 4901 }]);
  });

  it('flags each dev facing file the rule covers', () => {
    const root = repo({
      '.env.example': 'PUBLIC_URL=http://localhost:4900\n',
      'apps/api/.env.example': 'PORT=4901\n',
      '.claude/launch.json': '{ "configurations": [{ "port": 4900 }] }\n',
      'package.json': '{ "scripts": { "x": "next dev --port 4900" } }\n',
      'packages/db/package.json': '{ "scripts": { "x": "psql -p 4932" } }\n',
      'deploy/compose.yaml': 'ports:\n  - "4932:5432"\n',
      'deploy/compose.dev.yaml': 'ports:\n  - "4910:80"\n',
      'apps/web/playwright.config.ts': "const baseURL = 'http://localhost:4900';\n",
    });
    assert.deepEqual(
      reservedPortUses(root)
        .map((use) => use.file)
        .sort(),
      [
        '.claude/launch.json',
        '.env.example',
        'apps/api/.env.example',
        'apps/web/playwright.config.ts',
        'deploy/compose.dev.yaml',
        'deploy/compose.yaml',
        'package.json',
        'packages/db/package.json',
      ],
    );
  });

  it('flags a Playwright default written as a port setting', () => {
    const root = repo({
      'apps/web/playwright.config.ts': "const x = { PORT: '4900' };\n",
    });
    assert.deepEqual(reservedPortUses(root), [
      { file: 'apps/web/playwright.config.ts', line: 1, port: 4900 },
    ]);
  });

  it('allows the workflow files, where CI uses the block', () => {
    const root = repo({
      '.github/workflows/ci.yml': 'PUBLIC_URL: http://localhost:4900\nports:\n  - 4932:5432\n',
      'package.json': '{ "scripts": { "dev": "turbo run dev" } }\n',
      '.env.example': 'PORT=3001\nDATABASE_URL=postgres://u:p@localhost:5433/db\n',
    });
    assert.deepEqual(reservedPortUses(root), []);
  });
});

describe('the command', () => {
  it('fails on a planted reserved port and names the file and line', () => {
    const root = repo({ '.env.example': 'A=1\nPORT=4901\n' });
    const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.env\.example:2: port 4901/);
  });

  it('passes a repo that keeps the block to the workflows', () => {
    const root = repo({
      '.github/workflows/ci.yml': 'PORT: 4901\n',
      '.env.example': 'PORT=3001\n',
    });
    const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
  });
});
