'use client';

import { useTranslation } from 'react-i18next';

const SPACING = [1, 2, 3, 4, 6, 8, 12];
const RADII = [
  { name: 'rounded-chip', px: 6, className: 'rounded-chip' },
  { name: 'rounded-control', px: 8, className: 'rounded-control' },
  { name: 'rounded-popover', px: 10, className: 'rounded-popover' },
  { name: 'rounded-card', px: 12, className: 'rounded-card' },
] as const;
const DENSITY = [
  { key: 'row', className: 'h-row', px: 40 },
  { key: 'rowHeader', className: 'h-row-header', px: 44 },
  { key: 'control', className: 'h-control', px: 40 },
  { key: 'navItem', className: 'h-nav-item', px: 32 },
  { key: 'topbar', className: 'h-topbar', px: 56 },
  { key: 'touch', className: 'h-touch', px: 44 },
] as const;

/** The spacing steps, the four named radii (spec 0025, AC-12), and the density heights, unchanged. */
export function RadiusAndDensity() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6">
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
          <li key={radius.name} className="flex flex-col items-center gap-1">
            <span
              aria-hidden
              data-testid={`radius-${radius.name}`}
              className={`size-16 border-2 border-input bg-muted ${radius.className}`}
            />
            <span className="text-xs text-muted-foreground">
              {radius.name} · {radius.px}px
            </span>
          </li>
        ))}
      </ul>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {DENSITY.map((row) => (
          <li
            key={row.key}
            className={`flex items-center justify-between rounded-control border px-3 ${row.className}`}
          >
            <span>{t(`design.density.${row.key}`)}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{row.px}px</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
