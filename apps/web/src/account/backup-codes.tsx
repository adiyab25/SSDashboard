'use client';

import { Button } from '@ssdashboard/ui/components/button';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** The 10 backup codes, shown once, with a button that copies them. */
export function BackupCodes({ codes }: { codes: readonly string[] }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      // The codes are on screen and selectable, so a failed copy costs nothing.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <ul
        aria-label={t('account.twoFactor.codes.label')}
        className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted px-3 py-2 font-mono text-sm select-all"
      >
        {codes.map((code) => (
          <li key={code}>
            <LtrText>{code}</LtrText>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" onClick={() => void copy()}>
          {copied ? (
            <CheckIcon aria-hidden data-icon="inline-start" />
          ) : (
            <CopyIcon aria-hidden data-icon="inline-start" />
          )}
          {copied ? t('account.twoFactor.codes.copied') : t('account.twoFactor.codes.copy')}
        </Button>
        <span role="status" className="sr-only">
          {copied ? t('account.twoFactor.codes.copied') : ''}
        </span>
      </div>
    </div>
  );
}
