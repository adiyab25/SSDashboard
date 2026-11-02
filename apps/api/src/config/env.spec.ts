import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { loadEnv } from './env.js';

vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false) }));

const VALID_URL = 'postgres://ssdashboard:secret@localhost:5433/ssdashboard';

describe('loadEnv', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let errorLog: MockInstance<typeof console.error>;

  beforeEach(() => {
    for (const name of [
      'NODE_ENV',
      'PORT',
      'DATABASE_URL',
      'MIGRATION_DATABASE_URL',
      'APP_DB_PASSWORD',
      'EXTENSIONS',
      'LEDGER_RECONCILE_CRON',
      'APP_VERSION',
    ]) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv('DATABASE_URL', VALID_URL);
    exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  describe('with valid settings', () => {
    it('fills in the defaults when only DATABASE_URL is set', () => {
      expect(loadEnv()).toEqual({
        NODE_ENV: 'development',
        PORT: 3001,
        DATABASE_URL: VALID_URL,
        EXTENSIONS: [],
        LEDGER_RECONCILE_CRON: '0 2 * * *',
        APP_VERSION: '0.0.0-dev',
      });
    });

    it('turns PORT into a number', () => {
      vi.stubEnv('PORT', '8080');

      expect(loadEnv().PORT).toBe(8080);
    });

    it('accepts the postgresql:// form of the database URL', () => {
      vi.stubEnv('DATABASE_URL', 'postgresql://u:p@db:5432/app');

      expect(loadEnv().DATABASE_URL).toBe('postgresql://u:p@db:5432/app');
    });

    it('splits EXTENSIONS into trimmed package names and skips empty entries', () => {
      vi.stubEnv('EXTENSIONS', ' @acme/pricing, @acme/labels ,, ');

      expect(loadEnv().EXTENSIONS).toEqual(['@acme/pricing', '@acme/labels']);
    });

    it('keeps the release version set in the image', () => {
      vi.stubEnv('APP_VERSION', '1.4.2');

      expect(loadEnv().APP_VERSION).toBe('1.4.2');
    });
  });

  describe('with invalid settings', () => {
    it('stops the process and names DATABASE_URL when it is missing', () => {
      vi.stubEnv('DATABASE_URL', undefined);

      expect(() => loadEnv()).toThrow('process.exit(1)');
      expect(exit).toHaveBeenCalledWith(1);
      expect(errorLog.mock.calls[0]?.[0]).toMatch(/Invalid environment[\s\S]*DATABASE_URL/);
    });

    it.each([
      ['a non postgres DATABASE_URL', 'DATABASE_URL', 'mysql://u:p@localhost/app', 'DATABASE_URL'],
      ['a DATABASE_URL that is not a URL', 'DATABASE_URL', 'localhost:5432', 'DATABASE_URL'],
      ['a PORT that is not a number', 'PORT', 'http', 'PORT'],
      ['a PORT of zero', 'PORT', '0', 'PORT'],
      ['an unknown NODE_ENV', 'NODE_ENV', 'staging', 'NODE_ENV'],
      ['a cron with too few fields', 'LEDGER_RECONCILE_CRON', '0 2 *', 'LEDGER_RECONCILE_CRON'],
    ])('stops the process for %s', (_case, name, value, reported) => {
      vi.stubEnv(name, value);

      expect(() => loadEnv()).toThrow('process.exit(1)');
      expect(errorLog.mock.calls[0]?.[0]).toContain(reported);
    });

    it('does not print the database password when the URL is rejected', () => {
      vi.stubEnv('DATABASE_URL', 'mysql://u:hunter2@localhost/app');

      expect(() => loadEnv()).toThrow('process.exit(1)');
      expect(errorLog.mock.calls[0]?.[0]).not.toContain('hunter2');
    });
  });

  describe('the local .env file', () => {
    it('is loaded outside production when it exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const loadEnvFile = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});

      loadEnv();

      expect(loadEnvFile).toHaveBeenCalledOnce();
      expect(String(loadEnvFile.mock.calls[0]?.[0])).toMatch(/\/\.env$/);
    });

    it('is ignored in production, where Compose provides the settings', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.mocked(existsSync).mockReturnValue(true);
      const loadEnvFile = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});

      loadEnv();

      expect(loadEnvFile).not.toHaveBeenCalled();
    });

    it('is skipped when it does not exist', () => {
      const loadEnvFile = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});

      loadEnv();

      expect(loadEnvFile).not.toHaveBeenCalled();
    });
  });
});
