import { act, screen } from '@testing-library/react';
import { Direction } from 'radix-ui';
import { vi } from 'vitest';
import { resetConfigForTests } from '@/shell/client-config';
import { useLanguage } from './language-provider';

/** The `/api/config` answer a test stubs. */
export interface FakeConfig {
  languages?: string[];
  defaultLanguage?: string;
}

/** Answers `/api/config` and `/locales/<code>.json` from these tables; anything else is 404. */
export function stubNetwork(options: {
  config?: FakeConfig | 'fail';
  locales?: Record<string, unknown>;
}) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      calls.push(input);
      if (input === '/api/config') {
        if (options.config === 'fail' || options.config === undefined) {
          return Promise.resolve(new Response('error', { status: 500 }));
        }
        return Promise.resolve(
          Response.json({
            clientName: 'Acme',
            version: '1.0.0',
            currency: 'EGP',
            timezone: 'Africa/Cairo',
            languages: ['en', 'ar'],
            defaultLanguage: 'en',
            ...options.config,
          }),
        );
      }
      const code = /^\/locales\/([a-z]+)\.json$/.exec(input)?.[1];
      const file = code ? options.locales?.[code] : undefined;
      return Promise.resolve(file ? Response.json(file) : new Response('missing', { status: 404 }));
    }),
  );
  return calls;
}

/** Accessible names of the probe's outputs; tests read them with `readout()`. */
const READOUTS = {
  language: 'language',
  direction: 'direction',
  radix: 'radix',
  options: 'options',
  failed: 'failed',
} as const;

/** Shows what the provider decided, and lets a test choose a language. */
export function LanguageProbe({ choices = ['en', 'ar'] }: { choices?: string[] }) {
  const { language, direction, options, failedLanguage, setLanguage } = useLanguage();
  const radix = Direction.useDirection();
  return (
    <>
      <output aria-label={READOUTS.language}>{language}</output>
      <output aria-label={READOUTS.direction}>{direction}</output>
      <output aria-label={READOUTS.radix}>{radix}</output>
      <output aria-label={READOUTS.options}>
        {options.map((option) => option.code).join(',')}
      </output>
      <output aria-label={READOUTS.failed}>{failedLanguage?.code ?? ''}</output>
      {choices.map((code) => (
        <button key={code} onClick={() => void setLanguage(code)}>
          {`choose ${code}`}
        </button>
      ))}
    </>
  );
}

/** The text of the output with this accessible name. */
export const readout = (name: string) => screen.getByLabelText(name).textContent;

/** Lets pending promises settle inside act(). */
export async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Clears the saved language, the document attributes and the stubbed network between tests. */
export function resetLanguageState() {
  document.cookie = 'ss_lang=; Path=/; Max-Age=0';
  const html = document.documentElement;
  html.lang = '';
  html.dir = '';
  html.removeAttribute('data-i18n');
  resetConfigForTests();
  vi.unstubAllGlobals();
}
