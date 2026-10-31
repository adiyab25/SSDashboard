import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// deploy/bootstrap.sh creates a client install's .env. It ships with the app images,
// so its tests live with the api e2e suite. Runs a copy in a temp folder, never in deploy/.
const DEPLOY = fileURLToPath(new URL('../../../deploy/', import.meta.url));
const hasShell = spawnSync('sh', ['-c', 'exit 0']).status === 0;

describe.skipIf(!hasShell)('deploy/bootstrap.sh', () => {
  let dir: string;

  const bootstrap = () => spawnSync('sh', ['./bootstrap.sh'], { cwd: dir, encoding: 'utf8' });
  const readEnv = () => readFileSync(join(dir, '.env'), 'utf8');
  const value = (env: string, key: string) => env.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ssd-bootstrap-'));
    copyFileSync(join(DEPLOY, 'bootstrap.sh'), join(dir, 'bootstrap.sh'));
    copyFileSync(join(DEPLOY, '.env.example'), join(dir, '.env.example'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes .env with 64 character hex secrets in place of the placeholders', () => {
    const result = bootstrap();

    expect(result.status).toBe(0);
    const env = readEnv();
    expect(value(env, 'POSTGRES_PASSWORD')).toMatch(/^[0-9a-f]{64}$/);
    expect(value(env, 'BETTER_AUTH_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    expect(env).not.toContain('__GENERATED__');
  });

  it('generates a different value for each secret', () => {
    bootstrap();

    const env = readEnv();
    expect(value(env, 'POSTGRES_PASSWORD')).not.toBe(value(env, 'BETTER_AUTH_SECRET'));
  });

  it('keeps every other setting from .env.example unchanged', () => {
    bootstrap();

    const example = readFileSync(join(dir, '.env.example'), 'utf8');
    const strip = (text: string) => text.replace(/^(POSTGRES_PASSWORD|BETTER_AUTH_SECRET)=.*$/gm, '');
    expect(strip(readEnv())).toBe(strip(example));
  });

  it.skipIf(process.platform === 'win32')('makes .env readable by its owner only (mode 600)', () => {
    bootstrap();

    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite an existing .env and leaves it untouched', () => {
    bootstrap();
    const first = readEnv();

    const second = bootstrap();

    expect(second.status).toBe(1);
    expect(second.stderr).toContain('refusing to overwrite');
    expect(readEnv()).toBe(first);
  });
});
