import * as React from 'react';

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

const TEXT_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton']);

/** True when typing a character into this element means entering text, so `?` must stay a character. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return !NON_TEXT_INPUT_TYPES.has(target.type);
  }
  if (
    target.isContentEditable ||
    target.closest('[contenteditable]:not([contenteditable="false"])')
  ) {
    return true;
  }
  const role = target.getAttribute('role');
  return role !== null && TEXT_ROLES.has(role);
}

/**
 * Calls `onOpen` when the user presses `?` and focus is not in a text field, a text area, a
 * select, an editable element, or a combobox (AC-21). Ctrl, Cmd, and Alt combinations are
 * ignored; Shift is allowed because `?` needs it on most layouts. A key press another handler
 * already used (`defaultPrevented`) is ignored. It listens on `document` and removes the listener
 * on unmount; `enabled: false` turns it off (for example while the panel is already open). It
 * must never open anything itself, never swallow `?` while the user is typing, and never be the
 * only way to reach help: pair it with a visible button.
 */
export function useHelpShortcut(onOpen: () => void, enabled = true): void {
  const latest = React.useRef(onOpen);
  React.useEffect(() => {
    latest.current = onOpen;
  });

  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (event.defaultPrevented || event.isComposing || isTextEntry(event.target)) {
        return;
      }
      event.preventDefault();
      latest.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
