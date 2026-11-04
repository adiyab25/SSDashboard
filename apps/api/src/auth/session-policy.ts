/** Session lifetime (spec 0005, AC-5): 12 hours idle, renewed at most hourly, 7 days in total. */
export const SESSION_IDLE_SECONDS = 12 * 60 * 60;
export const SESSION_RENEW_SECONDS = 60 * 60;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

/** True once a session is 7 days old, however recently it was used. An unreadable date fails closed. */
export function pastAbsoluteCap(createdAt: Date | string, now: Date = new Date()): boolean {
  const created = new Date(createdAt).getTime();
  return Number.isNaN(created) || created + SESSION_ABSOLUTE_MS <= now.getTime();
}
