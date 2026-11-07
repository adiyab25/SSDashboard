'use client';

import { Button } from '@ssdashboard/ui/components/button';
import { Kbd } from '@ssdashboard/ui/components/kbd';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { HelpHint } from '@ssdashboard/ui/help/help-hint';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';

/**
 * Stands in for the "no answers before the order closes" setting, which does not exist yet. The
 * real screen reads it from settings and passes it the same way.
 */
export const SAMPLE_NO_ANSWER_LIMIT = 3;

const OUTCOMES = [
  { key: '1', label: 'Confirmed', primary: true },
  { key: '2', label: 'No answer', primary: false },
  { key: '3', label: 'Call back', primary: false },
  { key: '4', label: 'Cancelled', primary: false },
] as const;

/**
 * One confirmation queue card: one order at a time with one button per outcome and its shortcut
 * key visible. It sits in the `floor` density scope, so on a touch screen the buttons are 48px
 * tall. Pressing 1 to 4 inside the card records the outcome, as a sample only.
 */
export function ConfirmationQueueSample() {
  const [recorded, setRecorded] = useState<string | null>(null);
  const { t } = useTranslation();
  const limit = useFormat().number(SAMPLE_NO_ANSWER_LIMIT);

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- keys bubble up from the focusable outcome buttons.
    <div
      data-density="floor"
      data-testid="confirmation-queue-card"
      role="region"
      aria-label="Confirmation queue, sample order"
      onKeyDown={(event) => {
        const outcome = OUTCOMES.find((item) => item.key === event.key);
        if (outcome && !event.ctrlKey && !event.metaKey && !event.altKey) {
          setRecorded(outcome.label);
        }
      }}
      className="flex max-w-md flex-col gap-3 rounded-lg border bg-card p-4 text-card-foreground"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">Mona Abdelrahman</span>
        <span className="text-xs text-muted-foreground tabular-nums">3 of 12</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 text-sm">
        <LtrText className="font-mono">SS-48190</LtrText>
        <LtrText className="font-mono">01012345678</LtrText>
        <HelpHint label={t('help.confirmationQueue.hint.phone.label')}>
          <p className="text-sm">{t('help.confirmationQueue.hint.phone.body')}</p>
        </HelpHint>
      </div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span>Linen shirt, M, Sand × 1</span>
        <span className="font-medium tabular-nums">790 EGP</span>
      </div>
      <p className="text-xs text-muted-foreground">Cairo › Nasr City › 7th district</p>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{OUTCOMES[1].label}</span>
        <HelpHint label={t('help.confirmationQueue.hint.noAnswer.label')}>
          <p className="text-sm">{t('help.confirmationQueue.hint.noAnswer.body', { limit })}</p>
        </HelpHint>
      </div>
      <div role="group" aria-label="Outcome" className="grid grid-cols-2 gap-2">
        {OUTCOMES.map((outcome) => (
          <Button
            key={outcome.key}
            type="button"
            variant={outcome.primary ? 'default' : 'outline'}
            data-outcome={outcome.key}
            aria-keyshortcuts={outcome.key}
            onClick={() => setRecorded(outcome.label)}
          >
            {outcome.label}
            <Kbd>{outcome.key}</Kbd>
          </Button>
        ))}
      </div>
      <p role="status" className="min-h-4 text-xs text-muted-foreground">
        {recorded ? `Recorded: ${recorded} (sample only)` : ''}
      </p>
    </div>
  );
}
