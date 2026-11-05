import { describe, expect, it } from 'vitest';
import { renderMail, type MailKind } from './mail-templates.js';

/**
 * Pins the exact subject, text and html of every message (spec 0004, AC-15), so moving the words
 * into the shared catalog cannot change a single character. Update the snapshot only on purpose.
 */
const input = {
  name: 'Sam & <Co>',
  clientName: 'Acme Home',
  link: 'https://erp.example.com/api/auth/reset-password/abc123?callbackURL=x&y=1',
};

describe('renderMail output (AC-15)', () => {
  const kinds: MailKind[] = ['reset', 'invite'];
  const languages = ['en', 'ar'];

  for (const kind of kinds) {
    for (const language of languages) {
      it(`keeps the ${kind} email in ${language} exactly as written`, () => {
        expect(renderMail({ ...input, kind, language })).toMatchSnapshot();
      });
    }
  }
});
