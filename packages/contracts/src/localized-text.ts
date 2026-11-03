import { z } from 'zod';

/** Text stored per language, matching the `{ en, ar }` jsonb columns of spec 0002. */
export const LocalizedText = z.object({
  en: z.string().optional(),
  ar: z.string().optional(),
});

export type LocalizedText = z.infer<typeof LocalizedText>;
