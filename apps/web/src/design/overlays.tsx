'use client';

import { Button } from '@ssdashboard/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@ssdashboard/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@ssdashboard/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@ssdashboard/ui/components/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@ssdashboard/ui/components/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ssdashboard/ui/components/tooltip';
import { StarIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Dialog, popover and tooltip, to check stacking, focus return and direction. */
export function Overlays() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">{t('design.overlays.dialog')}</Button>
        </DialogTrigger>
        <DialogContent closeLabel={t('design.overlays.close')}>
          <DialogHeader>
            <DialogTitle>{t('design.overlays.dialogTitle')}</DialogTitle>
            <DialogDescription>{t('design.overlays.dialogBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter closeLabel={t('design.overlays.cancel')}>
            <Button variant="destructive">{t('design.overlays.archive')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="outline">{t('design.overlays.sheet')}</Button>
        </SheetTrigger>
        <SheetContent side="start" closeLabel={t('design.overlays.close')}>
          <SheetHeader>
            <SheetTitle>{t('design.overlays.sheetTitle')}</SheetTitle>
            <SheetDescription>{t('design.overlays.sheetBody')}</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">{t('design.overlays.popover')}</Button>
        </PopoverTrigger>
        <PopoverContent aria-label={t('design.overlays.popoverLabel')}>
          {t('design.overlays.popoverBody')}
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">{t('design.overlays.dropdown')}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuItem>{t('design.overlays.edit')}</DropdownMenuItem>
            <DropdownMenuItem>{t('design.overlays.duplicate')}</DropdownMenuItem>
            <DropdownMenuItem variant="destructive">
              {t('design.overlays.archive')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="icon" aria-label={t('design.overlays.favourite')}>
            <StarIcon aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('design.overlays.favourite')}</TooltipContent>
      </Tooltip>
    </div>
  );
}
