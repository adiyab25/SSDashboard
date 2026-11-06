'use client';

import { useEffect, useState } from 'react';
import { tokenContrast } from './contrast';

/** A foreground and background role pair and the lowest contrast ratio it must reach. */
export interface ContrastPairSpec {
  fg: string;
  bg: string;
  min: number;
}

/** One pair's live contrast ratio, re-measured when the theme changes; passes or fails the minimum. */
export function ContrastPair({ fg, bg, min, version }: ContrastPairSpec & { version: number }) {
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
        {ratio === null ? '…' : `${ratio.toFixed(2)}:1 ${passes ? 'meets' : 'fails'}`}
      </span>
    </li>
  );
}
