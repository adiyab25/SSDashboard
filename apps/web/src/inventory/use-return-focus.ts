'use client';

import { useState } from 'react';

/**
 * For a dialog that is mounted with `open` and has no Radix trigger (WCAG 2.4.3): remembers the
 * control that had focus when the dialog mounted, and returns an `onCloseAutoFocus` handler for
 * `DialogContent` that hands focus back to it. When that control is gone (or nothing sensible had
 * focus), Radix's default applies.
 */
export function useReturnFocus() {
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' &&
    document.activeElement instanceof HTMLElement &&
    document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  return (event: Event) => {
    if (opener?.isConnected) {
      event.preventDefault();
      opener.focus();
    }
  };
}
