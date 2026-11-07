import type { SettingEntryView, SettingJson } from '@ssdashboard/contracts';
import { parseQuantity } from '@ssdashboard/i18n';

/** The kind of input and display a setting's value needs, read from its default's shape. */
export type SettingValueKind = 'boolean' | 'hour' | 'number' | 'date' | 'text' | 'list' | 'record';

/** The setting the screen shows as an hour of the day. */
const HOUR_KEY = 'operating_day_cutoff_hour';

/**
 * Which input and display an entry needs. The registry holds the type in its schema, which the
 * api's view does not carry, so the shape of the default says it: a boolean, a number, a list of
 * codes, a record (document prefixes), a calendar date (a null default), or text.
 */
export function valueKindOf(entry: Pick<SettingEntryView, 'key' | 'default'>): SettingValueKind {
  const sample = entry.default;
  if (typeof sample === 'boolean') return 'boolean';
  if (typeof sample === 'number') return entry.key === HOUR_KEY ? 'hour' : 'number';
  if (Array.isArray(sample)) return 'list';
  if (sample === null) return 'date';
  if (typeof sample === 'object') return 'record';
  return 'text';
}

/**
 * Whether a value of this kind is a code that must read left to right inside Arabic text (a time
 * zone, a language code, a prefix). The row and the dialog both wrap such a value in `LtrText`.
 */
export function isCodeKind(kind: SettingValueKind): boolean {
  return kind === 'text' || kind === 'list' || kind === 'record';
}

/** The words a value is written with, from the catalog and the formatters in the active language. */
export interface SettingWords {
  yes: string;
  no: string;
  notSet: string;
  /** The hour of the day as a clock time, from a two digit hour. */
  hour: (hour: string) => string;
  /** A whole number in the person's digits (`useFormat().quantity`). */
  number: (value: number) => string;
  /** A calendar date (`YYYY-MM-DD`) in the person's language (`useFormat().dateOnly`). */
  date: (value: string) => string;
}

/** A value as plain text: strings as they are, other shapes as JSON. */
function plain(value: SettingJson): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The text a value shows as, in the person's language; codes stay as stored. */
export function displayValue(
  value: SettingJson,
  kind: SettingValueKind,
  words: SettingWords,
): string {
  if (value === null) return words.notSet;
  if (typeof value === 'boolean') return value ? words.yes : words.no;
  if (typeof value === 'number') {
    return kind === 'hour' ? words.hour(String(value).padStart(2, '0')) : words.number(value);
  }
  if (Array.isArray(value)) return value.map(plain).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([name, prefix]) => `${name}: ${plain(prefix)}`)
      .join(', ');
  }
  return kind === 'date' ? words.date(value) : value;
}

/** A draft the dialog edits: always strings, turned into the stored shape by `parseDraft`. */
export type SettingDraft = string | boolean | Record<string, string>;

/** The draft a dialog starts from: the value in force, as strings. */
export function draftOf(value: SettingJson, kind: SettingValueKind): SettingDraft {
  if (kind === 'boolean') return value === true;
  if (kind === 'record' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  if (kind === 'list' && Array.isArray(value)) return value.map(plain).join(', ');
  return value === null ? '' : plain(value);
}

/**
 * Turns a draft into the value to send, or `{ ok: false }` when the draft is empty (or not a
 * whole number) where a value is needed; a cleared date is sent as `null`. A number may be typed
 * in Western or Arabic digits (spec 0004, AC-18). It does not judge the value: the api checks it
 * against the entry's own schema and answers `SETTING_INVALID`.
 */
export function parseDraft(
  draft: SettingDraft,
  kind: SettingValueKind,
): { ok: true; value: SettingJson } | { ok: false } {
  if (kind === 'boolean') return { ok: true, value: draft === true };
  if (kind === 'record') return { ok: true, value: typeof draft === 'object' ? draft : {} };
  const text = typeof draft === 'string' ? draft.trim() : '';
  if (kind === 'date') return { ok: true, value: text === '' ? null : text };
  if (text === '') return { ok: false };
  if (kind === 'number' || kind === 'hour') {
    try {
      return { ok: true, value: parseQuantity(text) };
    } catch {
      return { ok: false };
    }
  }
  if (kind === 'list') {
    return { ok: true, value: text.split(/[\s,،]+/).filter((code) => code !== '') };
  }
  return { ok: true, value: text };
}

/** Arabic vowel marks (U+064B to U+065F), the dagger alef (U+0670), and the tatweel (U+0640); not the digits U+0660 to U+066F. */
const MARKS = new RegExp('[\u064b-\u065f\u0670\u0640]', 'g');

/** Folds the spellings of a name a person may type differently: NFC, no marks, one alef, ة as ه, ى as ي. */
function foldName(text: string): string {
  return text
    .normalize('NFC')
    .replace(MARKS, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Whether the typed confirmation names the setting. Arabic has several spellings of one word
 * (alef with or without a hamza, marks, a stretched letter), so both sides are folded first; a
 * typo that changes a letter is still refused.
 */
export function namesSetting(typed: string, name: string): boolean {
  return foldName(typed) === foldName(name);
}
