import { ConfigResponse } from '@ssdashboard/contracts';

let config: Promise<ConfigResponse | null> | undefined;

/**
 * `GET /api/config`, fetched once per browser session. Resolves to null when the call
 * fails, so callers show their fallback and the shell keeps working. A failure is not
 * cached: the next caller asks the api again.
 */
export function loadConfig(): Promise<ConfigResponse | null> {
  config ??= fetch('/api/config', { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`api answered ${response.status}`);
      return ConfigResponse.parse(await response.json());
    })
    .catch(() => {
      config = undefined;
      return null;
    });
  return config;
}

/** Forgets the cached answer, so a test starts from a fresh load. */
export function resetConfigForTests(): void {
  config = undefined;
}
