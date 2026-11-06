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
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { LanguagesIcon, LogOutIcon, SunMoonIcon, UserRoundIcon } from 'lucide-react';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { saveLanguageToAccount } from '@/auth/account-api';
import { authClient } from '@/auth/auth-client';
import { useMe } from '@/auth/use-me';
import { useLanguage } from '@/i18n/language-provider';

const THEMES = ['light', 'dark', 'system'] as const;
const ITEM = 'coarse:min-h-touch';

/** The signed in person (name, email, role), the theme and language switches, and sign out. */
export function UserMenu() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();
  const { language, options, failedLanguage, setLanguage, clearFailure } = useLanguage();
  const [open, setOpen] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const me = useMe();
  const name = me?.name ?? '';

  async function signOut() {
    setSignOutFailed(false);
    const { error } = await authClient()
      .signOut()
      .catch(() => ({ error: true }));
    if (error) {
      setSignOutFailed(true);
      return;
    }
    // A full load on purpose: nothing from this session stays in memory, as the router would keep it.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign('/sign-in');
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          clearFailure();
          setSignOutFailed(false);
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="coarse:min-h-touch coarse:min-w-touch gap-2 px-1.5">
          <Avatar aria-hidden className="size-6">
            <AvatarFallback className="text-xs">
              {name.trim().charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="sr-only">{t('shell.user.menu')}: </span>
          <span className="max-sm:sr-only">{name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          <span className="truncate font-medium text-foreground">{name}</span>
          {me && (
            <>
              <LtrText className="block truncate text-xs text-muted-foreground">{me.email}</LtrText>
              <span className="text-xs text-muted-foreground">
                {t(`shell.user.roles.${me.hats.includes('manager') ? 'admin' : 'staff'}`)}
              </span>
            </>
          )}
        </DropdownMenuLabel>
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
                  void setLanguage(code).then((applied) => {
                    if (!applied) return;
                    setOpen(false);
                    // Also saved to the account, so the next device opens in it (AC-19).
                    void saveLanguageToAccount(code);
                  });
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
        <DropdownMenuItem asChild className={ITEM}>
          <Link href="/account">
            <UserRoundIcon aria-hidden />
            {t('shell.user.account')}
          </Link>
        </DropdownMenuItem>
        {signOutFailed && (
          <p role="alert" className="px-2 py-1.5 text-xs text-destructive">
            {t('shell.user.signOutError')}
          </p>
        )}
        <DropdownMenuItem
          className={ITEM}
          onSelect={(event) => {
            // Stay open on failure so the error shows; success leaves the page.
            event.preventDefault();
            void signOut();
          }}
        >
          <LogOutIcon aria-hidden className="rtl:-scale-x-100" />
          {t('shell.user.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
