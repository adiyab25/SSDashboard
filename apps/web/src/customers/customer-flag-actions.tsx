'use client';

import type { CustomerProfile } from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import { FlagIcon, FlagOffIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomerClearFlagDialog } from './customer-clear-flag-dialog';
import { CustomerFlagDialog } from './customer-flag-dialog';

/**
 * The buttons that flag, change, or clear a customer's flag, and the dialogs they open. Render it
 * only for a holder of `customers.flag`: the api refuses everyone else, and a button that cannot
 * work is left out (spec 0014, AC-11).
 */
export function CustomerFlagActions({ profile }: { profile: CustomerProfile }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<'set' | 'clear' | null>(null);
  const flagged = profile.flag !== null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen('set')}>
        <FlagIcon aria-hidden data-icon="inline-start" />
        {flagged ? t('customers.profile.flagCard.change') : t('customers.profile.flagCard.set')}
      </Button>
      {flagged && (
        <Button size="sm" variant="outline" onClick={() => setOpen('clear')}>
          <FlagOffIcon aria-hidden data-icon="inline-start" />
          {t('customers.profile.flagCard.clear')}
        </Button>
      )}
      {open === 'set' && <CustomerFlagDialog profile={profile} onClose={() => setOpen(null)} />}
      {open === 'clear' && (
        <CustomerClearFlagDialog profile={profile} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
