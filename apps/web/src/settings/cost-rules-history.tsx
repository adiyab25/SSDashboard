'use client';

import type { CostRuleRow } from '@ssdashboard/contracts';
import { Button } from '@ssdashboard/ui/components/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';
import { LoaderCircleIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormat } from '@/i18n/use-format';
import { useCostRuleText } from './use-cost-rule-text';

/** Props of `CostRulesHistory`. */
interface CostRulesHistoryProps {
  /** Every loaded row, newest recorded first. */
  rows: readonly CostRuleRow[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Who recorded a row, in words (the install's seed rows have nobody). */
  recorder: (row: CostRuleRow) => string;
}

/** The header cell classes of the history table (DESIGN.md, data tables). */
const head = 'px-3';

/**
 * The history of the per order cost rules (spec 0009, AC-23): every recorded rule, newest first,
 * with its kind, value or "Not set", the day it applies from, when and by whom it was recorded,
 * and Show more while the api has another page. Rules are never edited, so this is the whole
 * story; the reason of each is in its audit entry. An empty history says so in a sentence.
 */
export function CostRulesHistory({
  rows,
  hasMore,
  loadingMore,
  onLoadMore,
  recorder,
}: CostRulesHistoryProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const words = useCostRuleText();

  return (
    <section aria-labelledby="cost-rules-history" className="flex flex-col gap-2">
      <h2 id="cost-rules-history" className="text-base font-semibold">
        {t('settings.costRules.historyHeading')}
      </h2>
      <div className="overflow-x-auto rounded-card gradient-card-edge">
        <Table aria-label={t('settings.costRules.historyTable')}>
          <TableHeader>
            <TableRow className="h-row-header">
              <TableHead scope="col" className={`${head} text-start`}>
                {t('settings.costRules.columns.kind')}
              </TableHead>
              <TableHead scope="col" className={`${head} text-end`}>
                {t('settings.costRules.columns.rule')}
              </TableHead>
              <TableHead scope="col" className={`${head} text-start`}>
                {t('settings.costRules.columns.from')}
              </TableHead>
              <TableHead scope="col" className={`${head} text-start`}>
                {t('settings.costRules.columns.recorded')}
              </TableHead>
              <TableHead scope="col" className={`${head} text-start`}>
                {t('settings.costRules.columns.by')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={5}
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  {t('settings.costRules.historyEmpty')}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id} className="h-row">
                  <TableCell className="px-3">{words.kindName(row.kind)}</TableCell>
                  <TableCell className="px-3 text-end tabular-nums">
                    {words.rule(
                      row.kind,
                      row.status === 'set' && row.value !== null
                        ? { status: 'set', value: row.value }
                        : { status: 'not_set' },
                    )}
                  </TableCell>
                  <TableCell className="px-3">{format.dateOnly(row.effectiveFrom)}</TableCell>
                  <TableCell className="px-3">{format.dateTime(row.recordedAt)}</TableCell>
                  <TableCell className="px-3">{recorder(row)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {hasMore && (
        <Button
          variant="outline"
          className="self-center"
          disabled={loadingMore}
          aria-busy={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore && (
            <LoaderCircleIcon
              aria-hidden
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          )}
          {t('settings.costRules.loadMore')}
        </Button>
      )}
    </section>
  );
}
