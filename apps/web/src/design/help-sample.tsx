'use client';

import { Button } from '@ssdashboard/ui/components/button';
import { FirstRunChecklist } from '@ssdashboard/ui/help/first-run-checklist';
import { HelpPanel } from '@ssdashboard/ui/help/help-panel';
import { useHelpShortcut } from '@ssdashboard/ui/hooks/use-help-shortcut';
import { CircleQuestionMark } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { SAMPLE_NO_ANSWER_LIMIT } from './confirmation-queue-sample';

/** The sample first run progress: the agent has opened the queue and nothing else yet. */
const DONE = [true, false, false, false] as const;

/**
 * The three layers of in screen help for the confirmation queue (spec 0003, AC-21): a top
 * "Help" button and the `?` key open the page guide (steps, outcome glossary with real chips,
 * the live setting), and the agent's first run checklist can be dismissed and brought back from
 * the guide. The text is all from the `help.confirmationQueue.*` catalog keys; the no answer
 * limit is a sample number standing in for a setting that does not exist yet. The dismissal is
 * component state here, where the real screen stores it per user and hat. It must never hold
 * help text of its own.
 */
export function HelpSample() {
  const { t } = useTranslation();
  const format = useFormat();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useHelpShortcut(() => setOpen(true), !open);

  const limit = format.number(SAMPLE_NO_ANSWER_LIMIT);
  const items = [
    t('help.confirmationQueue.checklist.openQueue'),
    t('help.confirmationQueue.checklist.confirmFirst'),
    t('help.confirmationQueue.checklist.recordNoAnswer'),
    t('help.confirmationQueue.checklist.scheduleCallBack'),
  ].map((label, index) => ({ label, done: DONE[index] ?? false }));
  const doneCount = items.filter((item) => item.done).length;

  return (
    <div className="flex max-w-md flex-col gap-4">
      <div>
        <HelpPanel
          open={open}
          onOpenChange={setOpen}
          title={t('help.confirmationQueue.title')}
          description={t('help.confirmationQueue.description')}
          closeLabel={t('help.common.close')}
          trigger={
            <Button type="button" variant="outline" aria-keyshortcuts="?">
              <CircleQuestionMark aria-hidden="true" />
              {t('help.common.open')}
            </Button>
          }
          steps={{
            heading: t('help.common.stepsHeading'),
            items: [1, 2, 3, 4].map((n) =>
              t(`help.confirmationQueue.steps.${n}` as 'help.confirmationQueue.steps.1'),
            ),
          }}
          glossary={{
            heading: t('help.common.glossaryHeading'),
            items: [
              {
                meaning: 'confirmed',
                chipLabel: t('help.confirmationQueue.glossary.confirmed.chip'),
                description: t('help.confirmationQueue.glossary.confirmed.description'),
              },
              {
                meaning: 'provisional',
                chipLabel: t('help.confirmationQueue.glossary.noAnswer.chip'),
                description: t('help.confirmationQueue.glossary.noAnswer.description', { limit }),
              },
              {
                meaning: 'owed',
                chipLabel: t('help.confirmationQueue.glossary.callBack.chip'),
                description: t('help.confirmationQueue.glossary.callBack.description'),
              },
              {
                meaning: 'failed',
                chipLabel: t('help.confirmationQueue.glossary.cancelled.chip'),
                description: t('help.confirmationQueue.glossary.cancelled.description'),
              },
            ],
          }}
          settings={{
            heading: t('help.common.settingsHeading'),
            items: [{ label: t('help.confirmationQueue.settings.noAnswerLimit'), value: limit }],
          }}
          footer={
            dismissed ? (
              <Button type="button" variant="outline" onClick={() => setDismissed(false)}>
                {t('help.common.checklistShow')}
              </Button>
            ) : null
          }
        />
      </div>
      {dismissed ? null : (
        <FirstRunChecklist
          title={t('help.common.checklistTitle')}
          items={items}
          progressLabel={t('help.common.checklistProgress', {
            done: format.number(doneCount),
            total: format.number(items.length),
          })}
          doneLabel={t('help.common.checklistDone')}
          todoLabel={t('help.common.checklistTodo')}
          dismissLabel={t('help.common.checklistDismiss')}
          onDismiss={() => setDismissed(true)}
        />
      )}
    </div>
  );
}
