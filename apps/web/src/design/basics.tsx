'use client';

import { Avatar, AvatarFallback } from '@ssdashboard/ui/components/avatar';
import { Kbd, KbdGroup } from '@ssdashboard/ui/components/kbd';
import { Separator } from '@ssdashboard/ui/components/separator';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useTranslation } from 'react-i18next';

/** Keys, avatar, separator and skeleton specimens. */
export function Basics() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-6">
      <KbdGroup>
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>
      <Avatar>
        <AvatarFallback>S</AvatarFallback>
      </Avatar>
      <div className="flex h-6 items-center gap-3">
        <span>{t('design.basics.start')}</span>
        <Separator orientation="vertical" />
        <span>{t('design.basics.end')}</span>
      </div>
      <div className="flex w-48 flex-col gap-2" aria-hidden>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  );
}
