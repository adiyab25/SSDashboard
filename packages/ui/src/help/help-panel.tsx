'use client';

import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@ssdashboard/ui/components/sheet';
import { StatusChip } from '../status/status-chip';
import type { StatusMeaning } from '../lib/status-meaning';

type HelpPanelGlossaryItem = {
  /** The meaning role of the real chip shown. */
  meaning: StatusMeaning;
  /** The chip word, exactly as the screen shows it. */
  chipLabel: string;
  /** What this outcome means, in one sentence. */
  description: string;
};

type HelpPanelSetting = {
  /** The already translated name of the setting ("Callback delay"). */
  label: string;
  /** The live value, already formatted by the app from settings ("2 hours"). */
  value: string;
};

type HelpPanelProps = {
  /** Controlled open state; the app owns it and opens it from a button and `useHelpShortcut`. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The sheet title, already translated ("How this screen works"). */
  title: string;
  /** One sentence under the title (optional). */
  description?: string;
  /** The accessible name of the close button. */
  closeLabel: string;
  /** The visible opener, such as a top bar button; focus returns to it on close (optional). */
  trigger?: ReactNode;
  /** The numbered steps, in order. */
  steps?: { heading: string; items: string[] };
  /** The outcomes on this screen, each drawn with its real `StatusChip`. */
  glossary?: { heading: string; items: HelpPanelGlossaryItem[] };
  /** The settings that change this screen's behaviour, already formatted from live values. */
  settings?: { heading: string; items: HelpPanelSetting[] };
  /** The training clip slot: a captioned video from the install's own storage. Empty by default. */
  trainingClip?: { heading: string; content: ReactNode };
  /** Extra content at the end, such as the "Show the first run checklist again" button. */
  footer?: ReactNode;
};

/**
 * The page guide (AC-21): a sheet from the start edge with a title, numbered steps, an outcome
 * glossary that shows each outcome's real chip, the live settings that change the behaviour, and
 * an optional training clip slot. A section with no content is not drawn, so the clip slot stays
 * empty until a brand records one (owner answer 7). It is controlled: pair it with
 * `useHelpShortcut` for the `?` key and a visible button. Esc closes it and focus returns to the
 * opener (the `trigger`, or the element that had focus when it opened). It must never hold the
 * only copy of an instruction, quote a policy number that is not passed in from settings, or hold
 * text of its own.
 */
export function HelpPanel({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  trigger,
  steps,
  glossary,
  settings,
  trainingClip,
  footer,
}: HelpPanelProps) {
  const id = useId();
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    // Radix returns focus only to a trigger; without one (the `?` key), remember who had it.
    if (open && document.activeElement instanceof HTMLElement) {
      opener.current = document.activeElement;
    }
  }, [open]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger ? <SheetTrigger asChild>{trigger}</SheetTrigger> : null}
      <SheetContent
        side="start"
        closeLabel={closeLabel}
        data-slot="help-panel"
        onCloseAutoFocus={(event) => {
          if (!trigger && opener.current?.isConnected) {
            event.preventDefault();
            opener.current.focus();
          }
        }}
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 pb-4">
          {steps && steps.items.length > 0 ? (
            <section aria-labelledby={`${id}-steps`}>
              <h3 id={`${id}-steps`} className="mb-2 text-sm font-medium">
                {steps.heading}
              </h3>
              <ol className="ms-5 list-decimal space-y-2 text-sm">
                {steps.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ol>
            </section>
          ) : null}
          {glossary && glossary.items.length > 0 ? (
            <section aria-labelledby={`${id}-glossary`}>
              <h3 id={`${id}-glossary`} className="mb-2 text-sm font-medium">
                {glossary.heading}
              </h3>
              <dl className="space-y-3 text-sm">
                {glossary.items.map((item) => (
                  <div key={item.chipLabel} className="flex flex-col items-start gap-1">
                    <dt>
                      <StatusChip meaning={item.meaning} label={item.chipLabel} />
                    </dt>
                    <dd className="text-muted-foreground">{item.description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          {settings && settings.items.length > 0 ? (
            <section aria-labelledby={`${id}-settings`}>
              <h3 id={`${id}-settings`} className="mb-2 text-sm font-medium">
                {settings.heading}
              </h3>
              <dl className="space-y-1 text-sm">
                {settings.items.map((item) => (
                  <div key={item.label} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{item.label}</dt>
                    <dd className="font-medium tabular-nums">{item.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          {trainingClip ? (
            <section aria-labelledby={`${id}-clip`}>
              <h3 id={`${id}-clip`} className="mb-2 text-sm font-medium">
                {trainingClip.heading}
              </h3>
              {trainingClip.content}
            </section>
          ) : null}
          {footer}
        </div>
      </SheetContent>
    </Sheet>
  );
}
