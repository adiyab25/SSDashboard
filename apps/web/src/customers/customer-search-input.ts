/** What a person typed into the customer search: a phone in any form, or a piece of a name. */
export type CustomerSearchInput =
  | { kind: 'phone'; text: string }
  | { kind: 'name'; text: string }
  | { kind: 'name-too-short' }
  | { kind: 'name-too-long' }
  | { kind: 'empty' };

const PHONE_SHAPE = /^[+\d\s().\-\u0660-\u0669\u06F0-\u06F9]+$/u;
const HAS_DIGIT = /[\d\u0660-\u0669\u06F0-\u06F9]/u;

/** The shortest and longest name fragment the api accepts (`CustomerSearchRequest`). */
const NAME_MIN = 3;
const NAME_MAX = 100;

/**
 * Decides whether typed text is a phone (digits, spaces, `+`, dashes, brackets, in Western or
 * Arabic-Indic digits) or a name fragment, and checks the name length the api enforces. It never
 * parses the phone: the api does, so one number is one customer however it was typed.
 */
export function classifyCustomerSearch(typed: string): CustomerSearchInput {
  const text = typed.trim();
  if (text === '') return { kind: 'empty' };
  if (PHONE_SHAPE.test(text) && HAS_DIGIT.test(text)) return { kind: 'phone', text };
  if (text.length < NAME_MIN) return { kind: 'name-too-short' };
  if (text.length > NAME_MAX) return { kind: 'name-too-long' };
  return { kind: 'name', text };
}
