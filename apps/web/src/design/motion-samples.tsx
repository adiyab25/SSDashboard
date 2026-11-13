'use client';

import { Button } from '@ssdashboard/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@ssdashboard/ui/components/dropdown-menu';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The motion of spec 0025, one sample each: hover lift, the main button sheen, press, the
 * entrance (replayable), the dropdown, and the skeleton. Under reduced motion all of it is off,
 * not shortened, and the note says which case the browser is in right now.
 */
export function MotionSamples() {
  const { t } = useTranslation();
  const [replay, setReplay] = useState(0);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground" data-testid="motion-note">
        {t('design.motion.note')}{' '}
        {reduced ? t('design.motion.reducedOn') : t('design.motion.reducedOff')}
      </p>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <li className="flex flex-col items-start gap-2 rounded-card border bg-card p-4">
          <Button variant="outline">{t('design.motion.lift')}</Button>
          <span className="text-xs text-muted-foreground">{t('design.motion.liftNote')}</span>
        </li>
        <li className="flex flex-col items-start gap-2 rounded-card border bg-card p-4">
          <Button>{t('design.motion.sheen')}</Button>
          <span className="text-xs text-muted-foreground">{t('design.motion.sheenNote')}</span>
        </li>
        <li className="flex flex-col items-start gap-2 rounded-card border bg-card p-4">
          <Button variant="secondary">{t('design.motion.press')}</Button>
          <span className="text-xs text-muted-foreground">{t('design.motion.pressNote')}</span>
        </li>
        <li className="flex flex-col items-start gap-2 rounded-card border bg-card p-4">
          <Button variant="ghost" onClick={() => setReplay((value) => value + 1)}>
            {t('design.motion.replay')}
          </Button>
          <div
            key={replay}
            className="enter-children flex flex-col gap-1"
            data-testid="motion-enter"
          >
            <span className="rounded-chip bg-muted px-2 py-1">{t('design.motion.enterOne')}</span>
            <span className="rounded-chip bg-muted px-2 py-1">{t('design.motion.enterTwo')}</span>
            <span className="rounded-chip bg-muted px-2 py-1">{t('design.motion.enterThree')}</span>
          </div>
          <span className="text-xs text-muted-foreground">{t('design.motion.enterNote')}</span>
        </li>
        <li className="flex flex-col items-start gap-2 rounded-card border bg-card p-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">{t('design.motion.dropdown')}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuGroup>
                <DropdownMenuItem>{t('design.motion.dropdownOne')}</DropdownMenuItem>
                <DropdownMenuItem>{t('design.motion.dropdownTwo')}</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="text-xs text-muted-foreground">{t('design.motion.dropdownNote')}</span>
        </li>
        <li className="flex flex-col gap-2 rounded-card border bg-card p-4">
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
          <span className="text-xs text-muted-foreground">{t('design.motion.skeletonNote')}</span>
        </li>
      </ul>
    </div>
  );
}
