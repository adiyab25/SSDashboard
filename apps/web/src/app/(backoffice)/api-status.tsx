'use client';

import { HealthResponse } from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; health: HealthResponse }
  | { kind: 'error'; message: string };

/** Calls the api through the relative `/api` path, the same way every install does. */
export function ApiStatus() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`api answered ${response.status}`);
        setState({ kind: 'ready', health: HealthResponse.parse(await response.json()) });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <div className="mt-6 flex flex-col items-start gap-4">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1" aria-live="polite">
        <dt className="font-medium">{t('home.status.api')}</dt>
        <dd>
          {state.kind === 'loading'
            ? t('home.status.checking')
            : state.kind === 'error'
              ? `${t('home.status.unreachable')} (${state.message})`
              : t(`home.status.${state.health.status}`)}
        </dd>
        {state.kind === 'ready' && (
          <>
            <dt className="font-medium">{t('home.status.database')}</dt>
            <dd>{t(`home.status.${state.health.database}`)}</dd>
            <dt className="font-medium">{t('home.status.version')}</dt>
            <dd className="tabular-nums">
              {/* Isolated so "0.0.0-dev" keeps its order in right to left. */}
              <LtrText>{state.health.version}</LtrText>
            </dd>
          </>
        )}
      </dl>
      <Button
        variant="outline"
        disabled={state.kind === 'loading'}
        onClick={() => {
          setState({ kind: 'loading' });
          setAttempt((count) => count + 1);
        }}
      >
        {t('home.status.checkAgain')}
      </Button>
    </div>
  );
}
