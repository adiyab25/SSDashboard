'use client';

import { settingDefinitionOf } from '@ssdashboard/contracts';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useTranslation } from 'react-i18next';

/**
 * The executing steps that resume after a renewal out of the wind down or off (spec 0009, AC-19),
 * named by their setting label, with the plain words that they act only on new events. With
 * `waiting` it words the steps of the license section instead (switched on, stopped by a lapse,
 * waiting for a renewal) and leaves out the note, which would be false for a stopped step. Draws
 * nothing for an empty list. A key the build does not know shows as the key, left to right.
 */
export function LicenseResumingSteps({
  steps,
  waiting = false,
}: {
  steps: readonly string[];
  /** True in the license section (steps waiting for a renewal); false on the upload answer. */
  waiting?: boolean;
}) {
  const { t } = useTranslation();
  if (steps.length === 0) return null;
  return (
    <div className="grid gap-2 text-sm">
      <p>
        {t(waiting ? 'settings.license.waitingIntro' : 'settings.license.upload.resumingIntro')}
      </p>
      <ul className="list-disc ps-5">
        {steps.map((key) => {
          const definition = settingDefinitionOf(key);
          return <li key={key}>{definition ? t(definition.label) : <LtrText>{key}</LtrText>}</li>;
        })}
      </ul>
      {!waiting && (
        <p className="text-muted-foreground">{t('settings.license.upload.resumingNote')}</p>
      )}
    </div>
  );
}
