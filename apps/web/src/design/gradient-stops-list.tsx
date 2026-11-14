'use client';

import { useEffect, useState } from 'react';
import { ContrastList } from './contrast-list';
import type { ContrastPairSpec } from './contrast-pair';
import { STOP_GROUPS, TINT_PAIRS } from './design-pairs';

/** How many stops a gradient variable has in the current theme (light and dark differ). */
function stopCount(variable: string): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--${variable}`);
  return value.split(/,(?![^(]*\))/).filter((entry) => entry.trim() !== '').length;
}

/**
 * Every gradient stop that sits behind text, or is text, measured live on its own (spec 0025,
 * AC-3), then the tints painted over their surfaces. The stop lists are read from the theme, so
 * dark shows five main button stops and light three.
 */
export function GradientStopsList({ version, label }: { version: number; label: string }) {
  const [pairs, setPairs] = useState<readonly ContrastPairSpec[]>(TINT_PAIRS);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const stops: ContrastPairSpec[] = [];
      for (const group of STOP_GROUPS) {
        for (let index = 0; index < stopCount(group.variable); index += 1) {
          const stop = `${group.variable}@${index}`;
          if (group.kind === 'behind-text') {
            stops.push({
              fg: 'primary-foreground',
              bg: stop,
              min: 4.5,
              id: `${group.name}-stop-${index}`,
            });
          } else {
            for (const surface of ['background', 'card']) {
              stops.push({
                fg: stop,
                bg: surface,
                min: 3,
                id: `${group.name}-stop-${index}-on-${surface}`,
              });
            }
          }
        }
      }
      setPairs([...stops, ...TINT_PAIRS]);
    });
    return () => cancelAnimationFrame(frame);
  }, [version]);

  return <ContrastList pairs={pairs} version={version} label={label} />;
}
