'use client';

import type { OwnerPolicyView } from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import { LockIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import {
  choiceLabelKey,
  choiceOf,
  fieldLabelKey,
  OWNER_POLICY_FIELD_ORDER,
} from './owner-policy-choices';
import { useOwnerPolicyLockText } from './use-owner-policy-lock-text';

/** Props of `OwnerPolicyRow`. */
interface OwnerPolicyRowProps {
  policy: OwnerPolicyView;
  /** Opens the edit dialog for this owner type. */
  onEdit: (policy: OwnerPolicyView) => void;
}

/**
 * One location owner type in its settings section (spec 0009, AC-24, AC-25): every answer of its
 * policy, a lock beside each field that cannot change now with the reason under the list (the
 * brand's own type always; another type while locations of it are open, D13), who changed it last
 * and when, and Edit. It never decides what may change: the api refuses with 409 and 422.
 */
export function OwnerPolicyRow({ policy, onEdit }: OwnerPolicyRowProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const lockText = useOwnerPolicyLockText();
  const name = t(`settings.ownerPolicies.types.${policy.ownerType}`);
  const locked = new Set<string>(policy.lockedFields);
  const why = lockText(policy);
  const when = format.dateTime(policy.updatedAt);
  const who = policy.updatedBy ? (policy.updatedBy.name ?? t('settings.row.unknownPerson')) : null;

  return (
    <li className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="font-medium">{name}</h3>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,auto)_1fr]">
          {OWNER_POLICY_FIELD_ORDER.map((field) => (
            <div key={field} className="contents">
              <dt className="text-muted-foreground">{t(fieldLabelKey(field))}</dt>
              <dd className="flex min-w-0 items-center gap-1.5 font-medium">
                {t(choiceLabelKey(field, choiceOf(policy, field)))}
                {locked.has(field) && (
                  <>
                    <LockIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="sr-only">{t('settings.ownerPolicies.locked')}</span>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
        {why && (
          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <LockIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            {why}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {who !== null
            ? t('settings.row.lastChanged', { name: who, date: when })
            : t('settings.row.lastChangedUnknown', { date: when })}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        aria-label={t('settings.ownerPolicies.editNamed', { name })}
        onClick={() => onEdit(policy)}
      >
        {t('settings.ownerPolicies.edit')}
      </Button>
    </li>
  );
}
