import { Inject, Injectable } from '@nestjs/common';
import type { UpdateMeRequest } from '@ssdashboard/contracts';
import { sql, type Database, type DatabaseConnection, type SQL } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import { assertLanguageEnabled } from '../../platform/languages.js';
import { SettingsService } from '../../platform/settings.service.js';

/** A person's own profile (spec 0005, AC-19): name, phone and language, and nothing else. */
@Injectable()
export class ProfileService {
  private readonly db: Database;

  /**
   * Takes the app database connection and the settings service that knows which languages are
   * enabled.
   */
  constructor(
    @Inject(DATABASE) connection: DatabaseConnection,
    private readonly settings: SettingsService,
  ) {
    this.db = connection.db;
  }

  /**
   * Saves the person's name, phone and language. Rejects a language the install has not enabled,
   * and never touches email, role or password.
   */
  async update(userId: string, input: UpdateMeRequest): Promise<void> {
    await assertLanguageEnabled(this.settings, input.language);
    const sets: SQL[] = [];
    if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
    if (input.phone !== undefined) sets.push(sql`phone = ${input.phone}`);
    if (input.language !== undefined) sets.push(sql`language = ${input.language}`);
    if (sets.length === 0) return;
    await this.db.execute(
      sql`UPDATE users SET ${sql.join(sets, sql`, `)}, updated_at = now() WHERE id = ${userId}::uuid`,
    );
  }
}
