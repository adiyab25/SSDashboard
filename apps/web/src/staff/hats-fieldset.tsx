'use client';

import type { StaffHat } from '@ssdashboard/contracts';
import { FieldError } from '@ssdashboard/ui/components/field';
import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { STAFF_HATS, inCatalogOrder } from './cost-prefill';

interface Props {
  /** Prefix of every id inside, so two dialogs never share one. */
  idPrefix: string;
  /** The hats ticked now. */
  hats: readonly StaffHat[];
  /** Called with the new ticked set, in catalog order. */
  onHatsChange: (hats: StaffHat[]) => void;
  /** Where the cost switch stands. */
  costView: boolean;
  /** Called when the person moves the cost switch by hand. */
  onCostViewChange: (costView: boolean) => void;
  /** False when the signed in person lacks `cost.view`: the switch is disabled and says why. */
  canChangeCost: boolean;
  /** The message under the hats, already translated (at least one hat), or null. */
  error: string | null;
  /** True while loading or saving. */
  disabled?: boolean;
  /** The first checkbox, focused when the hats are the first problem. */
  firstHatRef?: Ref<HTMLInputElement>;
}

/**
 * The hats and the cost switch of the people screen (spec 0008, AC-7 and AC-18), shared by the
 * add form and the edit hats dialog: one checkbox per staff hat with its plain description from
 * the catalog (`access.hats.<hat>`), never `partner`, then the `Sees cost` switch. It only shows
 * and reports choices; the caller owns the prefill (`startingCostView`), the rules, and the save.
 * It never offers the cost switch to a person who may not change it: disabled, with the reason.
 */
export function HatsFieldset({
  idPrefix,
  hats,
  onHatsChange,
  costView,
  onCostViewChange,
  canChangeCost,
  error,
  disabled = false,
  firstHatRef,
}: Props) {
  const { t } = useTranslation();
  const errorId = `${idPrefix}-hats-error`;
  const costHelpId = `${idPrefix}-cost-help`;
  const costLockedId = `${idPrefix}-cost-locked`;

  function toggle(hat: StaffHat, on: boolean) {
    const next = new Set(hats);
    if (on) next.add(hat);
    else next.delete(hat);
    onHatsChange(inCatalogOrder(next));
  }

  return (
    <div className="grid gap-4">
      <fieldset
        className="grid gap-3"
        data-invalid={error ? true : undefined}
        aria-describedby={error ? `${idPrefix}-hats-hint ${errorId}` : `${idPrefix}-hats-hint`}
      >
        <legend className="mb-1 flex gap-1 text-sm font-medium">
          {t('staff.hats.legend')}
          <span className="font-normal text-muted-foreground">({t('auth.required')})</span>
        </legend>
        <p id={`${idPrefix}-hats-hint`} className="-mt-2 text-xs text-muted-foreground">
          {t('staff.hats.hint')}
        </p>
        {STAFF_HATS.map((hat, index) => {
          const id = `${idPrefix}-hat-${hat}`;
          return (
            <div key={hat} className="flex items-start gap-3">
              <input
                ref={index === 0 ? firstHatRef : undefined}
                id={id}
                type="checkbox"
                className="mt-0.5 size-5 shrink-0 accent-primary focus-ring disabled:cursor-not-allowed"
                checked={hats.includes(hat)}
                disabled={disabled}
                aria-invalid={error ? true : undefined}
                aria-describedby={`${id}-description`}
                onChange={(event) => toggle(hat, event.target.checked)}
              />
              <div className="grid gap-0.5">
                <label htmlFor={id} className="text-sm font-medium">
                  {t(`access.hats.${hat}.name`)}
                </label>
                <p id={`${id}-description`} className="text-xs text-muted-foreground">
                  {t(`access.hats.${hat}.description`)}
                </p>
              </div>
            </div>
          );
        })}
        <FieldError id={errorId}>{error}</FieldError>
      </fieldset>

      <div className="flex items-start gap-3">
        <span className="relative mt-0.5 inline-flex shrink-0">
          <input
            id={`${idPrefix}-cost`}
            type="checkbox"
            role="switch"
            className="peer h-6 w-11 cursor-pointer appearance-none rounded-full bg-input transition-colors checked:bg-primary focus-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            checked={costView}
            disabled={disabled || !canChangeCost}
            aria-describedby={canChangeCost ? costHelpId : `${costHelpId} ${costLockedId}`}
            onChange={(event) => onCostViewChange(event.target.checked)}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute top-0.5 start-0.5 size-5 rounded-full bg-background shadow-sm transition-transform peer-checked:translate-x-5 peer-disabled:opacity-50 motion-reduce:transition-none rtl:peer-checked:-translate-x-5"
          />
        </span>
        <div className="grid gap-0.5">
          <label htmlFor={`${idPrefix}-cost`} className="text-sm font-medium">
            {t('staff.hats.costLabel')}
          </label>
          <p id={costHelpId} className="text-xs text-muted-foreground">
            {t('staff.hats.costHelp')}
          </p>
          {!canChangeCost && (
            <p id={costLockedId} className="text-xs text-muted-foreground">
              {t('staff.hats.costLocked')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
