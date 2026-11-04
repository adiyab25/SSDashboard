import { pickKnownKeys } from './catalog';
import { LANGUAGE_CODE } from './language-config';
import type { LanguageInfo } from './languages';

/** A client language loaded from `/locales/<code>.json`: its details and its strings. */
export interface RuntimeLanguage {
  code: string;
  info: LanguageInfo;
  /** Flat dotted keys, only those English has. */
  resources: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntlTag(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

/** Fetches and checks one client language file. Throws with the reason when it is unusable. */
export async function fetchRuntimeLanguage(
  code: string,
  signal?: AbortSignal,
): Promise<RuntimeLanguage> {
  if (!LANGUAGE_CODE.test(code)) throw new Error(`"${code}" is not a language code`);
  const response = await fetch(`/locales/${code}.json`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('not a JSON object');
  const meta = body['_meta'];
  if (!isRecord(meta)) throw new Error('no _meta block');
  const { nativeName, intl } = meta;
  if (typeof nativeName !== 'string' || !nativeName.trim())
    throw new Error('_meta has no nativeName');
  if (typeof intl !== 'string' || !isIntlTag(intl)) throw new Error('_meta has no valid intl tag');
  return {
    code,
    info: { nativeName: nativeName.trim(), intl, weekStart: 1 },
    resources: pickKnownKeys(body),
  };
}

/**
 * Like `fetchRuntimeLanguage`, but a bad or missing file hides the language and warns in
 * the console instead of throwing: it must never break the shell.
 */
export async function loadRuntimeLanguage(
  code: string,
  signal?: AbortSignal,
): Promise<RuntimeLanguage | null> {
  try {
    return await fetchRuntimeLanguage(code, signal);
  } catch (error) {
    if (signal?.aborted) return null;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Language "${code}" is hidden: /locales/${code}.json ${reason}.`);
    return null;
  }
}
