'use client';

import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useTranslation } from 'react-i18next';

/** One named sample tile: the utility name under the sample. */
const TILE = 'flex flex-col gap-2 rounded-card border bg-card p-4';

/** Every gradient and tint utility of spec 0025 drawn once, in the current theme and direction. */
export function GradientSamples() {
  const { t } = useTranslation();

  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <li className={TILE}>
        <span className="gradient-primary grid h-control place-items-center rounded-control border border-primary-edge font-semibold">
          {t('design.gradients.sampleAction')}
        </span>
        <LtrText className="text-xs text-muted-foreground">gradient-primary</LtrText>
      </li>
      <li className={TILE}>
        <span className="gradient-heading w-fit text-xl font-semibold">
          {t('design.gradients.sampleHeading')}
        </span>
        <LtrText className="text-xs text-muted-foreground">gradient-heading</LtrText>
      </li>
      <li className={TILE}>
        <span className="gradient-hero grid h-16 place-items-center rounded-card font-semibold">
          {t('design.gradients.sampleHero')}
        </span>
        <LtrText className="text-xs text-muted-foreground">gradient-hero</LtrText>
      </li>
      <li className={TILE}>
        <span className="gradient-card-edge grid h-16 place-items-center rounded-card">
          {t('design.gradients.sampleCard')}
        </span>
        <LtrText className="text-xs text-muted-foreground">gradient-card-edge</LtrText>
      </li>
      <li className={TILE}>
        <span className="gradient-secondary-edge grid h-control place-items-center rounded-control">
          {t('design.gradients.sampleSecondary')}
        </span>
        <LtrText className="text-xs text-muted-foreground">gradient-secondary-edge</LtrText>
      </li>
      <li className={TILE}>
        <span className="gradient-glow h-16 rounded-card border" aria-hidden />
        <LtrText className="text-xs text-muted-foreground">gradient-glow</LtrText>
      </li>
      <li className={TILE}>
        <span className="gradient-grid h-16 rounded-card border" aria-hidden />
        <LtrText className="text-xs text-muted-foreground">gradient-grid</LtrText>
      </li>
      <li className={TILE}>
        <span className="gradient-selected-row flex h-row items-center rounded-chip px-3">
          {t('design.gradients.sampleRow')}
        </span>
        <LtrText className="text-xs text-muted-foreground">gradient-selected-row</LtrText>
      </li>
      <li className={`${TILE} bg-sidebar`}>
        <span className="gradient-current-page relative flex h-nav-item items-center rounded-chip ps-3">
          <span
            aria-hidden
            className="gradient-current-marker absolute inset-y-0 start-0 w-0.5 rounded-full"
          />
          {t('design.gradients.sampleCurrent')}
        </span>
        <LtrText className="text-xs text-muted-foreground">
          gradient-current-page · gradient-current-marker
        </LtrText>
      </li>
      <li className={TILE}>
        <span className="tint-nav flex h-nav-item items-center rounded-chip px-3">
          {t('design.gradients.sampleNavHover')}
        </span>
        <span className="tint-row flex h-row items-center rounded-chip px-3">
          {t('design.gradients.sampleRowHover')}
        </span>
        <LtrText className="text-xs text-muted-foreground">tint-nav · tint-row</LtrText>
      </li>
    </ul>
  );
}
