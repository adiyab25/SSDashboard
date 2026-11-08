'use client';

import { MODULE_REGISTRY, type StaffNotice } from '@ssdashboard/contracts';
import type { MessageKey } from '@ssdashboard/i18n';
import { TriangleAlertIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { isolateLtr } from '@/shared/isolate-ltr';

/** The catalog key naming a capability, or undefined for a key the registry does not have. */
function capabilityLabelKey(key: string): MessageKey | undefined {
  for (const definition of MODULE_REGISTRY) {
    const found = definition.capabilities.find((capability) => capability.key === key);
    if (found) return found.label;
  }
  return undefined;
}

/** One staff notice: the day it stops, what stops, and who to ask. No price, no plan terms. */
export function StaffNoticeRow({ notice }: { notice: StaffNotice }) {
  const { t } = useTranslation();
  const format = useFormat();
  const names = notice.capabilities.map((key) => {
    const labelKey = capabilityLabelKey(key);
    return labelKey ? t(labelKey) : isolateLtr(key);
  });
  return (
    <li className="flex items-center gap-x-3 border-s-4 border-s-warning bg-card px-4 py-2 text-sm">
      <TriangleAlertIcon aria-hidden className="size-4 shrink-0 text-warning" />
      <p className="min-w-0 flex-1">
        {t('shell.modules.staffNotice.stops', {
          date: format.dateOnly(notice.stopsOn),
          what: names.join(t('shell.modules.listSeparator')),
        })}
      </p>
    </li>
  );
}
