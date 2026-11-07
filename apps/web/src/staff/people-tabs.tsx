'use client';

import { useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

/** The two lists of the people screen. */
export type PeopleTab = 'staff' | 'partners';

const TABS: readonly PeopleTab[] = ['staff', 'partners'];

/** The id of the panel a tab controls, so the page can label it: one panel for each tab. */
export const peoplePanelId = (tab: PeopleTab) => `people-panel-${tab}`;

/** The id of a tab button, so the panel can be labelled by it. */
export const peopleTabId = (tab: PeopleTab) => `people-tab-${tab}`;

interface Props {
  tab: PeopleTab;
  onTabChange: (tab: PeopleTab) => void;
}

/**
 * The Staff and Partner logins tabs of the people screen (spec 0008, AC-15, AC-18), built to the
 * WAI-ARIA tabs pattern with native buttons: one tab stop, arrow keys move between the tabs (the
 * arrow that points toward the end follows the reading direction, so it flips in Arabic), Home
 * and End jump to the first and the last. The page draws the one panel the selected tab
 * controls. It holds no state of its own.
 */
export function PeopleTabs({ tab, onTabChange }: Props) {
  const { t, i18n } = useTranslation();
  const refs = useRef(new Map<PeopleTab, HTMLButtonElement>());
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
    <div role="tablist" aria-label={t('staff.tabs.label')} className="flex gap-1 border-b">
      {TABS.map((name) => {
        const selected = name === tab;
        return (
          <button
            key={name}
            ref={(node) => {
              if (node) refs.current.set(name, node);
              else refs.current.delete(name);
            }}
            id={peopleTabId(name)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={peoplePanelId(name)}
            tabIndex={selected ? 0 : -1}
            className={`-mb-px min-h-9 border-b-2 px-3 text-sm font-medium focus-ring coarse:min-h-touch ${
              selected
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => onTabChange(name)}
            onKeyDown={onKeyDown}
          >
            {t(`staff.tabs.${name}`)}
          </button>
        );
      })}
    </div>
  );
}
