import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, runMigrations } from '../src/index.js';
import { createScratchDatabase, dropScratchDatabase } from './database.js';

// Spec 0008, milestone 1 item 1: the identity module's access tables (AC-3), the `users.role`
// check that holds only `user` (AC-16), and the role mapping the rules migration runs (AC-16).

const RULES = readFileSync(
  new URL('../migrations/0002_baseline_rules.sql', import.meta.url),
  'utf8',
);

/** The AC-16 mapping exactly as `0002_baseline_rules.sql` holds it, between its two markers. */
function roleMappingSql(): string {
  const begin = RULES.indexOf('-- AC-16 role mapping: begin');
  const end = RULES.indexOf('-- AC-16 role mapping: end');
  if (begin < 0 || end < begin) throw new Error('the rules migration has no AC-16 role mapping');
  return RULES.slice(begin, end);
}

describe('hats and grants (spec 0008)', () => {
  let name: string;
  let owner: pg.Client;
  let app: pg.Client;
  let counter = 0;
  let partnerAccount: string;

  beforeAll(async () => {
    const db = await createScratchDatabase();
    name = db.name;
    await runMigrations(db.url);
    owner = new pg.Client({ connectionString: db.url });
    app = new pg.Client({ connectionString: db.url });
    await owner.connect();
    await app.connect();
    await app.query(`SET ROLE ${APP_ROLE}`);
    partnerAccount = (
      await owner.query<{ id: string }>(
        `INSERT INTO parties (code, name, is_consignment_partner) VALUES ('SHOWROOM', 'Showroom', true)
         RETURNING id`,
      )
    ).rows[0]?.id as string;
  });

  afterAll(async () => {
    await owner?.end();
    await app?.end();
    await dropScratchDatabase(name);
  });

  async function person(client: pg.Client = app): Promise<string> {
    counter += 1;
    const { rows } = await client.query<{ id: string }>(
      'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id',
      [`Person ${counter}`, `person${counter}@example.test`],
    );
    return rows[0]?.id as string;
  }

  const giveHat = (userId: string, hat: string, account: string | null = null) =>
    app.query(
      'INSERT INTO hat_assignments (user_id, hat, partner_account_id) VALUES ($1, $2, $3)',
      [userId, hat, account],
    );

  describe('users.role (AC-16)', () => {
    it('defaults to user and refuses any other value', async () => {
      const id = await person();
      const { rows } = await app.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [
        id,
      ]);
      expect(rows[0]?.role).toBe('user');

      for (const role of ['admin', 'staff']) {
        await expect(
          app.query("INSERT INTO users (name, email, role) VALUES ('X', $1, $2)", [
            `role-${role}@example.test`,
            role,
          ]),
        ).rejects.toThrow(/users_role_check/);
      }
    });
  });

  describe('hat_assignments (AC-3)', () => {
    it('holds several hats for one person, each once', async () => {
      const id = await person();
      await giveHat(id, 'support');
      await giveHat(id, 'warehouse');

      await expect(giveHat(id, 'support')).rejects.toThrow(/hat_assignments_user_hat_unique/);
      const { rows } = await app.query<{ hat: string }>(
        'SELECT hat FROM hat_assignments WHERE user_id = $1 ORDER BY hat',
        [id],
      );
      expect(rows.map((row) => row.hat)).toEqual(['support', 'warehouse']);
    });

    it('stamps the tenant and the time, and leaves granted_by null when nobody is named', async () => {
      const id = await person();
      await giveHat(id, 'manager');

      const { rows } = await app.query<{ same_tenant: boolean; granted_by: string | null }>(
        `SELECT h.tenant_id = u.tenant_id AS same_tenant, h.granted_by
           FROM hat_assignments h JOIN users u ON u.id = h.user_id WHERE h.user_id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ same_tenant: true, granted_by: null });
    });

    it('refuses a hat outside the six', async () => {
      await expect(giveHat(await person(), 'owner')).rejects.toThrow(/hat_assignments_hat_known/);
    });

    it('binds the partner hat, and only it, to one partner account', async () => {
      const partner = await person();
      await giveHat(partner, 'partner', partnerAccount);

      await expect(giveHat(await person(), 'partner')).rejects.toThrow(
        /hat_assignments_partner_names_account/,
      );
      await expect(giveHat(await person(), 'warehouse', partnerAccount)).rejects.toThrow(
        /hat_assignments_partner_names_account/,
      );
    });

    it('lets the app role insert, read and delete, never update or truncate', async () => {
      const id = await person();
      await giveHat(id, 'support');

      await expect(
        app.query("UPDATE hat_assignments SET hat = 'manager' WHERE user_id = $1", [id]),
      ).rejects.toThrow(/permission denied/);
      await expect(app.query('TRUNCATE hat_assignments')).rejects.toThrow(/permission denied/);
      const deleted = await app.query('DELETE FROM hat_assignments WHERE user_id = $1', [id]);
      expect(deleted.rowCount).toBe(1);
    });
  });

  describe('permission_grants (AC-3, AC-6)', () => {
    it('holds cost.view once per person and refuses any other permission', async () => {
      const id = await person();
      const grant = (permission: string) =>
        app.query('INSERT INTO permission_grants (user_id, permission) VALUES ($1, $2)', [
          id,
          permission,
        ]);
      await grant('cost.view');

      await expect(grant('cost.view')).rejects.toThrow(/permission_grants_user_permission_unique/);
      await expect(grant('people.manage')).rejects.toThrow(
        /permission_grants_permission_grantable/,
      );
    });

    it('lets the app role insert, read and delete, never update or truncate', async () => {
      const id = await person();
      await app.query(
        "INSERT INTO permission_grants (user_id, permission) VALUES ($1, 'cost.view')",
        [id],
      );

      await expect(
        app.query('UPDATE permission_grants SET granted_at = now() WHERE user_id = $1', [id]),
      ).rejects.toThrow(/permission denied/);
      await expect(app.query('TRUNCATE permission_grants')).rejects.toThrow(/permission denied/);
      const deleted = await app.query('DELETE FROM permission_grants WHERE user_id = $1', [id]);
      expect(deleted.rowCount).toBe(1);
    });
  });

  // Runs last: it lifts the role check to plant people as a database migrated before hats held them.
  describe('the role mapping of the rules migration (AC-16)', () => {
    it('maps admin to manager plus cost.view and staff to support, operations and warehouse', async () => {
      await owner.query('ALTER TABLE users DROP CONSTRAINT users_role_check');
      const plant = async (role: string): Promise<string> => {
        counter += 1;
        const { rows } = await owner.query<{ id: string }>(
          'INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING id',
          [`Legacy ${counter}`, `legacy${counter}@example.test`, role],
        );
        return rows[0]?.id as string;
      };
      const admin = await plant('admin');
      const staff = await plant('staff');

      // Twice: a rerun of the same statements adds nothing.
      await owner.query(roleMappingSql());
      await owner.query(roleMappingSql());

      const hatsOf = async (id: string) =>
        (
          await owner.query<{ hat: string }>(
            'SELECT hat FROM hat_assignments WHERE user_id = $1 ORDER BY hat',
            [id],
          )
        ).rows.map((row) => row.hat);
      const grantsOf = async (id: string) =>
        (
          await owner.query<{ permission: string; granted_by: string | null }>(
            'SELECT permission, granted_by FROM permission_grants WHERE user_id = $1',
            [id],
          )
        ).rows;
      expect(await hatsOf(admin)).toEqual(['manager']);
      expect(await grantsOf(admin)).toEqual([{ permission: 'cost.view', granted_by: null }]);
      expect(await hatsOf(staff)).toEqual(['operations', 'support', 'warehouse']);
      expect(await grantsOf(staff)).toEqual([]);

      const roles = await owner.query<{ role: string }>('SELECT DISTINCT role FROM users');
      expect(roles.rows.map((row) => row.role)).toEqual(['user']);
      // The check the baseline holds goes back on: every row already satisfies it.
      await owner.query("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role = 'user')");
    });
  });
});
