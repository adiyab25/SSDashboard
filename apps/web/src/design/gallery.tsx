'use client';

// Development only gallery (spec 0003, AC-11). Its specimen text and demo labels are
// sample content, exempt from the message dictionary (AC-12).
import { Avatar, AvatarFallback } from '@ssdashboard/ui/components/avatar';
import { Button } from '@ssdashboard/ui/components/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@ssdashboard/ui/components/command';
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
import { Input } from '@ssdashboard/ui/components/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@ssdashboard/ui/components/input-group';
import { Kbd, KbdGroup } from '@ssdashboard/ui/components/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@ssdashboard/ui/components/popover';
import { Separator } from '@ssdashboard/ui/components/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@ssdashboard/ui/components/sheet';
import { Skeleton } from '@ssdashboard/ui/components/skeleton';
import { Textarea } from '@ssdashboard/ui/components/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ssdashboard/ui/components/tooltip';
import { ChevronRightIcon, Loader2Icon, SearchIcon, StarIcon } from 'lucide-react';
import { Direction } from 'radix-ui';
import { useEffect, useState } from 'react';
import { tokenContrast } from './contrast';

/** Text pairs need 4.5:1, control boundaries and the focus ring 3:1 (WCAG 2.2 AA). */
const PAIRS: readonly { fg: string; bg: string; min: number }[] = [
  { fg: 'foreground', bg: 'background', min: 4.5 },
  { fg: 'muted-foreground', bg: 'background', min: 4.5 },
  { fg: 'muted-foreground', bg: 'muted', min: 4.5 },
  { fg: 'muted-foreground', bg: 'card', min: 4.5 },
  { fg: 'card-foreground', bg: 'card', min: 4.5 },
  { fg: 'popover-foreground', bg: 'popover', min: 4.5 },
  { fg: 'primary-foreground', bg: 'primary', min: 4.5 },
  { fg: 'secondary-foreground', bg: 'secondary', min: 4.5 },
  { fg: 'accent-foreground', bg: 'accent', min: 4.5 },
  { fg: 'destructive', bg: 'background', min: 4.5 },
  { fg: 'destructive-foreground', bg: 'destructive', min: 4.5 },
  { fg: 'success', bg: 'background', min: 4.5 },
  { fg: 'success-foreground', bg: 'success', min: 4.5 },
  { fg: 'warning', bg: 'background', min: 4.5 },
  { fg: 'warning-foreground', bg: 'warning', min: 4.5 },
  { fg: 'info', bg: 'background', min: 4.5 },
  { fg: 'info-foreground', bg: 'info', min: 4.5 },
  { fg: 'sidebar-foreground', bg: 'sidebar', min: 4.5 },
  { fg: 'sidebar-accent-foreground', bg: 'sidebar-accent', min: 4.5 },
  { fg: 'input', bg: 'background', min: 3 },
  { fg: 'input', bg: 'card', min: 3 },
  { fg: 'ring', bg: 'background', min: 3 },
];

const TYPE_SCALE = [
  { name: 'Page title', className: 'text-xl font-semibold', spec: '20px · 600' },
  { name: 'Section title', className: 'text-base font-semibold', spec: '16px · 600' },
  { name: 'Body', className: 'text-sm', spec: '14px / 20px · 400' },
  { name: 'Label', className: 'text-sm font-medium', spec: '14px · 500' },
  { name: 'Secondary', className: 'text-xs text-muted-foreground', spec: '12px · 400' },
];

const SPACING = [1, 2, 3, 4, 6, 8, 12];
const RADII = ['rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-xl'];
const DENSITY = [
  { name: 'Table row', className: 'h-row', px: 36 },
  { name: 'Table header', className: 'h-row-header', px: 40 },
  { name: 'Form control', className: 'h-control', px: 36 },
  { name: 'Sidebar item', className: 'h-nav-item', px: 32 },
  { name: 'Top bar', className: 'h-topbar', px: 56 },
  { name: 'Touch target (coarse pointer)', className: 'h-touch', px: 44 },
];

const VARIANTS = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const;
const STATES = ['default', 'hover', 'focus', 'active', 'disabled', 'loading'] as const;

/** Re-renders when the theme class on `<html>` changes, so live values follow it. */
function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((value) => value + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return version;
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ContrastPair({ fg, bg, min, version }: (typeof PAIRS)[number] & { version: number }) {
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setRatio(tokenContrast(fg, bg)));
    return () => cancelAnimationFrame(frame);
  }, [fg, bg, version]);
  const passes = ratio !== null && ratio >= min;

  return (
    <li className="flex items-center gap-3 rounded-md border p-2">
      {min < 4.5 ? (
        // A boundary pair: shown as a border, since it never carries text.
        <span
          aria-hidden
          className="size-10 shrink-0 rounded-md border-2"
          style={{ background: `var(--${bg})`, borderColor: `var(--${fg})` }}
        />
      ) : (
        <span
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-md border text-sm font-semibold"
          style={{ background: `var(--${bg})`, color: `var(--${fg})` }}
        >
          Aa
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">
          {fg} on {bg}
        </span>
        <span className="text-xs text-muted-foreground">at least {min}:1</span>
      </span>
      <span
        className={passes ? 'text-success tabular-nums' : 'text-destructive tabular-nums'}
        data-testid={`contrast-${fg}-on-${bg}`}
      >
        {ratio === null ? '…' : `${ratio.toFixed(2)}:1`}
      </span>
    </li>
  );
}

function ButtonMatrix() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-start">
        <caption className="sr-only">Button variants by state</caption>
        <thead>
          <tr className="h-row-header border-b">
            <th scope="col" className="pe-4 text-start font-medium">
              Variant
            </th>
            {STATES.map((state) => (
              <th key={state} scope="col" className="px-2 text-start font-medium">
                {state}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {VARIANTS.map((variant) => (
            <tr key={variant} className="border-b">
              <th scope="row" className="pe-4 text-start font-normal">
                {variant}
              </th>
              {STATES.map((state) => (
                <td key={state} className="p-2">
                  <Button
                    variant={variant}
                    tabIndex={-1}
                    data-state-preview={
                      ['hover', 'focus', 'active'].includes(state) ? state : undefined
                    }
                    disabled={state === 'disabled' || state === 'loading'}
                  >
                    {state === 'loading' && (
                      <Loader2Icon aria-hidden className="animate-spin" data-icon="inline-start" />
                    )}
                    Save
                  </Button>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FieldStates() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {(['default', 'hover', 'focus'] as const).map((state) => (
        <div key={state} className="flex flex-col gap-1.5">
          <label htmlFor={`sku-${state}`} className="font-medium">
            SKU ({state})
          </label>
          <Input
            id={`sku-${state}`}
            placeholder="e.g. TBL-OAK-120"
            tabIndex={-1}
            data-state-preview={state === 'default' ? undefined : state}
          />
        </div>
      ))}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="sku-disabled" className="font-medium">
          SKU (disabled)
        </label>
        <Input id="sku-disabled" disabled defaultValue="TBL-OAK-120" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="sku-invalid" className="font-medium">
          SKU (invalid)
        </label>
        <Input id="sku-invalid" aria-invalid defaultValue="TBL OAK" aria-describedby="sku-error" />
        <span id="sku-error" className="text-xs text-destructive">
          Use letters, numbers, and dashes only.
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="product-search" className="font-medium">
          Search with an addon
        </label>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput id="product-search" placeholder="Search products" />
        </InputGroup>
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
        <label htmlFor="note" className="font-medium">
          Note
        </label>
        <Textarea id="note" placeholder="Anything the warehouse should know" />
      </div>
    </div>
  );
}

function Overlays() {
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

function Basics() {
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
        <span>Start</span>
        <Separator orientation="vertical" />
        <span>End</span>
      </div>
      <div className="flex w-48 flex-col gap-2" aria-hidden>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  );
}

function PaletteSample() {
  return (
    <Command label="Sample palette" className="max-w-sm rounded-lg border">
      <CommandInput placeholder="Search pages…" />
      <CommandList>
        <CommandEmpty>No pages match.</CommandEmpty>
        <CommandGroup heading="Pages">
          <CommandItem>Stock levels</CommandItem>
          <CommandItem>Transfers</CommandItem>
          <CommandItem>Purchase orders</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

/** Mirrored sample, inside its own Radix direction so portals mirror too. */
function RightToLeftRow() {
  return (
    <Direction.Provider dir="rtl">
      <div dir="rtl" className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
        <Button>
          Next
          <ChevronRightIcon aria-hidden className="rtl:-scale-x-100" data-icon="inline-end" />
        </Button>
        <Button variant="outline">Back</Button>
        <InputGroup className="max-w-64">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput aria-label="Search, right to left" placeholder="Search" />
        </InputGroup>
      </div>
    </Direction.Provider>
  );
}

export function DesignGallery() {
  const version = useThemeVersion();

  return (
    <div data-gallery className="flex max-w-5xl flex-col gap-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Design system</h1>
          <p className="text-muted-foreground">
            Tokens and components from packages/ui. The written rules are in packages/ui/DESIGN.md.
          </p>
        </div>
      </header>

      <Section id="colors" title="Color roles and live contrast">
        <ul className="grid gap-2 sm:grid-cols-2">
          {PAIRS.map((pair) => (
            <ContrastPair key={`${pair.fg}-${pair.bg}`} {...pair} version={version} />
          ))}
        </ul>
      </Section>

      <Section id="type" title="Type">
        <ul className="flex flex-col gap-3">
          {TYPE_SCALE.map((step) => (
            <li key={step.name} className="flex flex-wrap items-baseline gap-x-4">
              <span className={step.className}>{step.name}: receive 24 oak tables</span>
              <span className="text-xs text-muted-foreground">{step.spec}</span>
            </li>
          ))}
          <li className="tabular-nums">Tabular numbers: 1,204.50 · 98.00 · 11,111.11</li>
        </ul>
        <div lang="ar" dir="rtl" className="flex flex-col gap-1 rounded-lg border p-4">
          <p className="text-base font-semibold">استلام ٢٤ طاولة من خشب البلوط</p>
          <p>نص تجريبي بخط IBM Plex Sans Arabic لعرض شكل الحروف والمسافات بين الأسطر.</p>
        </div>
      </Section>

      <Section id="spacing" title="Spacing, radius, and density">
        <ul className="flex flex-wrap items-end gap-4">
          {SPACING.map((step) => (
            <li key={step} className="flex flex-col items-center gap-1">
              <span
                aria-hidden
                className="bg-primary"
                style={{ width: `${step * 4}px`, height: '1rem' }}
              />
              <span className="text-xs text-muted-foreground tabular-nums">{step * 4}px</span>
            </li>
          ))}
        </ul>
        <ul className="flex flex-wrap gap-4">
          {RADII.map((radius) => (
            <li key={radius} className="flex flex-col items-center gap-1">
              <span aria-hidden className={`size-12 border-2 border-input bg-muted ${radius}`} />
              <span className="text-xs text-muted-foreground">{radius}</span>
            </li>
          ))}
        </ul>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {DENSITY.map((row) => (
            <li
              key={row.name}
              className={`flex items-center justify-between rounded-md border px-3 ${row.className}`}
            >
              <span>{row.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{row.px}px</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="buttons" title="Buttons">
        <ButtonMatrix />
      </Section>

      <Section id="fields" title="Fields">
        <FieldStates />
      </Section>

      <Section id="overlays" title="Overlays">
        <Overlays />
      </Section>

      <Section id="basics" title="Keys, avatar, separator, skeleton">
        <Basics />
      </Section>

      <Section id="command" title="Command list">
        <PaletteSample />
      </Section>

      <Section id="rtl" title="Right to left">
        <RightToLeftRow />
        <p className="text-muted-foreground">
          The sidebar, top bar, and their menus on this page are the live shell components.
        </p>
      </Section>
    </div>
  );
}
