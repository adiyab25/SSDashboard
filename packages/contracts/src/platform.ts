import { z } from 'zod';

/** Response of `GET /api/config`: public install settings the web needs before sign in. */
export const ConfigResponse = z.object({
  clientName: z.string(),
  version: z.string(),
});

export type ConfigResponse = z.infer<typeof ConfigResponse>;
