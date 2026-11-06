'use client';

// Development only gallery (spec 0003, AC-11). Its specimen text and demo labels are
// sample content, exempt from the message dictionary (AC-12).

import { Basics } from './basics';
import { ButtonMatrix } from './button-matrix';
import { ContrastPair, type ContrastPairSpec } from './contrast-pair';
import { DesignSection } from './design-section';
import { FieldStates } from './field-states';
import { FramesSection } from './frames-section';
import { OrderStatusSection } from './order-status-section';
import { Overlays } from './overlays';
import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { PaletteSample } from './palette-sample';
import { RightToLeftRow } from './right-to-left-row';
import { useThemeVersion } from './use-theme-version';

/**
 * Text pairs need 4.5:1, control boundaries (including the dashed provisional boundary, the
 * `input` role) and the focus ring 3:1 (WCAG 2.2 AA).
 */
const PAIRS: readonly ContrastPairSpec[] = [
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
  { fg: 'brand-foreground', bg: 'brand', min: 4.5 },
  // Meaning colors (Daftar): text on the page, on a card, and on its own chip surface. The
  // provisional chip surface is transparent, so it is measured on the card only.
  { fg: 'confirmed', bg: 'background', min: 4.5 },
  { fg: 'confirmed', bg: 'card', min: 4.5 },
  { fg: 'confirmed', bg: 'confirmed-surface', min: 4.5 },
  { fg: 'failed', bg: 'background', min: 4.5 },
  { fg: 'failed', bg: 'card', min: 4.5 },
  { fg: 'failed', bg: 'failed-surface', min: 4.5 },
  { fg: 'owed', bg: 'background', min: 4.5 },
  { fg: 'owed', bg: 'card', min: 4.5 },
  { fg: 'owed', bg: 'owed-surface', min: 4.5 },
  { fg: 'provisional', bg: 'background', min: 4.5 },
  { fg: 'provisional', bg: 'card', min: 4.5 },
  { fg: 'info', bg: 'card', min: 4.5 },
  { fg: 'info', bg: 'info-surface', min: 4.5 },
  { fg: 'sidebar-foreground', bg: 'sidebar', min: 4.5 },
  { fg: 'sidebar-accent-foreground', bg: 'sidebar-accent', min: 4.5 },
  { fg: 'input', bg: 'background', min: 3 },
  { fg: 'input', bg: 'card', min: 3 },
  { fg: 'ring', bg: 'background', min: 3 },
];

const TYPE_SCALE = [
  { name: 'Page title', className: 'text-xl font-semibold', spec: '20px / 28px · 600' },
  { name: 'Section title', className: 'text-base font-semibold', spec: '17px / 25.5px · 600' },
  { name: 'Body', className: 'text-sm', spec: '15px / 22.5px · 400' },
  { name: 'Label', className: 'text-sm font-medium', spec: '15px / 22.5px · 500' },
  { name: 'Secondary', className: 'text-xs text-muted-foreground', spec: '12px / 16px · 400' },
];

const SPACING = [1, 2, 3, 4, 6, 8, 12];
const RADII = ['rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-xl'];
const DENSITY = [
  { name: 'Table row', className: 'h-row', px: 40 },
  { name: 'Table header', className: 'h-row-header', px: 44 },
  { name: 'Form control', className: 'h-control', px: 40 },
  { name: 'Sidebar item', className: 'h-nav-item', px: 32 },
  { name: 'Top bar', className: 'h-topbar', px: 56 },
  { name: 'Touch target (coarse pointer)', className: 'h-touch', px: 44 },
];

/** The development only page that shows every token and base component, live. */
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

      <DesignSection id="colors" title="Color roles and live contrast">
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
          {PAIRS.map((pair) => (
            <ContrastPair key={`${pair.fg}-${pair.bg}`} {...pair} version={version} />
          ))}
        </ul>
      </DesignSection>

      <DesignSection id="type" title="Type">
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
          <p>نص تجريبي بخط Noto Sans Arabic لعرض شكل الحروف والمسافات بين الأسطر.</p>
        </div>
        <div className="flex flex-col gap-1 rounded-lg border p-4">
          <LtrText className="font-mono text-sm">
            SKU-0042 · 6223001234567 · const total = 1204.5;
          </LtrText>
          <span className="text-xs text-muted-foreground">Code specimen in JetBrains Mono</span>
        </div>
      </DesignSection>

      <DesignSection id="spacing" title="Spacing, radius, and density">
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
      </DesignSection>

      <DesignSection id="buttons" title="Buttons">
        <ButtonMatrix />
      </DesignSection>

      <DesignSection id="fields" title="Fields">
        <FieldStates />
      </DesignSection>

      <DesignSection id="overlays" title="Overlays">
        <Overlays />
      </DesignSection>

      <DesignSection id="basics" title="Keys, avatar, separator, skeleton">
        <Basics />
      </DesignSection>

      <DesignSection id="command" title="Command list">
        <PaletteSample />
      </DesignSection>

      <DesignSection id="orders" title="Order rows and confirmation queue">
        <OrderStatusSection />
      </DesignSection>

      <DesignSection id="frames" title="Frames">
        <FramesSection />
      </DesignSection>

      <DesignSection id="rtl" title="Right to left">
        <RightToLeftRow />
        <p className="text-muted-foreground">
          The sidebar, top bar, and their menus on this page are the live shell components.
        </p>
      </DesignSection>
    </div>
  );
}
