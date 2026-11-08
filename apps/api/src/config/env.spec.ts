import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { randomBytes } from 'node:crypto';
import { connectorKeyBytes, loadEnv, loadMigrateEnv, staffBase, staffOrigin } from './env.js';

vi.mock('node:fs', () => ({ existsSync: vi.fn(() => false) }));

const VALID_URL = 'postgres://ssdashboard:secret@localhost:5433/ssdashboard';
const VALID_SECRET = 'x'.repeat(32);
// Required in every environment (spec 0015, AC-2); a public test value, 32 bytes as hex.
const VALID_CONNECTOR_KEY = 'ab12'.repeat(16);

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
      'TENANT_ID',
      'APP_DB_ROLE',
      'EXTENSIONS',
      'LEDGER_RECONCILE_CRON',
      'AUTH_CLEANUP_CRON',
      'LICENSE_FILE',
      'LICENSE_CHECK_CRON',
      'APP_VERSION',
      'CLIENT_DISPLAY_NAME',
      'PUBLIC_URL',
      'STAFF_BASE_PATH',
      'PORTAL_ORIGIN',
      'BETTER_AUTH_SECRET',
      'MAIL_DRIVER',
      'MAIL_FROM',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_SECURITY',
      'SMTP_USER',
      'SMTP_PASSWORD',
      'POSTMARK_SERVER_TOKEN',
      'CONNECTOR_SECRET_KEY',
      'CONNECTOR_SECRET_KEY_PREVIOUS',
      'SHOPIFY_MOCK_ORIGIN',
    ]) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv('DATABASE_URL', VALID_URL);
    vi.stubEnv('PUBLIC_URL', 'https://erp.example.com');
    vi.stubEnv('BETTER_AUTH_SECRET', VALID_SECRET);
    vi.stubEnv('CONNECTOR_SECRET_KEY', VALID_CONNECTOR_KEY);
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
    it('fills in the defaults when only the required settings are set', () => {
      expect(loadEnv()).toEqual({
        NODE_ENV: 'development',
        PORT: 3001,
        DATABASE_URL: VALID_URL,
        EXTENSIONS: [],
        LEDGER_RECONCILE_CRON: '0 2 * * *',
        AUTH_CLEANUP_CRON: '0 3 * * *',
        LICENSE_CHECK_CRON: '20 0 * * *',
        APP_VERSION: '0.0.0-dev',
        CLIENT_DISPLAY_NAME: 'SSDashboard',
        PUBLIC_URL: 'https://erp.example.com',
        STAFF_BASE_PATH: '',
        BETTER_AUTH_SECRET: VALID_SECRET,
        CONNECTOR_SECRET_KEY: VALID_CONNECTOR_KEY,
        MAIL_DRIVER: 'none',
        SMTP_PORT: 587,
        SMTP_SECURITY: 'starttls',
      });
    });

    it('drops a trailing slash from PUBLIC_URL', () => {
      vi.stubEnv('PUBLIC_URL', 'http://localhost:3000/');

      expect(loadEnv().PUBLIC_URL).toBe('http://localhost:3000');
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

    it('reads the owner role URL and app role password that only migrate uses', () => {
      vi.stubEnv('MIGRATION_DATABASE_URL', 'postgres://owner:pw@localhost:5433/ssdashboard');
      vi.stubEnv('APP_DB_PASSWORD', 'secret');

      expect(loadEnv()).toMatchObject({
        MIGRATION_DATABASE_URL: 'postgres://owner:pw@localhost:5433/ssdashboard',
        APP_DB_PASSWORD: 'secret',
      });
    });

    it('leaves TENANT_ID and APP_DB_ROLE unset when neither is given', () => {
      expect(loadEnv().TENANT_ID).toBeUndefined();
      expect(loadEnv().APP_DB_ROLE).toBeUndefined();
    });

    it('reads TENANT_ID and APP_DB_ROLE, and counts blank values as unset', () => {
      vi.stubEnv('TENANT_ID', '0192f7a0-0000-7000-8000-000000000001');
      vi.stubEnv('APP_DB_ROLE', 'ssd_acme_app');
      expect(loadEnv()).toMatchObject({
        TENANT_ID: '0192f7a0-0000-7000-8000-000000000001',
        APP_DB_ROLE: 'ssd_acme_app',
      });

      vi.stubEnv('TENANT_ID', '');
      vi.stubEnv('APP_DB_ROLE', '');
      expect(loadEnv().TENANT_ID).toBeUndefined();
      expect(loadEnv().APP_DB_ROLE).toBeUndefined();
    });

    it.each([
      ['a TENANT_ID that is not a uuid', 'TENANT_ID', 'acme'],
      ['an APP_DB_ROLE with a quote', 'APP_DB_ROLE', 'a"b'],
    ])('stops on %s', (_label, name, value) => {
      vi.stubEnv(name, value);

      expect(() => loadEnv()).toThrow();
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(name));
    });

    it('keeps a custom reconciliation schedule', () => {
      vi.stubEnv('LEDGER_RECONCILE_CRON', '15 1 * * 1');

      expect(loadEnv().LEDGER_RECONCILE_CRON).toBe('15 1 * * 1');
    });

    it('keeps a license file path and a custom license check schedule, and counts a blank path as unset', () => {
      vi.stubEnv('LICENSE_FILE', '/run/secrets/license.json');
      vi.stubEnv('LICENSE_CHECK_CRON', '5 1 * * *');

      expect(loadEnv()).toMatchObject({
        LICENSE_FILE: '/run/secrets/license.json',
        LICENSE_CHECK_CRON: '5 1 * * *',
      });
      vi.stubEnv('LICENSE_FILE', '  ');
      expect(loadEnv().LICENSE_FILE).toBeUndefined();
    });

    it('keeps a custom auth cleanup schedule', () => {
      vi.stubEnv('AUTH_CLEANUP_CRON', '30 4 * * 0');

      expect(loadEnv().AUTH_CLEANUP_CRON).toBe('30 4 * * 0');
    });

    it.each([
      '0 3 * * *',
      '*/5 * * * *',
      '0 3 * * 1-5',
      '0,30 8-18 * jan-mar mon,fri',
      '0 0 1 */2 7',
    ])('accepts the cron %s', (expression) => {
      vi.stubEnv('AUTH_CLEANUP_CRON', expression);
      vi.stubEnv('LEDGER_RECONCILE_CRON', expression);

      expect(loadEnv()).toMatchObject({
        AUTH_CLEANUP_CRON: expression,
        LEDGER_RECONCILE_CRON: expression,
      });
    });

    it('keeps the install name, trimmed', () => {
      vi.stubEnv('CLIENT_DISPLAY_NAME', '  Acme Home  ');

      expect(loadEnv().CLIENT_DISPLAY_NAME).toBe('Acme Home');
    });

    it('falls back to SSDashboard when the install name is blank', () => {
      vi.stubEnv('CLIENT_DISPLAY_NAME', '   ');

      expect(loadEnv().CLIENT_DISPLAY_NAME).toBe('SSDashboard');
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
      [
        'an auth cleanup cron with too few fields',
        'AUTH_CLEANUP_CRON',
        '0 3 *',
        'AUTH_CLEANUP_CRON',
      ],
      ['a cron of five words', 'AUTH_CLEANUP_CRON', 'a b c d e', 'AUTH_CLEANUP_CRON'],
      [
        'a reconcile cron of five words',
        'LEDGER_RECONCILE_CRON',
        'a b c d e',
        'LEDGER_RECONCILE_CRON',
      ],
      ['a cron minute out of range', 'AUTH_CLEANUP_CRON', '60 3 * * *', 'AUTH_CLEANUP_CRON'],
      ['a cron hour out of range', 'AUTH_CLEANUP_CRON', '0 24 * * *', 'AUTH_CLEANUP_CRON'],
      ['a cron month of zero', 'AUTH_CLEANUP_CRON', '0 3 1 0 *', 'AUTH_CLEANUP_CRON'],
      ['a cron weekday past 7', 'AUTH_CLEANUP_CRON', '0 3 * * 8', 'AUTH_CLEANUP_CRON'],
      ['a cron range that runs backwards', 'AUTH_CLEANUP_CRON', '0 3 * * 5-1', 'AUTH_CLEANUP_CRON'],
      ['a cron step of zero', 'AUTH_CLEANUP_CRON', '*/0 3 * * *', 'AUTH_CLEANUP_CRON'],
      ['a cron with a bad name', 'AUTH_CLEANUP_CRON', '0 3 * foo *', 'AUTH_CLEANUP_CRON'],
      [
        'a license check cron hour out of range',
        'LICENSE_CHECK_CRON',
        '20 25 * * *',
        'LICENSE_CHECK_CRON',
      ],
      [
        'a non postgres MIGRATION_DATABASE_URL',
        'MIGRATION_DATABASE_URL',
        'mysql://u:p@localhost/app',
        'MIGRATION_DATABASE_URL',
      ],
      ['an empty APP_DB_PASSWORD', 'APP_DB_PASSWORD', '', 'APP_DB_PASSWORD'],
      ['a PUBLIC_URL that is not a URL', 'PUBLIC_URL', 'erp.example.com', 'PUBLIC_URL'],
      ['a PUBLIC_URL with a path', 'PUBLIC_URL', 'https://erp.example.com/app', 'PUBLIC_URL'],
      [
        'a BETTER_AUTH_SECRET under 32 characters',
        'BETTER_AUTH_SECRET',
        'short',
        'BETTER_AUTH_SECRET',
      ],
      [
        'an install name over 80 characters',
        'CLIENT_DISPLAY_NAME',
        'x'.repeat(81),
        'CLIENT_DISPLAY_NAME',
      ],
    ])('stops the process for %s', (_case, name, value, reported) => {
      vi.stubEnv(name, value);

      expect(() => loadEnv()).toThrow('process.exit(1)');
      expect(errorLog.mock.calls[0]?.[0]).toContain(reported);
    });

    it.each(['PUBLIC_URL', 'BETTER_AUTH_SECRET'])(
      'stops the process when %s is missing',
      (name) => {
        vi.stubEnv(name, undefined);

        expect(() => loadEnv()).toThrow('process.exit(1)');
        expect(errorLog.mock.calls[0]?.[0]).toContain(name);
      },
    );

    it('does not print the database password when the URL is rejected', () => {
      vi.stubEnv('DATABASE_URL', 'mysql://u:hunter2@localhost/app');

      expect(() => loadEnv()).toThrow('process.exit(1)');
      expect(errorLog.mock.calls[0]?.[0]).not.toContain('hunter2');
    });
  });

  describe('staff cookie path and portal host (spec 0005, AC-30, AC-31)', () => {
    it('leaves STAFF_BASE_PATH empty (Path=/) when it is unset or blank', () => {
      expect(loadEnv().STAFF_BASE_PATH).toBe('');

      vi.stubEnv('STAFF_BASE_PATH', '  ');
      expect(loadEnv().STAFF_BASE_PATH).toBe('');
    });

    it.each(['/ops', '/staff/back-office', '/a.b_c~d'])('keeps STAFF_BASE_PATH %s', (path) => {
      vi.stubEnv('STAFF_BASE_PATH', path);

      expect(loadEnv().STAFF_BASE_PATH).toBe(path);
    });

    it.each([
      ['no leading slash', 'ops', 'must start with /'],
      ['a trailing slash', '/ops/', 'must not end with /'],
      ['a lone slash', '/', 'must not end with /'],
      ['a parent segment', '/ops/../admin', 'must not contain ..'],
      ['a bare parent', '/..', 'must not contain ..'],
      ['a semicolon, which would end the cookie attribute', '/ops;Domain=x', 'may hold only'],
      ['a space', '/my ops', 'may hold only'],
      ['an empty first segment', '//ops', 'must not be empty or start with a dot'],
      ['a protocol relative host', '//evil.example', 'must not be empty or start with a dot'],
      ['a dot segment', '/./ops', 'must not be empty or start with a dot'],
      ['a lone dot', '/.', 'must not be empty or start with a dot'],
      ['a dot segment inside', '/ops/./x', 'must not be empty or start with a dot'],
      ['an empty inner segment', '/ops//x', 'must not be empty or start with a dot'],
      ['a hidden segment', '/.ops', 'must not be empty or start with a dot'],
    ])('stops the process for a STAFF_BASE_PATH with %s', (_case, path, message) => {
      vi.stubEnv('STAFF_BASE_PATH', path);

      expect(() => loadEnv()).toThrow('process.exit(1)');
      const printed = errorLog.mock.calls.flat().join(' ');
      expect(printed).toMatch(/Invalid environment[\s\S]*STAFF_BASE_PATH/);
      expect(printed).toContain(message);
    });

    it('leaves PORTAL_ORIGIN unset by default, and counts blank as unset', () => {
      expect(loadEnv().PORTAL_ORIGIN).toBeUndefined();

      vi.stubEnv('PORTAL_ORIGIN', '');
      expect(loadEnv().PORTAL_ORIGIN).toBeUndefined();
    });

    it('reads PORTAL_ORIGIN and drops a trailing slash', () => {
      vi.stubEnv('PORTAL_ORIGIN', 'https://shop.example.com/');

      expect(loadEnv().PORTAL_ORIGIN).toBe('https://shop.example.com');
    });

    it.each([
      ['not a URL', 'shop.example.com', 'PORTAL_ORIGIN'],
      ['with a path', 'https://shop.example.com/store', 'must not have a path'],
      ['the staff host itself', 'https://erp.example.com', 'different host name from PUBLIC_URL'],
      ['the staff name on another port', 'https://erp.example.com:8443', 'different host name'],
      ['the staff name over http on 443', 'http://erp.example.com:443', 'different host name'],
      ['the staff name with a trailing dot', 'https://ERP.example.com.', 'different host name'],
    ])('stops the process for a PORTAL_ORIGIN %s', (_case, value, message) => {
      vi.stubEnv('PORTAL_ORIGIN', value);

      expect(() => loadEnv()).toThrow('process.exit(1)');
      const printed = errorLog.mock.calls.flat().join(' ');
      expect(printed).toContain('PORTAL_ORIGIN');
      expect(printed).toContain(message);
    });
  });

  describe('connector secret keys and the Shopify mock (spec 0015, AC-2, AC-26)', () => {
    // Generated per run: test keys only.
    const base64Key = randomBytes(32).toString('base64');
    const hexKey = randomBytes(32).toString('hex');

    it('accepts a key as 32 bytes of base64, url safe base64, or 64 hex characters', () => {
      expect(connectorKeyBytes(base64Key)?.length).toBe(32);
      expect(connectorKeyBytes(randomBytes(32).toString('base64url'))?.length).toBe(32);
      expect(connectorKeyBytes(hexKey)?.length).toBe(32);
      vi.stubEnv('CONNECTOR_SECRET_KEY', base64Key);
      vi.stubEnv('CONNECTOR_SECRET_KEY_PREVIOUS', hexKey);

      expect(loadEnv()).toMatchObject({
        CONNECTOR_SECRET_KEY: base64Key,
        CONNECTOR_SECRET_KEY_PREVIOUS: hexKey,
      });
    });

    it.each([
      ['31 bytes', randomBytes(31).toString('base64')],
      ['33 bytes', randomBytes(33).toString('base64')],
      ['62 hex characters', randomBytes(31).toString('hex')],
      ['text that is not base64', 'not a key, not a key, not a key, not a key!'],
    ])('stops the process for a key of %s, without printing it', (_case, key) => {
      vi.stubEnv('CONNECTOR_SECRET_KEY', key);

      expect(connectorKeyBytes(key)).toBeUndefined();
      expect(() => loadEnv()).toThrow('process.exit(1)');
      expect(errorLog.mock.calls[0]?.[0]).toContain('CONNECTOR_SECRET_KEY');
      expect(errorLog.mock.calls[0]?.[0]).not.toContain(key);
    });

    it.each(['development', 'test', 'production'])(
      'requires the key when NODE_ENV is %s, and leaves the previous key unset',
      (nodeEnv) => {
        vi.stubEnv('NODE_ENV', nodeEnv);
        expect(loadEnv().CONNECTOR_SECRET_KEY_PREVIOUS).toBeUndefined();

        vi.stubEnv('CONNECTOR_SECRET_KEY', undefined);
        expect(() => loadEnv()).toThrow('process.exit(1)');
        expect(errorLog.mock.calls[0]?.[0]).toContain('CONNECTOR_SECRET_KEY');

        vi.stubEnv('CONNECTOR_SECRET_KEY', base64Key);
        expect(loadEnv().CONNECTOR_SECRET_KEY).toBe(base64Key);
      },
    );

    it('refuses a previous key without a current one, or equal to it in another spelling', () => {
      vi.stubEnv('CONNECTOR_SECRET_KEY', undefined);
      vi.stubEnv('CONNECTOR_SECRET_KEY_PREVIOUS', base64Key);
      expect(() => loadEnv()).toThrow('process.exit(1)');

      vi.stubEnv('CONNECTOR_SECRET_KEY', Buffer.from(base64Key, 'base64').toString('hex'));
      expect(() => loadEnv()).toThrow('process.exit(1)');
      expect(errorLog.mock.calls[1]?.[0]).toContain('Must differ from CONNECTOR_SECRET_KEY');

      vi.stubEnv('CONNECTOR_SECRET_KEY', hexKey);
      expect(loadEnv().CONNECTOR_SECRET_KEY_PREVIOUS).toBe(base64Key);
    });

    it('reads SHOPIFY_MOCK_ORIGIN outside production, dropping a trailing slash', () => {
      vi.stubEnv('SHOPIFY_MOCK_ORIGIN', 'http://localhost:3935/');

      expect(loadEnv().SHOPIFY_MOCK_ORIGIN).toBe('http://localhost:3935');
    });

    it('refuses SHOPIFY_MOCK_ORIGIN when NODE_ENV is production', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('CONNECTOR_SECRET_KEY', base64Key);
      vi.stubEnv('SHOPIFY_MOCK_ORIGIN', 'http://localhost:3935');

      expect(() => loadEnv()).toThrow('process.exit(1)');
      expect(errorLog.mock.calls[0]?.[0]).toContain('SHOPIFY_MOCK_ORIGIN');
    });
  });

  describe('the one staff origin (spec 0005, AC-30)', () => {
    it('derives the origin from PUBLIC_URL and the base from it plus STAFF_BASE_PATH', () => {
      vi.stubEnv('PUBLIC_URL', 'https://ERP.example.com:8443/');
      vi.stubEnv('STAFF_BASE_PATH', '/ops');
      const env = loadEnv();

      expect(staffOrigin(env)).toBe('https://erp.example.com:8443');
      expect(staffBase(env)).toBe('https://erp.example.com:8443/ops');
      expect(staffBase({ PUBLIC_URL: 'http://localhost:3000', STAFF_BASE_PATH: '' })).toBe(
        'http://localhost:3000',
      );
    });
  });

  describe('mail settings (spec 0005)', () => {
    const failsWith = (message: string) => {
      expect(() => loadEnv()).toThrow('process.exit(1)');
      expect(errorLog.mock.calls.flat().join(' ')).toContain(message);
    };

    it('needs nothing when the driver is none, even if blank values are present', () => {
      vi.stubEnv('MAIL_FROM', '  ');
      vi.stubEnv('SMTP_HOST', '');

      expect(loadEnv()).toMatchObject({ MAIL_DRIVER: 'none', MAIL_FROM: undefined });
    });

    it('accepts a complete smtp setup, with or without a login', () => {
      vi.stubEnv('MAIL_DRIVER', 'smtp');
      vi.stubEnv('MAIL_FROM', 'ERP <no-reply@client.com>');
      vi.stubEnv('SMTP_HOST', 'mail.client.com');

      expect(loadEnv()).toMatchObject({ SMTP_HOST: 'mail.client.com', SMTP_PORT: 587 });

      vi.stubEnv('SMTP_USER', 'robot');
      vi.stubEnv('SMTP_PASSWORD', 'hunter2');
      vi.stubEnv('SMTP_SECURITY', 'tls');
      vi.stubEnv('SMTP_PORT', '465');
      expect(loadEnv()).toMatchObject({ SMTP_USER: 'robot', SMTP_SECURITY: 'tls', SMTP_PORT: 465 });
    });

    it('stops when a sender is missing for a mail driver', () => {
      vi.stubEnv('MAIL_DRIVER', 'smtp');
      vi.stubEnv('SMTP_HOST', 'mail.client.com');

      failsWith('MAIL_FROM');
    });

    it('stops when smtp has no host', () => {
      vi.stubEnv('MAIL_DRIVER', 'smtp');
      vi.stubEnv('MAIL_FROM', 'no-reply@client.com');

      failsWith('SMTP_HOST');
    });

    it('stops when only one of the smtp user and password is set', () => {
      vi.stubEnv('MAIL_DRIVER', 'smtp');
      vi.stubEnv('MAIL_FROM', 'no-reply@client.com');
      vi.stubEnv('SMTP_HOST', 'mail.client.com');
      vi.stubEnv('SMTP_USER', 'robot');

      failsWith('set together');
    });

    it('stops when postmark has no token, and accepts it with one', () => {
      vi.stubEnv('MAIL_DRIVER', 'postmark');
      vi.stubEnv('MAIL_FROM', 'no-reply@client.com');
      failsWith('POSTMARK_SERVER_TOKEN');

      vi.stubEnv('POSTMARK_SERVER_TOKEN', 'token');
      expect(loadEnv().MAIL_DRIVER).toBe('postmark');
    });

    it('rejects a driver it does not know', () => {
      vi.stubEnv('MAIL_DRIVER', 'carrier-pigeon');

      failsWith('MAIL_DRIVER');
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
      vi.stubEnv('CONNECTOR_SECRET_KEY', 'ab12'.repeat(16));
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

  describe('loadMigrateEnv', () => {
    const OWNER_URL = 'postgres://ssdashboard:pw@postgres:5432/ssdashboard';

    beforeEach(() => {
      // migrate's container gets none of the api's settings (deploy/compose.yaml).
      vi.stubEnv('DATABASE_URL', undefined);
      vi.stubEnv('PUBLIC_URL', undefined);
      vi.stubEnv('BETTER_AUTH_SECRET', undefined);
    });

    it('needs only MIGRATION_DATABASE_URL, not the api auth settings', () => {
      vi.stubEnv('MIGRATION_DATABASE_URL', OWNER_URL);

      expect(loadMigrateEnv()).toEqual({
        NODE_ENV: 'development',
        MIGRATION_DATABASE_URL: OWNER_URL,
      });
    });

    it('reads the app role password, TENANT_ID and APP_DB_ROLE, blank counting as unset', () => {
      vi.stubEnv('MIGRATION_DATABASE_URL', OWNER_URL);
      vi.stubEnv('APP_DB_PASSWORD', 'secret');
      vi.stubEnv('TENANT_ID', '0192f7a0-0000-7000-8000-000000000001');
      vi.stubEnv('APP_DB_ROLE', 'ssd_acme_app');
      expect(loadMigrateEnv()).toMatchObject({
        APP_DB_PASSWORD: 'secret',
        TENANT_ID: '0192f7a0-0000-7000-8000-000000000001',
        APP_DB_ROLE: 'ssd_acme_app',
      });

      vi.stubEnv('TENANT_ID', '');
      vi.stubEnv('APP_DB_ROLE', '');
      expect(loadMigrateEnv()).toMatchObject({ TENANT_ID: undefined, APP_DB_ROLE: undefined });
    });

    it('stops the process and names MIGRATION_DATABASE_URL when it is missing', () => {
      expect(() => loadMigrateEnv()).toThrow('process.exit(1)');
      expect(exit).toHaveBeenCalledWith(1);
      expect(errorLog.mock.calls[0]?.[0]).toMatch(
        /Invalid environment[\s\S]*MIGRATION_DATABASE_URL/,
      );
    });

    it.each([
      ['a non postgres MIGRATION_DATABASE_URL', 'MIGRATION_DATABASE_URL', 'mysql://u:p@h/db'],
      ['a TENANT_ID that is not a uuid', 'TENANT_ID', 'acme'],
      ['an APP_DB_ROLE with a quote', 'APP_DB_ROLE', 'a"b'],
    ])('stops on %s, with the same rules as loadEnv', (_label, name, value) => {
      vi.stubEnv('MIGRATION_DATABASE_URL', OWNER_URL);
      vi.stubEnv(name, value);

      expect(() => loadMigrateEnv()).toThrow('process.exit(1)');
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(name));
    });

    it('loads the local .env outside production, like loadEnv', () => {
      vi.stubEnv('MIGRATION_DATABASE_URL', OWNER_URL);
      vi.mocked(existsSync).mockReturnValue(true);
      const loadEnvFile = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});

      loadMigrateEnv();

      expect(loadEnvFile).toHaveBeenCalledOnce();
    });
  });
});
