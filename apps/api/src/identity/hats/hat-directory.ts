import { Inject, Injectable, Module } from '@nestjs/common';
import { InternalHat } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { DATABASE } from '../../database/database.module.js';
import type { Executor } from '../../database/sql.js';

/**
 * Read only answer to "who is wearing this hat" for other modules (spec 0008 named it, spec 0016
 * milestone 1 needs it): the tasks module decides with it which queue has nobody in it and so
 * falls to the manager (spec 0016 AC-5, review B1), and who can still hold a task. Kept apart
 * from `HatService`, the only writer of `hat_assignments`, whose audit and auth dependencies the
 * worker does not load. It never writes, never caches (a hat given or taken acts on the next
 * read), and never returns a disabled person.
 */
@Injectable()
export class HatDirectory {
  /** Takes the app database connection. */
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /**
   * The active (not disabled) people wearing the hat, sorted by id. Empty when nobody does. Reads
   * through `executor` when given: a caller inside a transaction passes its own, so no second
   * connection is taken.
   */
  async holdersOf(hat: InternalHat, executor?: Executor): Promise<readonly string[]> {
    return (await this.holdersByHat(executor)).get(hat) ?? [];
  }

  /**
   * The active holders of every internal hat in one read, so a request asks once. Each of the four
   * internal hats has an entry, empty when nobody wears it. Reads through `executor` when given.
   */
  async holdersByHat(
    executor: Executor = this.connection.db,
  ): Promise<ReadonlyMap<InternalHat, readonly string[]>> {
    const { rows } = await executor.execute<{ hat: string; user_ids: string[] }>(
      sql`SELECT h.hat, array_agg(h.user_id ORDER BY h.user_id) AS user_ids
            FROM hat_assignments h
            JOIN users u ON u.id = h.user_id
           WHERE NOT u.banned AND h.hat IN ('support', 'operations', 'warehouse', 'manager')
           GROUP BY h.hat`,
    );
    const byHat = new Map<InternalHat, readonly string[]>(
      InternalHat.options.map((hat) => [hat, []]),
    );
    for (const row of rows) {
      const hat = InternalHat.safeParse(row.hat);
      if (hat.success) byHat.set(hat.data, row.user_ids);
    }
    return byHat;
  }
}

/** Module that exports the hat directory to modules that only read who wears a hat, such as tasks. */
@Module({ providers: [HatDirectory], exports: [HatDirectory] })
export class HatDirectoryModule {}
