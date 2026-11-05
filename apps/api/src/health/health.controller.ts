import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { Public } from '../auth/public.decorator.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DATABASE } from '../database/database.module.js';
import { Audience } from '../platform/audience/audience.decorator.js';

const DB_PROBE_TIMEOUT_MS = 2_000;

/**
 * Public `GET /api/health`: reports the app version and whether PostgreSQL answers within two
 * seconds. It must stay unauthenticated and cheap.
 */
@Audience('public')
@Public()
@Controller('health')
export class HealthController {
  /** Takes the database connection to probe and the env for the reported version. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Always answers 200 so the container stays alive; `database` says whether PostgreSQL is reachable. */
  @Get()
  async check(): Promise<HealthResponse> {
    const database = (await this.probeDatabase()) ? 'up' : 'down';
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      version: this.env.APP_VERSION,
      database,
    };
  }

  private async probeDatabase(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(resolve, DB_PROBE_TIMEOUT_MS, false);
    });
    const probe = this.connection.db.execute(sql`select 1`).then(
      () => true,
      () => false,
    );
    try {
      return await Promise.race([probe, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
