import { describe, expect, it } from 'vitest';
import { tokenFromIdentifier, tokenLink } from './mail-links.js';
import { renderMail } from './mail-templates.js';

const LINK = 'https://erp.example.com/api/auth/reset-password/abc123?callbackURL=x';
const base = { name: 'Sam', clientName: 'Acme Home', link: LINK };

describe('renderMail', () => {
  it('writes the reset email in English, with the link in text and html', () => {
    const mail = renderMail({ ...base, kind: 'reset', language: 'en' });

    expect(mail.subject).toBe('Reset your Acme Home password');
    expect(mail.text).toContain('Hello Sam,');
    expect(mail.text).toContain(LINK);
    expect(mail.text).toContain('expires in 1 hour');
    expect(mail.html).toContain('lang="en" dir="ltr"');
    expect(mail.html).toContain(`href="${LINK}"`);
  });

  it('writes the invite email with its 7 day life', () => {
    const mail = renderMail({ ...base, kind: 'invite', language: 'en' });

    expect(mail.subject).toBe('You have been invited to Acme Home');
    expect(mail.text).toContain('7 days');
  });

  it('writes Arabic right to left, and keeps the link left to right', () => {
    const mail = renderMail({ ...base, kind: 'reset', language: 'ar' });

    expect(mail.subject).toContain('Acme Home');
    expect(mail.subject).toMatch(/[؀-ۿ]/);
    expect(mail.html).toContain('lang="ar" dir="rtl"');
    expect(mail.html).toContain('direction:ltr');
    expect(mail.text).toContain(LINK);
  });

  it.each(['fr', '', 'en-GB'])('falls back to English for the language "%s"', (language) => {
    expect(renderMail({ ...base, kind: 'reset', language }).subject).toBe(
      'Reset your Acme Home password',
    );
  });

  it('escapes a name or client name that carries markup', () => {
    const mail = renderMail({
      kind: 'reset',
      language: 'en',
      name: '<script>alert(1)</script>',
      clientName: 'A & B "Co"',
      link: 'https://erp.example.com/?a=1&b=2',
    });

    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.html).toContain('A &amp; B &quot;Co&quot;');
    expect(mail.html).toContain('a=1&amp;b=2');
  });

  it('greets a person with no name instead of leaving a gap', () => {
    expect(renderMail({ ...base, name: '  ', kind: 'reset', language: 'en' }).text).toContain(
      'Hello there,',
    );
  });
});

describe('the token link (AC-9)', () => {
  it('points at the token check, with the reset page as the way on', () => {
    const link = tokenLink('https://erp.example.com', 'tok123', 'reset');

    expect(link).toBe(
      'https://erp.example.com/api/auth/reset-password/tok123?callbackURL=https%3A%2F%2Ferp.example.com%2Freset-password',
    );
  });

  it('marks an invite so the page can use invite wording', () => {
    const url = new URL(tokenLink('https://erp.example.com', 'tok123', 'invite'));

    expect(new URL(url.searchParams.get('callbackURL') as string).search).toBe('?invite=1');
  });

  it('reads the token back out of a verifications identifier, and nothing else', () => {
    expect(tokenFromIdentifier('reset-password:tok123')).toBe('tok123');
    expect(tokenFromIdentifier('email-verification:tok123')).toBeUndefined();
  });
});
