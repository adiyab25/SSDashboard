import { useEffect, type RefObject } from 'react';

/**
 * Focuses the element once `active` is true and the page is showing. For a language other than
 * English the head script hides the body (`data-i18n="pending"`, `visibility: hidden`) until the
 * catalog is applied, and the browser does not focus a hidden element, so a screen that is ready on
 * the first render (a dead reset link) waits for the attribute to go before it takes focus.
 */
export function useFocusWhenShown(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const html = document.documentElement;
    if (!html.hasAttribute('data-i18n')) {
      ref.current?.focus();
      return;
    }
    const observer = new MutationObserver(() => {
      if (html.hasAttribute('data-i18n')) return;
      observer.disconnect();
      ref.current?.focus();
    });
    observer.observe(html, { attributes: true, attributeFilter: ['data-i18n'] });
    return () => observer.disconnect();
  }, [ref, active]);
}
