/**
 * The Nest injection token for the mail driver chosen by `MAIL_DRIVER`; null when the install
 * sends no email.
 */
export const MAILER = Symbol('MAILER');
