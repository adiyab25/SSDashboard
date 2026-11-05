import { createTranslatorSync } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';

/** Which message: a forgotten password, or an admin's invitation to set a first password. */
export type MailKind = 'reset' | 'invite';

/**
 * What a message is built from: its kind, the recipient's language and name, the client's name
 * and the one time link.
 */
export interface MailTemplateInput {
  kind: MailKind;
  /** `ar` or anything else (English). The caller picks the recipient's saved language. */
  language: string;
  name: string;
  clientName: string;
  link: string;
}

/** A finished message in three parts: subject, plain text and HTML. */
export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * The email in the recipient's language (spec 0005, AC-11). The words live in the shared
 * catalog (`mail.*` in `@ssdashboard/i18n`, spec 0004 AC-15); Arabic is passed in so the call stays
 * synchronous, and any other language gets English. Arabic is set right to left, and
 * the link is plain text in both so a mail client that strips buttons still shows it.
 */
export function renderMail(input: MailTemplateInput): RenderedMail {
  const { t, language: lang, dir } = createTranslatorSync(input.language, { ar });
  const name = input.name.trim() || t('mail.fallbackName');
  const greeting = t(`mail.${input.kind}.greeting`, { name });
  const body = t(`mail.${input.kind}.body`);
  const action = t(`mail.${input.kind}.action`);
  const validity = t(`mail.${input.kind}.validity`);
  const ignore = t(`mail.${input.kind}.ignore`);
  const text = [
    greeting,
    '',
    body,
    '',
    input.link,
    '',
    validity,
    ignore,
    '',
    input.clientName,
  ].join('\n');
  const html = `<!doctype html>
<html lang="${lang}" dir="${dir}">
<body style="margin:0;padding:24px;font-family:system-ui,Segoe UI,Tahoma,sans-serif;line-height:1.6;color:#1a1a1a;">
<p>${escapeHtml(greeting)}</p>
<p>${escapeHtml(body)}</p>
<p><a href="${escapeHtml(input.link)}" style="display:inline-block;padding:10px 18px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(action)}</a></p>
<p style="direction:ltr;unicode-bidi:plaintext;word-break:break-all;font-size:13px;color:#555555;">${escapeHtml(input.link)}</p>
<p style="color:#555555;">${escapeHtml(validity)}<br>${escapeHtml(ignore)}</p>
<p style="color:#555555;">${escapeHtml(input.clientName)}</p>
</body>
</html>`;
  return { subject: t(`mail.${input.kind}.subject`, { clientName: input.clientName }), text, html };
}
