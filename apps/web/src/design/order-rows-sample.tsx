'use client';

import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';
import { FreshnessStrip } from '@ssdashboard/ui/status/freshness-strip';
import { ProvisionalValue } from '@ssdashboard/ui/status/provisional-value';
import { StatusChip } from '@ssdashboard/ui/status/status-chip';

import { OverflowStatusesSample } from './overflow-statuses-sample';

type OrderRowsSampleProps = {
  /** Reading direction of this copy, to check the table mirrors. */
  dir: 'ltr' | 'rtl';
};

const COPY = {
  ltr: {
    label: 'Sample orders, left to right',
    fresh: 'Confirmed through 4 Nov, today is provisional',
    head: ['Order', 'Customer', 'Area', 'Total', 'State', 'Cash'],
    names: ['Mona Abdelrahman', 'Omar Hassan', 'Salma Nabil'],
    stuck: 'Stuck 3 days',
    areas: ['Nasr City', 'Maadi', 'Heliopolis'],
    confirmed: 'Confirmed',
    notYet: 'Not confirmed',
    failed: 'Delivery failed',
    bosta: 'Owed by Bosta',
    customer: 'Owed by customer',
    none: 'None',
    provisional: 'Provisional',
    more: '2 more statuses',
    hiddenFailed: 'Courier unreachable',
    hiddenNotYet: 'Awaiting call',
    money: ['790 EGP', '1,240 EGP', '560 EGP'],
  },
  rtl: {
    label: 'Sample orders, right to left',
    fresh: 'مؤكد حتى ٤ نوفمبر، وأرقام اليوم مبدئية',
    head: ['الطلب', 'العميل', 'المنطقة', 'الإجمالي', 'الحالة', 'النقد'],
    names: ['منى عبد الرحمن', 'عمر حسن', 'سلمى نبيل'],
    stuck: 'متوقف منذ ٣ أيام',
    areas: ['مدينة نصر', 'المعادي', 'مصر الجديدة'],
    confirmed: 'مؤكد',
    notYet: 'غير مؤكد',
    failed: 'فشل التسليم',
    bosta: 'مستحق على بوسطة',
    customer: 'مستحق على العميل',
    none: 'لا شيء',
    provisional: 'مبدئي',
    more: 'حالتان أخريان',
    hiddenFailed: 'المندوب لا يرد',
    hiddenNotYet: 'بانتظار الاتصال',
    money: ['٧٩٠ جنيه', '١٬٢٤٠ جنيه', '٥٦٠ جنيه'],
  },
} as const;

/**
 * Three sample order rows in the fixed column order (code, who, where, how much, state, cash),
 * built from the status components, under a freshness strip. One copy per reading direction.
 */
export function OrderRowsSample({ dir }: OrderRowsSampleProps) {
  const t = COPY[dir];
  return (
    <div dir={dir} lang={dir === 'rtl' ? 'ar' : 'en'} className="flex flex-col gap-2">
      <FreshnessStrip text={t.fresh} />
      <Table aria-label={t.label}>
        <TableHeader>
          <TableRow>
            <TableHead>{t.head[0]}</TableHead>
            <TableHead>{t.head[1]}</TableHead>
            <TableHead>{t.head[2]}</TableHead>
            <TableHead className="text-end">{t.head[3]}</TableHead>
            <TableHead>{t.head[4]}</TableHead>
            <TableHead>{t.head[5]}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>
              <LtrText className="font-mono">SS-48190</LtrText>
            </TableCell>
            <TableCell>
              <div className="flex flex-col">
                <span>{t.names[0]}</span>
                <span className="text-xs text-warning">{t.stuck}</span>
              </div>
            </TableCell>
            <TableCell>{t.areas[0]}</TableCell>
            <TableCell className="text-end tabular-nums">{t.money[0]}</TableCell>
            <TableCell>
              <StatusChip meaning="confirmed" label={t.confirmed} />
            </TableCell>
            <TableCell>
              <StatusChip meaning="owed" label={t.bosta} />
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell>
              <LtrText className="font-mono">SS-48191</LtrText>
            </TableCell>
            <TableCell>{t.names[1]}</TableCell>
            <TableCell>{t.areas[1]}</TableCell>
            <TableCell className="text-end">
              <ProvisionalValue value={t.money[1]} provisionalLabel={t.provisional} />
            </TableCell>
            <TableCell>
              <StatusChip meaning="provisional" label={t.notYet} />
            </TableCell>
            <TableCell className="text-muted-foreground">{t.none}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>
              <LtrText className="font-mono">SS-48192</LtrText>
            </TableCell>
            <TableCell>{t.names[2]}</TableCell>
            <TableCell>{t.areas[2]}</TableCell>
            <TableCell className="text-end tabular-nums">{t.money[2]}</TableCell>
            <TableCell>
              <StatusChip meaning="failed" label={t.failed} />
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1">
                <StatusChip meaning="owed" label={t.customer} />
                <OverflowStatusesSample
                  label={t.more}
                  statuses={[
                    { meaning: 'failed', label: t.hiddenFailed },
                    { meaning: 'provisional', label: t.hiddenNotYet },
                  ]}
                />
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
