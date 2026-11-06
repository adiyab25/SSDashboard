import { randomInt } from 'node:crypto';

// No look alike characters (0/O, 1/l/I), since a person types this once from a screen.
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';

const pick = (alphabet: string): string => alphabet.charAt(randomInt(alphabet.length));

/**
 * A server side random password that meets the password rule (spec 0005, AC-8): 16 characters
 * with a lowercase letter, an uppercase letter, and a digit. Shown once, only its hash is kept.
 */
export function generateTemporaryPassword(length = 16): string {
  const all = LOWER + UPPER + DIGITS;
  const chars = [pick(LOWER), pick(UPPER), pick(DIGITS)];
  while (chars.length < length) chars.push(pick(all));
  // Fisher-Yates, so the three required characters do not always sit at the front.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}
