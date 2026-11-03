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
import { LanguagesIcon, LogOutIcon, SunMoonIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLanguage } from '@/i18n/language-provider';

const THEMES = ['light', 'dark', 'system'] as const;
const ITEM = 'coarse:min-h-touch';

/** Placeholder identity until feature 6, plus the theme and language switches. */
export function UserMenu() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();
  const { language, options, failedLanguage, setLanguage, clearFailure } = useLanguage();
  const [open, setOpen] = useState(false);
  const name = t('shell.user.placeholderName');

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) clearFailure();
      }}
    >
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
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={ITEM}>
              <LanguagesIcon aria-hidden />
              {t('shell.user.language')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={language}
                onValueChange={(code) => {
                  // Closes on success; on failure the menu stays open to show the error.
                  void setLanguage(code).then((applied) => applied && setOpen(false));
                }}
              >
                {options.map((option) => (
                  // Each option is in its own language and direction, whatever the page is in.
                  <DropdownMenuRadioItem
                    key={option.code}
                    value={option.code}
                    lang={option.code}
                    dir={option.dir}
                    onSelect={(event) => event.preventDefault()}
                    className={ITEM}
                  >
                    {option.nativeName}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {/* Beside the Language row, not inside its submenu: that closes on the click. */}
          {failedLanguage && (
            <p role="alert" className="px-2 py-1.5 text-xs text-destructive">
              {t('shell.user.languageError', { language: failedLanguage.nativeName })}
            </p>
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
