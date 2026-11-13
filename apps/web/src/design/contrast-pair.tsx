'use client';

import { CheckIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pairContrast, type MeasuredPair } from './contrast';

/**
 * A foreground and background pair and the lowest contrast ratio it must reach. Each colour is a
 * role or CSS variable name, a literal hex, or a gradient stop (`stops-primary@2`), see
 * `resolveColor`. `over` is the surface a translucent background sits on (the page by default).
 */
export interface ContrastPairSpec {
  fg: string;
  bg: string;
  over?: string;
  min: number;
  /** Distinguishes two pairs with the same colours on different surfaces. */
  id?: string;
  /** The `data-testid` prefix; `compare` marks a pair that is allowed to fail (the light accent choice). */
  prefix?: 'contrast' | 'compare';
}

/** The `data-testid` a pair carries, so a test can read its live figure. */
export function pairTestId(pair: ContrastPairSpec): string {
  return `${pair.prefix ?? 'contrast'}-${pair.id ?? `${pair.fg}-on-${pair.bg}`}`;
}

/**
 * One pair's live contrast ratio, re-measured when the theme changes. The result is a figure, a
 * mark (check or cross), and a word (meets or fails), so it never relies on colour alone.
 */
export function ContrastPair(pair: ContrastPairSpec & { version: number }) {
  const { fg, bg, over, min, version } = pair;
  const { t } = useTranslation();
  const [measured, setMeasured] = useState<MeasuredPair | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMeasured(pairContrast(fg, bg, over)));
    return () => cancelAnimationFrame(frame);
  }, [fg, bg, over, version]);
  const passes = measured !== null && measured.ratio >= min;
  const surface = `var(--${over ?? 'background'})`;
  // Documented exception to role tokens only (see ./README.md, with accent-choice.tsx): the inline
  // style carries the live measured colours, which are the thing this row exists to show.
  const swatch = {
    backgroundColor: surface,
    backgroundImage: measured
      ? `linear-gradient(${measured.background}, ${measured.background})`
      : undefined,
  };

  return (
    <li className="flex items-center gap-3 rounded-control border p-2">
      {min < 4.5 ? (
        // A boundary pair: shown as a border, since it never carries text.
        <span
          aria-hidden
          className="size-10 shrink-0 rounded-control border-2"
          style={{ ...swatch, borderColor: measured?.foreground }}
        />
      ) : (
        <span
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-control border text-sm font-semibold"
          style={{ ...swatch, color: measured?.foreground }}
        >
          Aa
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">
          {fg} · {bg}
          {over ? ` / ${over}` : ''}
        </span>
        <span className="text-xs text-muted-foreground">{t('design.pair.atLeast', { min })}</span>
      </span>
      <span className="flex items-center gap-1">
        {measured !== null &&
          (passes ? (
            <CheckIcon aria-hidden className="size-4 text-success" />
          ) : (
            <XIcon aria-hidden className="size-4 text-destructive" />
          ))}
        <span
          className={passes ? 'text-success tabular-nums' : 'text-destructive tabular-nums'}
          data-testid={pairTestId(pair)}
        >
          {measured === null
            ? '…'
            : `${measured.ratio.toFixed(2)}:1 ${passes ? t('design.pair.meets') : t('design.pair.fails')}`}
        </span>
      </span>
    </li>
  );
}
