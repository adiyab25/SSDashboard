'use client';

import type { ConfigResponse } from '@ssdashboard/contracts';
import {
  CORE_LANGUAGES,
  createI18n,
  directionOf,
  isCoreLanguage,
  type Catalog,
  type LanguageInfo,
  type TextDirection,
} from '@ssdashboard/i18n';
import type { i18n as I18n } from 'i18next';
import { Direction } from 'radix-ui';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { I18nextProvider } from 'react-i18next';
import { loadConfig } from '@/shell/client-config';
import { readLanguageCookie, writeLanguageCookie } from './language-cookie';
import { loadRuntimeLanguage, type RuntimeLanguage } from './runtime-languages';

/** One entry of the Language submenu. */
export interface LanguageOption {
  code: string;
  nativeName: string;
  dir: TextDirection;
}

/** Where the `/api/config` load stands. */
export type ConfigStatus = 'loading' | 'ready' | 'error';

interface LanguageState {
  /** The active language code. English, left to right, until the saved one is applied. */
  language: string;
  direction: TextDirection;
  /** The active language's Intl tag and clock, for the formatters. */
  info: LanguageInfo;
  /** Enabled languages whose catalog is usable, in the `languages` setting's order. */
  options: LanguageOption[];
  config: ConfigResponse | null;
  configStatus: ConfigStatus;
  /** The language whose catalog failed to load on the last choice, else null. */
  failedLanguage: LanguageOption | null;
  /** Resolves true when this choice became the active language, false if it failed or was replaced. */
  setLanguage: (code: string) => Promise<boolean>;
  clearFailure: () => void;
}

/** Outside a provider (an isolated component test): English, left to right, nothing loaded. */
const LanguageContext = createContext<LanguageState>({
  language: 'en',
  direction: 'ltr',
  info: CORE_LANGUAGES.en,
  options: [],
  config: null,
  configStatus: 'loading',
  failedLanguage: null,
  setLanguage: () => Promise.resolve(false),
  clearFailure: () => {},
});

/** A chunk that neither loads nor fails (a stalled connection) counts as failed after this. */
const CATALOG_TIMEOUT_MS = 6000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out loading the language')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Core languages other than English load as a lazy chunk. */
const coreLoaders: Record<string, () => Promise<Catalog>> = {
  ar: () => import('@ssdashboard/i18n/ar').then((module) => module.ar),
};

/**
 * Owns the active language: loads catalogs, keeps `<html lang dir>`, Radix's direction
 * (which every portal reads), and the `ss_lang` cookie in step. The first render is always
 * English left to right, matching the prerendered HTML; the saved language is applied in
 * an effect after hydration, behind the body the head script hid.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [i18n] = useState<I18n>(createI18n);
  const [language, setActive] = useState('en');
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configStatus, setConfigStatus] = useState<ConfigStatus>('loading');
  const [runtime, setRuntime] = useState<Record<string, RuntimeLanguage>>({});
  const [failedCode, setFailedCode] = useState<string | null>(null);
  // Only the latest choice may apply; a slower, older load is dropped.
  const latest = useRef(0);
  const runtimeLoads = useRef(new Map<string, Promise<RuntimeLanguage | null>>());

  const infoOf = useCallback(
    (code: string): LanguageInfo =>
      isCoreLanguage(code) ? CORE_LANGUAGES[code] : (runtime[code]?.info ?? CORE_LANGUAGES.en),
    [runtime],
  );

  /** Starts (once) loading a client language file; resolves to null when it is unusable. */
  const loadRuntime = useCallback((code: string) => {
    let load = runtimeLoads.current.get(code);
    if (!load) {
      load = loadRuntimeLanguage(code).then((loaded) => {
        if (loaded) setRuntime((all) => ({ ...all, [code]: loaded }));
        return loaded;
      });
      runtimeLoads.current.set(code, load);
    }
    return load;
  }, []);

  /** Makes sure the language's strings are in i18next. Throws when they cannot be loaded. */
  const ensureCatalog = useCallback(
    async (code: string) => {
      if (code === 'en' || i18n.hasResourceBundle(code, 'translation')) return;
      if (isCoreLanguage(code)) {
        const load = coreLoaders[code];
        if (!load) throw new Error(`No catalog for ${code}`);
        i18n.addResourceBundle(
          code,
          'translation',
          await withTimeout(load(), CATALOG_TIMEOUT_MS),
          true,
          true,
        );
        return;
      }
      const loaded = await loadRuntime(code);
      if (!loaded) throw new Error(`Language ${code} is unavailable`);
      i18n.addResourceBundle(code, 'translation', loaded.resources, true, true);
    },
    [i18n, loadRuntime],
  );

  /** Switches everything that shows the language, then optionally remembers it. */
  const apply = useCallback(
    async (code: string, remember: boolean) => {
      await i18n.changeLanguage(code);
      const html = document.documentElement;
      html.lang = code;
      html.dir = directionOf(code);
      html.removeAttribute('data-i18n');
      setActive(code);
      setFailedCode(null);
      if (remember) writeLanguageCookie(code);
    },
    [i18n],
  );

  // After hydration: pick the language, behind the body the head script hid.
  useEffect(() => {
    const token = ++latest.current;
    const saved = readLanguageCookie();

    async function resolve() {
      const loaded = await loadConfig();
      if (token !== latest.current) return;
      setConfig(loaded);
      setConfigStatus(loaded ? 'ready' : 'error');

      let candidates: string[];
      if (loaded) {
        for (const code of loaded.languages) if (!isCoreLanguage(code)) void loadRuntime(code);
        const first = saved && loaded.languages.includes(saved) ? saved : loaded.defaultLanguage;
        // The default failing to load falls through to the other enabled languages.
        candidates = [first, ...loaded.languages];
      } else {
        // No config: keep the saved language if it loads, else English.
        candidates = saved ? [saved] : [];
      }

      for (const code of new Set(candidates)) {
        try {
          await ensureCatalog(code);
        } catch {
          continue;
        }
        if (token !== latest.current) return;
        // The cookie is rewritten only when config answered and the language changed.
        await apply(code, loaded !== null && code !== saved);
        return;
      }
      if (token === latest.current) await apply('en', false);
    }

    void resolve()
      .catch(() => apply('en', false))
      .finally(() => {
        if (token === latest.current) document.documentElement.removeAttribute('data-i18n');
      });
  }, [apply, ensureCatalog, loadRuntime]);

  const options = useMemo<LanguageOption[]>(() => {
    const enabled = config ? config.languages : Object.keys(CORE_LANGUAGES);
    return enabled.flatMap((code) => {
      const info = isCoreLanguage(code) ? CORE_LANGUAGES[code] : runtime[code]?.info;
      return info ? [{ code, nativeName: info.nativeName, dir: directionOf(code) }] : [];
    });
  }, [config, runtime]);

  const setLanguage = useCallback(
    async (code: string) => {
      const token = ++latest.current;
      setFailedCode(null);
      try {
        await ensureCatalog(code);
      } catch {
        // The current language stays, the cookie is untouched, and the menu says so.
        if (token === latest.current) setFailedCode(code);
        return false;
      }
      if (token !== latest.current) return false;
      await apply(code, true);
      return token === latest.current;
    },
    [apply, ensureCatalog],
  );

  const clearFailure = useCallback(() => setFailedCode(null), []);

  const direction = directionOf(language);
  const info = infoOf(language);
  const failedLanguage = options.find((option) => option.code === failedCode) ?? null;

  const value = useMemo<LanguageState>(
    () => ({
      language,
      direction,
      info,
      options,
      config,
      configStatus,
      failedLanguage,
      setLanguage,
      clearFailure,
    }),
    [
      language,
      direction,
      info,
      options,
      config,
      configStatus,
      failedLanguage,
      setLanguage,
      clearFailure,
    ],
  );

  return (
    <I18nextProvider i18n={i18n}>
      <LanguageContext value={value}>
        <Direction.Provider dir={direction}>{children}</Direction.Provider>
      </LanguageContext>
    </I18nextProvider>
  );
}

/**
 * The active language, its direction, the choices, and the setter. Must sit inside
 * `LanguageProvider`.
 */
export function useLanguage(): LanguageState {
  return use(LanguageContext);
}
