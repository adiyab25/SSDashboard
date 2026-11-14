'use client';

import * as React from 'react';
import { cn } from 'cn';
import { Dialog as SheetPrimitive } from 'radix-ui';

import { Button } from '@ssdashboard/ui/components/button';
import { XIcon } from 'lucide-react';

/** Side panel dialog root that slides in from an edge; owns open state and traps focus. */
function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

/** Element that opens its Sheet; use asChild for a custom trigger. */
function SheetTrigger({ ...props }: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

/** Element that closes the surrounding Sheet. */
function SheetClose({ ...props }: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/10 duration-150 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className,
      )}
      {...props}
    />
  );
}

/** The sliding panel of a Sheet; needs a SheetTitle for accessibility. */
function SheetContent({
  className,
  children,
  side = 'end',
  closeLabel,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  /** Logical sides: `start` is the left in left to right and the right in right to left. */
  side?: 'top' | 'end' | 'bottom' | 'start';
  /** Accessible name of the close button; the button shows only when this is given. */
  closeLabel?: string;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          'fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg transition duration-200 ease-ui data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=start]:inset-y-0 data-[side=start]:start-0 data-[side=start]:h-full data-[side=start]:w-3/4 data-[side=start]:border-e data-[side=start]:sm:max-w-sm data-[side=end]:inset-y-0 data-[side=end]:end-0 data-[side=end]:h-full data-[side=end]:w-3/4 data-[side=end]:border-s data-[side=end]:sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-[side=bottom]:data-open:slide-in-from-bottom-10 data-[side=bottom]:data-closed:slide-out-to-bottom-10 data-[side=top]:data-open:slide-in-from-top-10 data-[side=top]:data-closed:slide-out-to-top-10 ltr:data-[side=start]:data-open:slide-in-from-left-10 ltr:data-[side=start]:data-closed:slide-out-to-left-10 rtl:data-[side=start]:data-open:slide-in-from-right-10 rtl:data-[side=start]:data-closed:slide-out-to-right-10 ltr:data-[side=end]:data-open:slide-in-from-right-10 ltr:data-[side=end]:data-closed:slide-out-to-right-10 rtl:data-[side=end]:data-open:slide-in-from-left-10 rtl:data-[side=end]:data-closed:slide-out-to-left-10',
          className,
        )}
        {...props}
      >
        {children}
        {closeLabel && (
          <SheetPrimitive.Close data-slot="sheet-close" asChild>
            <Button variant="ghost" className="absolute top-4 end-4" size="icon-sm">
              <XIcon />
              <span className="sr-only">{closeLabel}</span>
            </Button>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
}

/** Layout wrapper for the title and description of a Sheet. */
function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-1.5 p-4', className)}
      {...props}
    />
  );
}

/** Layout wrapper for the action buttons of a Sheet. */
function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('mt-auto flex flex-col gap-2 p-4', className)}
      {...props}
    />
  );
}

/** Accessible name of a Sheet; required for screen readers. */
function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-heading font-medium text-foreground', className)}
      {...props}
    />
  );
}

/** Accessible description of a Sheet. */
function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
