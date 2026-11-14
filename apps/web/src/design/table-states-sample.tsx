'use client';

import { Alert, AlertDescription, AlertTitle } from '@ssdashboard/ui/components/alert';
import { Button } from '@ssdashboard/ui/components/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@ssdashboard/ui/components/table';
import { OctagonXIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** The empty table state (a plain sentence in the body) and the error state (the destructive block with a retry). */
export function TableStatesSample() {
  const { t } = useTranslation();

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-card border bg-card">
        <Table aria-label={t('design.table.emptyLabel')}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('design.table.order')}</TableHead>
              <TableHead>{t('design.table.customer')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={2} className="h-24 text-center text-muted-foreground">
                {t('design.table.empty')}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <Alert variant="destructive">
        <OctagonXIcon aria-hidden />
        <AlertTitle>{t('design.table.errorTitle')}</AlertTitle>
        <AlertDescription>{t('design.table.errorBody')}</AlertDescription>
        <div className="col-start-2 mt-2">
          <Button variant="outline" size="sm">
            {t('design.table.retry')}
          </Button>
        </div>
      </Alert>
    </div>
  );
}
