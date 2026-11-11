'use client';

import { useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

/** The two views of the customers screen. */
export type CustomersTab = 'search' | 'review';

const TABS: readonly CustomersTab[] = ['search', 'review'];

/** The id of the panel a tab controls. */
export const customersPanelId = (tab: CustomersTab) => `customers-panel-${tab}`;

/** The id of a tab button, so its panel can be labelled by it. */
export const customersTabId = (tab: CustomersTab) => `customers-tab-${tab}`;

interface Props {
  tab: CustomersTab;
  onTabChange: (tab: CustomersTab) => void;
  /** The text of the To review tab, which carries the open suggestion count. */
  reviewLabel: string;
}

/**
 * The Search and To review tabs of the customers screen (spec 0014, AC-9), built to the WAI-ARIA
 * tabs pattern with native buttons like the people screen: one tab stop, arrow keys move between
 * the tabs (the arrow toward the end follows the reading direction, so it flips in Arabic), Home
 * and End jump to the ends. It holds no state of its own; the page draws the panels.
 */
export function CustomersTabs({ tab, onTabChange, reviewLabel }: Props) {
  const { t, i18n } = useTranslation();
  const refs = useRef(new Map<CustomersTab, HTMLButtonElement>());
  const rtl = i18n.dir() === 'rtl';

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const index = TABS.indexOf(tab);
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next: number | null = null;
    if (event.key === forward) next = (index + 1) % TABS.length;
    else if (event.key === back) next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    const target = next === null ? undefined : TABS[next];
    if (!target) return;
    event.preventDefault();
    onTabChange(target);
    refs.current.get(target)?.focus();
  }

  return (
    <div role="tablist" aria-label={t('customers.tabs.label')} className="flex gap-1 border-b">
      {TABS.map((name) => {
        const selected = name === tab;
        return (
          <button
            key={name}
            ref={(node) => {
              if (node) refs.current.set(name, node);
              else refs.current.delete(name);
            }}
            id={customersTabId(name)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={customersPanelId(name)}
            tabIndex={selected ? 0 : -1}
            className={`-mb-px min-h-9 border-b-2 px-3 text-sm font-medium focus-ring coarse:min-h-touch ${
              selected
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => onTabChange(name)}
            onKeyDown={onKeyDown}
          >
            {name === 'review' ? reviewLabel : t('customers.tabs.search')}
          </button>
        );
      })}
    </div>
  );
}
