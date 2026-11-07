'use client';

import { CollapsingTable } from '@ssdashboard/ui/dashboard/collapsing-table';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { StatusChip } from '@ssdashboard/ui/status/status-chip';
import { useFormat } from '@/i18n/use-format';
import type { PhoneDashboardCopy } from './phone-dashboard-copy';

type SampleOrder = {
  code: string;
  nameIndex: number;
  total: string;
  state: 'confirmed' | 'failed' | 'provisional';
};

const ORDERS: SampleOrder[] = [
  { code: 'SS-48190', nameIndex: 0, total: '790.00', state: 'confirmed' },
  { code: 'SS-48191', nameIndex: 1, total: '1240.00', state: 'provisional' },
  { code: 'SS-48192', nameIndex: 2, total: '560.00', state: 'failed' },
];

/**
 * Three sample orders in `CollapsingTable`: cards under 640px, a table from there up, with the
 * same chips. Sample only; the real list comes from the orders api. It must never call the api.
 */
export function CollapsingOrdersSample({ copy }: { copy: PhoneDashboardCopy }) {
  const format = useFormat();
  return (
    <CollapsingTable<SampleOrder>
      caption={copy.tableCaption}
      rows={ORDERS}
      getRowKey={(row) => row.code}
      columns={[
        {
          id: 'order',
          header: copy.tableHead.order,
          title: true,
          cell: (row) => <LtrText className="font-mono">{row.code}</LtrText>,
        },
        {
          id: 'customer',
          header: copy.tableHead.customer,
          cell: (row) => copy.names[row.nameIndex],
        },
        {
          id: 'total',
          header: copy.tableHead.total,
          align: 'end',
          cell: (row) => format.money(row.total, 2),
        },
        {
          id: 'state',
          header: copy.tableHead.state,
          cell: (row) => <StatusChip meaning={row.state} label={copy.tableStates[row.state]} />,
        },
      ]}
    />
  );
}
