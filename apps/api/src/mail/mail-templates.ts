/** Which message: a forgotten password, or an admin's invitation to set a first password. */
export type MailKind = 'reset' | 'invite';

export interface MailTemplateInput {
  kind: MailKind;
  /** `ar` or anything else (English). The caller picks the recipient's saved language. */
  language: string;
  name: string;
  clientName: string;
  link: string;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

interface Words {
  subject: (clientName: string) => string;
  greeting: (name: string) => string;
  body: string;
  action: string;
  validity: string;
  ignore: string;
}

const COPY: Record<'en' | 'ar', Record<MailKind, Words>> = {
  en: {
    reset: {
      subject: (client) => `Reset your ${client} password`,
      greeting: (name) => `Hello ${name},`,
      body: 'We received a request to reset your password. Use the link below to choose a new one.',
      action: 'Choose a new password',
      validity: 'The link works once and expires in 1 hour.',
      ignore:
        'If you did not ask for this, you can ignore this email. Your password stays the same.',
    },
    invite: {
      subject: (client) => `You have been invited to ${client}`,
      greeting: (name) => `Hello ${name},`,
      body: 'An administrator created an account for you. Use the link below to choose your password and sign in.',
      action: 'Set your password',
      validity: 'The link works once and expires in 7 days.',
      ignore: 'If you did not expect this, you can ignore this email.',
    },
  },
  ar: {
    reset: {
      subject: (client) => `إعادة تعيين كلمة المرور في ${client}`,
      greeting: (name) => `مرحباً ${name}،`,
      body: 'وصلنا طلب لإعادة تعيين كلمة المرور الخاصة بك. استخدم الرابط التالي لاختيار كلمة مرور جديدة.',
      action: 'اختيار كلمة مرور جديدة',
      validity: 'الرابط يعمل مرة واحدة وتنتهي صلاحيته بعد ساعة.',
      ignore: 'إذا لم تطلب ذلك فتجاهل هذه الرسالة، وستبقى كلمة المرور كما هي.',
    },
    invite: {
      subject: (client) => `دعوة للانضمام إلى ${client}`,
      greeting: (name) => `مرحباً ${name}،`,
      body: 'أنشأ لك أحد المسؤولين حساباً. استخدم الرابط التالي لاختيار كلمة المرور وتسجيل الدخول.',
      action: 'تعيين كلمة المرور',
      validity: 'الرابط يعمل مرة واحدة وتنتهي صلاحيته بعد 7 أيام.',
      ignore: 'إذا لم تكن تتوقع ذلك فتجاهل هذه الرسالة.',
    },
  },
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * The email in the recipient's language (spec 0005, AC-11). English and Arabic are written
 * here; any other language the install enables gets English. Arabic is set right to left, and
 * the link is plain text in both so a mail client that strips buttons still shows it.
 */
export function renderMail(input: MailTemplateInput): RenderedMail {
  const lang = input.language === 'ar' ? 'ar' : 'en';
  const words = COPY[lang][input.kind];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const name = input.name.trim() || (lang === 'ar' ? 'زميلنا' : 'there');
  const text = [
    words.greeting(name),
    '',
    words.body,
    '',
    input.link,
    '',
    words.validity,
    words.ignore,
    '',
    input.clientName,
  ].join('\n');
  const html = `<!doctype html>
<html lang="${lang}" dir="${dir}">
<body style="margin:0;padding:24px;font-family:system-ui,Segoe UI,Tahoma,sans-serif;line-height:1.6;color:#1a1a1a;">
<p>${escapeHtml(words.greeting(name))}</p>
<p>${escapeHtml(words.body)}</p>
<p><a href="${escapeHtml(input.link)}" style="display:inline-block;padding:10px 18px;background:#1a1a1a;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(words.action)}</a></p>
<p style="direction:ltr;unicode-bidi:plaintext;word-break:break-all;font-size:13px;color:#555555;">${escapeHtml(input.link)}</p>
<p style="color:#555555;">${escapeHtml(words.validity)}<br>${escapeHtml(words.ignore)}</p>
<p style="color:#555555;">${escapeHtml(input.clientName)}</p>
</body>
</html>`;
  return { subject: words.subject(input.clientName), text, html };
}
