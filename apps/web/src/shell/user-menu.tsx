'use client';

import { Avatar, AvatarFallback } from '@ssdashboard/ui/components/avatar';
import { Button } from '@ssdashboard/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@ssdashboard/ui/components/dropdown-menu';
import { ArrowLeftRightIcon, LogOutIcon, SunMoonIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { t } from '@/i18n/t';
import { DIRECTION_SWITCH, useDirectionSetting, type TextDirection } from './direction';

const THEMES = ['light', 'dark', 'system'] as const;
const DIRECTIONS: readonly TextDirection[] = ['ltr', 'rtl'];
const ITEM = 'coarse:min-h-touch';

/** Placeholder identity until feature 6, plus the theme and (in development) direction. */
export function UserMenu() {
  const { theme, setTheme } = useTheme();
  const { dir, setDir } = useDirectionSetting();
  const name = t('shell.user.placeholderName');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="coarse:min-h-touch coarse:min-w-touch gap-2 px-1.5">
          <Avatar aria-hidden className="size-6">
            <AvatarFallback className="text-xs">
              {t('shell.user.placeholderInitial')}
            </AvatarFallback>
          </Avatar>
          <span className="sr-only">{t('shell.user.menu')}: </span>
          <span className="max-sm:sr-only">{name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={ITEM}>
              <SunMoonIcon aria-hidden />
              {t('shell.user.theme')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
                {THEMES.map((value) => (
                  <DropdownMenuRadioItem key={value} value={value} className={ITEM}>
                    {t(`shell.theme.${value}`)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {DIRECTION_SWITCH && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM}>
                <ArrowLeftRightIcon aria-hidden />
                {t('shell.user.direction')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={dir}
                  onValueChange={(value) => setDir(value === 'rtl' ? 'rtl' : 'ltr')}
                >
                  {DIRECTIONS.map((value) => (
                    <DropdownMenuRadioItem key={value} value={value} className={ITEM}>
                      {t(`shell.direction.${value}`)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled className={`${ITEM} flex-col items-start gap-0`}>
          <span className="flex items-center gap-2">
            <LogOutIcon aria-hidden className="rtl:-scale-x-100" />
            {t('shell.user.signOut')}
          </span>
          <span className="text-xs text-muted-foreground">{t('shell.user.signOutHint')}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
