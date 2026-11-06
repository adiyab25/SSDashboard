'use client';

import { Button } from '@ssdashboard/ui/components/button';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@ssdashboard/ui/components/command';
import { Kbd } from '@ssdashboard/ui/components/kbd';
import { SearchIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccess } from '@/access/use-access';
import { navGroups, visibleNavItems } from './nav';

/** The palette shortcut as drawn on the key: not text to translate. */
const SHORTCUT = { apple: '⌘ K', other: 'Ctrl K' } as const;

const noSubscribe = () => () => {};
const isApplePlatform = () => /Mac|iPhone|iPad/.test(navigator.userAgent);

/**
 * Jump to any page. Ctrl+K (Cmd+K on Apple platforms) toggles it from anywhere, text
 * fields included; Esc closes it and focus goes back where it was.
 */
export function CommandPalette() {
  const { t } = useTranslation();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  // "Ctrl K" on the server and first paint, "⌘ K" after mount on Apple platforms.
  const apple = useSyncExternalStore(noSubscribe, isApplePlatform, () => false);
  const { permissions } = useAccess();
  const items = visibleNavItems(permissions);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      setOpen((wasOpen) => {
        if (!wasOpen && document.activeElement instanceof HTMLElement) {
          returnFocus.current = document.activeElement;
        }
        return !wasOpen;
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <Button
        variant="outline"
        className="coarse:min-h-touch coarse:min-w-touch gap-2 text-muted-foreground"
        aria-keyshortcuts="Control+K Meta+K"
        onClick={(event) => {
          returnFocus.current = event.currentTarget;
          setOpen(true);
        }}
      >
        <SearchIcon aria-hidden data-icon="inline-start" />
        <span className="max-sm:sr-only">{t('shell.topbar.palette')}</span>
        <Kbd aria-hidden className="max-sm:hidden">
          {apple ? SHORTCUT.apple : SHORTCUT.other}
        </Kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t('shell.palette.title')}
        description={t('shell.palette.description')}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <Command label={t('shell.palette.title')}>
          <CommandInput placeholder={t('shell.palette.placeholder')} />
          <CommandList>
            <CommandEmpty>{t('shell.palette.noResults')}</CommandEmpty>
            <CommandGroup heading={t('shell.palette.groups.pages')}>
              {navGroups.flatMap((group) =>
                items
                  .filter((item) => item.group === group.id)
                  .map((item) => (
                    <CommandItem
                      key={item.id}
                      value={t(item.labelKey)}
                      className="coarse:min-h-touch"
                      onSelect={() => {
                        returnFocus.current = null;
                        setOpen(false);
                        router.push(item.href);
                      }}
                    >
                      <item.icon aria-hidden />
                      {t(item.labelKey)}
                    </CommandItem>
                  )),
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
