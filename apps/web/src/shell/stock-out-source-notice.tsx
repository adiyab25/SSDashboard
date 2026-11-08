'use client';

import { Alert, AlertDescription } from '@ssdashboard/ui/components/alert';
import { InfoIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useModuleStates } from './use-module-states';

/**
 * The capability whose state says whether an online sale leaves stock (spec 0009, AC-29): the
 * Shopify stock push, `read_only` with reason `no_stock_out_source` while no source that records
 * an online sale leaving stock is running.
 */
const STOCK_PUSH = 'connectors.shopify.stock_push';

/**
 * The standing notice on the stock pages (spec 0009, AC-29, wave 1 review W9): "Online sales are
 * not deducted from stock on this install yet", shown exactly while `GET /api/platform/modules`
 * says the stock push waits for a stock out source. It draws nothing while the states are not in,
 * when the capability is unknown (no stock push is built yet), or in any other state. It only
 * explains; it changes nothing.
 */
export function StockOutSourceNotice() {
  const { t } = useTranslation();
  const { stateOf } = useModuleStates();
  const view = stateOf(STOCK_PUSH);
  if (view?.state !== 'read_only' || view.reason !== 'no_stock_out_source') return null;

  return (
    <section aria-label={t('shell.modules.stockOutSourceLabel')}>
      <Alert>
        <InfoIcon aria-hidden />
        <AlertDescription>{t('shell.modules.stockOutSource')}</AlertDescription>
      </Alert>
    </section>
  );
}
