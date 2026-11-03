'use client';

import { Button } from '@ssdashboard/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@ssdashboard/ui/components/dropdown-menu';
import { LanguagesIcon, SunMoonIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useTranslation } from 'react-i18next';
import { useLanguage } from '@/i18n/language-provider';

const THEMES = ['light', 'dark', 'system'] as const;
const ITEM = 'coarse:min-h-touch';

/** The language and theme choices for screens outside the shell, where there is no user menu. */
export function AuthPreferences() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();
  const { language, options, setLanguage } = useLanguage();

  return (
    <div className="flex items-center gap-1">
      {options.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="coarse:size-touch"
              aria-label={t('shell.user.language')}
            >
              <LanguagesIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={language}
              onValueChange={(code) => void setLanguage(code)}
            >
              {options.map((option) => (
                // Each option is in its own language and direction, whatever the page is in.
                <DropdownMenuRadioItem
                  key={option.code}
                  value={option.code}
                  lang={option.code}
                  dir={option.dir}
                  className={ITEM}
                >
                  {option.nativeName}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="coarse:size-touch"
            aria-label={t('shell.user.theme')}
          >
            <SunMoonIcon aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
            {THEMES.map((value) => (
              <DropdownMenuRadioItem key={value} value={value} className={ITEM}>
                {t(`shell.theme.${value}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
