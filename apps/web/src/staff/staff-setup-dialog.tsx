'use client';

import type { StaffSetup } from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ssdashboard/ui/components/dialog';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Props of `StaffSetupDialog`. */
interface SetupProps {
  /** What the admin sees: a temporary password to hand over, or a note that mail went out. */
  setup: StaffSetup;
  /** Whether this followed a new account or a password reset, for the email wording. */
  reason: 'invite' | 'reset';
  name: string;
  onClose: () => void;
}

/** Shows a temporary password once, or tells the admin an email is on its way (AC-12, AC-18). */
export function StaffSetupDialog({ setup, reason, name, onClose }: SetupProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // The password is on screen and selectable, so a failed copy costs nothing.
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent closeLabel={t('staff.setup.close')}>
        <DialogHeader>
          <DialogTitle>
            {setup.mode === 'temporary_password'
              ? t('staff.setup.temporaryTitle', { name })
              : t('staff.setup.title')}
          </DialogTitle>
          <DialogDescription>
            {setup.mode === 'temporary_password'
              ? t('staff.setup.temporaryBody')
              : reason === 'invite'
                ? t('staff.setup.emailInvite', { name })
                : t('staff.setup.emailReset', { name })}
          </DialogDescription>
        </DialogHeader>
        {setup.mode === 'temporary_password' && (
          <div className="flex flex-col gap-2">
            <span id="temporary-label" className="text-sm font-medium">
              {t('staff.setup.temporaryLabel')}
            </span>
            <div className="flex items-center gap-2">
              <code
                aria-labelledby="temporary-label"
                className="flex-1 rounded-control bg-muted px-3 py-2 font-mono text-base select-all"
              >
                <LtrText>{setup.temporaryPassword}</LtrText>
              </code>
              <Button
                type="button"
                variant="outline"
                onClick={() => void copy(setup.temporaryPassword)}
              >
                {copied ? (
                  <CheckIcon aria-hidden data-icon="inline-start" />
                ) : (
                  <CopyIcon aria-hidden data-icon="inline-start" />
                )}
                {copied ? t('staff.setup.copied') : t('staff.setup.copy')}
              </Button>
            </div>
            <span role="status" className="sr-only">
              {copied ? t('staff.setup.copied') : ''}
            </span>
          </div>
        )}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t('staff.setup.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
