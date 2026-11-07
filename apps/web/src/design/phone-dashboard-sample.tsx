'use client';

import { BottomTabs } from '@ssdashboard/ui/dashboard/bottom-tabs';
import { BottomTabsSpacer } from '@ssdashboard/ui/dashboard/bottom-tabs-spacer';
import { MetricCard } from '@ssdashboard/ui/dashboard/metric-card';
import { NeedsYouList } from '@ssdashboard/ui/dashboard/needs-you-list';
import { FreshnessStrip } from '@ssdashboard/ui/status/freshness-strip';
import { ProvisionalValue } from '@ssdashboard/ui/status/provisional-value';
import type { StatusMeaning } from '@ssdashboard/ui/lib/status-meaning';
import { Banknote, ClipboardList, Ellipsis, House } from 'lucide-react';
import { useLanguage } from '@/i18n/language-provider';
import { useFormat } from '@/i18n/use-format';
import { CollapsingOrdersSample } from './collapsing-orders-sample';
import { PHONE_DASHBOARD_COPY } from './phone-dashboard-copy';

const ROW_MEANINGS: StatusMeaning[] = ['failed', 'provisional', 'owed', 'owed', 'provisional'];

/**
 * The owner's phone first dashboard with sample numbers (spec 0003, AC-20), in the spec's order:
 * header, freshness strip, cash owed split by Bosta and partners, confirmed yesterday and failed
 * delivery rate side by side, the dashed "Today so far", "Needs you", and the bottom tabs. The
 * numbers are made up and the links go to `#`; the real screen reads them from the api. Money and
 * percent go through `useFormat()`. It must never call the api.
 */
export function PhoneDashboardSample() {
  const { language } = useLanguage();
  const format = useFormat();
  const copy = PHONE_DASHBOARD_COPY[language === 'ar' ? 'ar' : 'en'];
  const chipWords = [
    copy.chips.failed,
    copy.chips.provisional,
    copy.chips.owed,
    copy.chips.owed,
    copy.chips.provisional,
  ];

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold">{copy.title}</h1>
          <span className="text-sm text-muted-foreground">
            {copy.brand} · {format.dateOnly('2026-11-05')}
          </span>
        </div>
        <FreshnessStrip text={copy.fresh} />
      </header>

      <MetricCard
        size="lg"
        emphasis="owed"
        href="#cash"
        label={copy.owed}
        detail={copy.owedDetail}
        value={format.money('412500.00', 2)}
        split={[
          { label: copy.bosta, value: format.money('318200.00', 2) },
          { label: copy.partners, value: format.money('94300.00', 2) },
        ]}
      />
      <div className="grid grid-cols-2 gap-3">
        <MetricCard href="#orders" label={copy.confirmedYesterday} value={format.quantity(86)} />
        <MetricCard href="#failed" label={copy.failedRate} value={format.percent(8.2)} />
      </div>
      <MetricCard
        provisional
        href="#today"
        label={copy.today}
        detail={copy.todayDetail}
        value={<ProvisionalValue value={format.quantity(41)} provisionalLabel={copy.provisional} />}
      />

      <section aria-labelledby="needs-you" className="flex flex-col gap-2">
        <h2 id="needs-you" className="text-base font-semibold">
          {copy.needsYou}
        </h2>
        <NeedsYouList
          label={copy.needsYou}
          total={8}
          moreHref="#needs-you-all"
          moreLabel={copy.more}
          items={copy.rows.map((label, index) => ({
            id: `row-${index}`,
            href: `#row-${index}`,
            label,
            meaning: ROW_MEANINGS[index] ?? 'owed',
            chipLabel: chipWords[index] ?? copy.chips.owed,
          }))}
        />
      </section>

      <section aria-labelledby="latest-orders" className="flex flex-col gap-2">
        <h2 id="latest-orders" className="text-base font-semibold">
          {copy.tableCaption}
        </h2>
        <CollapsingOrdersSample copy={copy} />
      </section>

      <BottomTabsSpacer className="md:hidden" />
      <BottomTabs
        className="md:hidden"
        label={copy.tabsLabel}
        tabs={[
          { label: copy.tabs.today, href: '#today', icon: <House />, current: true },
          { label: copy.tabs.orders, href: '#orders', icon: <ClipboardList /> },
          { label: copy.tabs.cash, href: '#cash', icon: <Banknote /> },
          { label: copy.tabs.more, href: '#more', icon: <Ellipsis /> },
        ]}
      />
    </div>
  );
}
