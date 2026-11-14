'use client';

import { Button } from '@ssdashboard/ui/components/button';
import { Loader2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const VARIANTS = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const;
const STATES = ['default', 'hover', 'focus', 'active', 'disabled', 'loading'] as const;

/** Every button variant in every state, for checking the focus ring and disabled look. */
export function ButtonMatrix() {
  const { t } = useTranslation();
  return (
    // The table scrolls inside itself on a phone, so it is a named, focusable region (WCAG 2.1.1).
    <div
      role="region"
      aria-label={t('design.buttons.caption')}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="overflow-x-auto outline-none focus-ring-inset"
    >
      <table className="w-full border-collapse text-start">
        <caption className="sr-only">{t('design.buttons.caption')}</caption>
        <thead>
          <tr className="h-row-header border-b">
            <th scope="col" className="pe-4 text-start font-medium">
              {t('design.buttons.variant')}
            </th>
            {STATES.map((state) => (
              <th key={state} scope="col" className="px-2 text-start font-medium">
                {t(`design.buttons.states.${state}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {VARIANTS.map((variant) => (
            <tr key={variant} className="border-b">
              <th scope="row" className="pe-4 text-start font-normal">
                {t(`design.buttons.variants.${variant}`)}
              </th>
              {STATES.map((state) => (
                <td key={state} className="p-2">
                  <Button
                    variant={variant}
                    tabIndex={-1}
                    data-state-preview={
                      ['hover', 'focus', 'active'].includes(state) ? state : undefined
                    }
                    disabled={state === 'disabled' || state === 'loading'}
                  >
                    {state === 'loading' && (
                      <Loader2Icon aria-hidden className="animate-spin" data-icon="inline-start" />
                    )}
                    {t('design.buttons.save')}
                  </Button>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
