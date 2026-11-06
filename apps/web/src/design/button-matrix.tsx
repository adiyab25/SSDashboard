'use client';

import { Button } from '@ssdashboard/ui/components/button';
import { Loader2Icon } from 'lucide-react';

const VARIANTS = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const;
const STATES = ['default', 'hover', 'focus', 'active', 'disabled', 'loading'] as const;

/** Every button variant in every state, for checking the focus ring and disabled look. */
export function ButtonMatrix() {
  return (
    // The table scrolls inside itself on a phone, so it is a named, focusable region (WCAG 2.1.1).
    <div
      role="region"
      aria-label="Button variants by state"
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="overflow-x-auto outline-none focus-ring-inset"
    >
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
