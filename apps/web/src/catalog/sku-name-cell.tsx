'use client';

import type { SkuSummary } from '@ssdashboard/contracts';
import { useTranslation } from 'react-i18next';
import { useLocalizedText } from '@/i18n/use-localized-text';

/**
 * A SKU's name and, under it, its option values (`M, Black`), so two variants of one style read
 * apart (spec 0012, AC-4). Both come in the active language, falling back as spec 0004 sets.
 */
export function SkuNameCell({ sku }: { sku: SkuSummary }) {
  const { t } = useTranslation();
  const text = useLocalizedText();
  const values = sku.options.map((option) => text(option.value, '')).filter(Boolean);
  return (
    <span className="flex min-w-0 flex-col">
      <span>{text(sku.name, sku.code)}</span>
      {values.length > 0 && (
        <span className="text-xs text-muted-foreground">
          {values.join(t('shell.modules.listSeparator'))}
        </span>
      )}
    </span>
  );
}
