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

/** Dialog, popover and tooltip, to check stacking, focus return and direction. */
export function Overlays() {
  return (
    <div className="flex flex-wrap gap-2">
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">Dialog</Button>
        </DialogTrigger>
        <DialogContent closeLabel="Close">
          <DialogHeader>
            <DialogTitle>Archive this location?</DialogTitle>
            <DialogDescription>
              Stock screens stop listing it. You can restore it later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter closeLabel="Cancel">
            <Button variant="destructive">Archive</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="outline">Sheet from the start edge</Button>
        </SheetTrigger>
        <SheetContent side="start" closeLabel="Close">
          <SheetHeader>
            <SheetTitle>Filters</SheetTitle>
            <SheetDescription>Narrow the list by location and status.</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Popover</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Stock detail">
          On hand 120 · reserved 8 · available 112
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">Dropdown menu</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuItem>Edit</DropdownMenuItem>
            <DropdownMenuItem>Duplicate</DropdownMenuItem>
            <DropdownMenuItem variant="destructive">Archive</DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="icon" aria-label="Favourite">
            <StarIcon aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Favourite</TooltipContent>
      </Tooltip>
    </div>
  );
}
