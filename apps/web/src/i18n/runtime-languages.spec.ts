import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRuntimeLanguage, loadRuntimeLanguage } from './runtime-languages';

function serve(body: unknown, status = 200) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      typeof body === 'string'
        ? new Response(body, { status })
        : new Response(JSON.stringify(body), { status }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const meta = { nativeName: ' Français ', intl: 'fr-FR' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// AC-11: a client language file is checked before it is trusted.
describe('fetchRuntimeLanguage', () => {
  it('reads the language details and keeps only keys English has', async () => {
    const fetchMock = serve({
      _meta: meta,
      shell: { skipLink: 'Aller au contenu', invented: 'ignored' },
      'home.title': 'Aperçu',
      extra: 'ignored',
    });

    const language = await fetchRuntimeLanguage('fr');

    expect(fetchMock).toHaveBeenCalledWith('/locales/fr.json', {
      cache: 'no-store',
      signal: undefined,
    });
    expect(language.info).toEqual({ nativeName: 'Français', intl: 'fr-FR', weekStart: 1 });
    expect(language.resources).toEqual({
      'shell.skipLink': 'Aller au contenu',
      'home.title': 'Aperçu',
    });
  });

  it('does not set a clock, so the language follows its Intl tag', async () => {
    serve({ _meta: meta });

    const language = await fetchRuntimeLanguage('fr');

    expect(language.info.hour12).toBeUndefined();
  });

  it.each([
    ['a missing file', 'missing', 404, /answered 404/],
    ['a body that is not an object', '[1]', 200, /not a JSON object/],
    ['no _meta block', '{"home":{}}', 200, /no _meta block/],
    ['an empty native name', '{"_meta":{"nativeName":" ","intl":"fr-FR"}}', 200, /nativeName/],
    ['a missing Intl tag', '{"_meta":{"nativeName":"Français"}}', 200, /intl tag/],
    ['an invalid Intl tag', '{"_meta":{"nativeName":"F","intl":"not a tag"}}', 200, /intl tag/],
  ])('rejects %s', async (_name, body, status, message) => {
    serve(body, status);

    await expect(fetchRuntimeLanguage('fr')).rejects.toThrow(message);
  });

  it('rejects malformed JSON', async () => {
    serve('{ not json');

    await expect(fetchRuntimeLanguage('fr')).rejects.toThrow();
  });

  it('refuses a code that is not 2 to 3 lowercase letters, without fetching', async () => {
    const fetchMock = serve({ _meta: meta });

    await expect(fetchRuntimeLanguage('../etc')).rejects.toThrow(/not a language code/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('loadRuntimeLanguage', () => {
  it('hides a broken language with a console warning instead of throwing', async () => {
    serve('missing', 404);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(loadRuntimeLanguage('fr')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"fr"'));
  });

  it('stays quiet when the load was cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', () => Promise.reject(new DOMException('aborted', 'AbortError')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(loadRuntimeLanguage('fr', controller.signal)).resolves.toBeNull();

    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the language when the file is good', async () => {
    serve({ _meta: meta });

    await expect(loadRuntimeLanguage('fr')).resolves.toMatchObject({ code: 'fr' });
  });
});
