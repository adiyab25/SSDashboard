import { z } from 'zod';

/** Response of `GET /api/health`. The api answers even when the database is down. */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  database: z.enum(['up', 'down']),
});

export type HealthResponse = z.infer<typeof HealthResponse>;
