'use client';

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  unmetPasswordRules,
  type PasswordRule,
} from '@ssdashboard/contracts';
import { CheckIcon, CircleIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const RULES: readonly PasswordRule[] = ['min_length', 'lowercase', 'uppercase', 'digit'];

/**
 * The password rules, shown before the person submits and ticked off as they type (spec 0005,
 * AC-8). Met and unmet differ by icon and by hidden text, not by colour alone. The longest
 * length only appears once it is broken, since nobody types 128 characters by accident.
 */
export function PasswordRules({ password, id }: { password: string; id: string }) {
  const { t } = useTranslation();
  const unmet = unmetPasswordRules(password);
  const shown = unmet.includes('max_length') ? [...RULES, 'max_length' as const] : RULES;

  return (
    <div id={id} className="flex flex-col gap-1.5 text-sm">
      <p id={`${id}-title`} className="font-medium">
        {t('auth.reset.rulesTitle')}
      </p>
      <ul aria-labelledby={`${id}-title`} className="flex flex-col gap-1">
        {shown.map((rule) => {
          const met = !unmet.includes(rule);
          return (
            <li
              key={rule}
              className={`flex items-center gap-2 ${met ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              {met ? (
                <CheckIcon aria-hidden className="size-4 shrink-0" />
              ) : (
                <CircleIcon aria-hidden className="size-4 shrink-0" />
              )}
              <span>
                {t(`auth.reset.rules.${rule}`, {
                  min: PASSWORD_MIN_LENGTH,
                  max: PASSWORD_MAX_LENGTH,
                })}
              </span>
              <span className="sr-only">
                {met ? t('auth.reset.ruleMet') : t('auth.reset.ruleUnmet')}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
