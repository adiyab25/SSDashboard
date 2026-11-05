import { Inject, Injectable, Module } from '@nestjs/common';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../database/database.module.js';
import { pgArray } from '../database/sql.js';

/**
 * Read only lookups of staff for other modules, such as "posted by" names (spec 0006). Kept apart
 * from `StaffService`, whose auth and mail dependencies the worker does not load.
 */
@Injectable()
export class StaffDirectory {
  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Display names by user id. Unknown ids are left out. */
  async namesByIds(ids: readonly string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const { rows } = await this.connection.db.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM users WHERE id = ANY(${pgArray([...new Set(ids)])}::uuid[])`,
    );
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}

/** Module that exports the staff directory to modules which only need names, such as inventory. */
@Module({ providers: [StaffDirectory], exports: [StaffDirectory] })
export class StaffDirectoryModule {}
