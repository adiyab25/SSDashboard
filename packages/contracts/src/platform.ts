import { z } from 'zod';

/**
 * Response of `GET /api/config`: public install settings the web needs before sign in.
 * The language fields default and the money fields are optional, so an older api never
 * breaks a newer web (the two images may differ in version).
 */
export const ConfigResponse = z.object({
  clientName: z.string(),
  version: z.string(),
  /** ISO 4217 code, for example `EGP`. */
  currency: z.string().optional(),
  /** IANA time zone name, for example `Africa/Cairo`. */
  timezone: z.string().optional(),
  /** Enabled language codes in switcher order. */
  languages: z.array(z.string()).min(1).default(['en']),
  /** The language a first visit opens in; one of `languages`. */
  defaultLanguage: z.string().default('en'),
});

export type ConfigResponse = z.infer<typeof ConfigResponse>;
