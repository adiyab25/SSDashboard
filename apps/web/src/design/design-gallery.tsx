'use client';

// Development only gallery (spec 0003, AC-11; spec 0025, AC-2, AC-3, AC-17). Its labels come from
// the `design.*` catalog keys; the sample data is invented. The order, phone, help, and frame
// sections below keep their own sample copy.

import { useTranslation } from 'react-i18next';
import { Basics } from './basics';
import { ButtonMatrix } from './button-matrix';
import { ContrastList } from './contrast-list';
import { DesignSection } from './design-section';
import { TEXT_AND_CONTROL_PAIRS } from './design-pairs';
import { FeedbackSamples } from './feedback-samples';
import { FieldStates } from './field-states';
import { FramesSection } from './frames-section';
import { GradientSamples } from './gradient-samples';
import { GradientStopsList } from './gradient-stops-list';
import { HelpSample } from './help-sample';
import { MotionSamples } from './motion-samples';
import { OrderStatusSection } from './order-status-section';
import { Overlays } from './overlays';
import { PaletteSample } from './palette-sample';
import { PaletteSwatches } from './palette-swatches';
import { RadiusAndDensity } from './radius-and-density';
import { RightToLeftRow } from './right-to-left-row';
import { StatusChipsSample } from './status-chips-sample';
import { TableSample } from './table-sample';
import { TableStatesSample } from './table-states-sample';
import { TypeSpecimen } from './type-specimen';
import { useThemeVersion } from './use-theme-version';

/** The development only page that shows every token and base component, live. */
export function DesignGallery() {
  const version = useThemeVersion();
  const { t } = useTranslation();

  return (
    <div data-gallery className="flex max-w-5xl flex-col gap-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">{t('design.title')}</h1>
          <p className="text-muted-foreground">{t('design.intro')}</p>
        </div>
      </header>

      <DesignSection id="palette" title={t('design.sections.palette')}>
        <PaletteSwatches version={version} label={t('design.sections.palette')} />
      </DesignSection>

      <DesignSection id="gradients" title={t('design.sections.gradients')}>
        <GradientSamples />
        <p className="text-muted-foreground">{t('design.gradients.stopsNote')}</p>
        <GradientStopsList version={version} label={t('design.gradients.stopsLabel')} />
      </DesignSection>

      <DesignSection id="colors" title={t('design.sections.contrast')}>
        <p className="text-muted-foreground">{t('design.contrastNote')}</p>
        <ContrastList
          pairs={TEXT_AND_CONTROL_PAIRS}
          version={version}
          label={t('design.sections.contrast')}
        />
      </DesignSection>

      <DesignSection id="type" title={t('design.sections.type')}>
        <TypeSpecimen />
      </DesignSection>

      <DesignSection id="spacing" title={t('design.sections.radius')}>
        <RadiusAndDensity />
      </DesignSection>

      <DesignSection id="motion" title={t('design.sections.motion')}>
        <MotionSamples />
      </DesignSection>

      <DesignSection id="buttons" title={t('design.sections.buttons')}>
        <ButtonMatrix />
      </DesignSection>

      <DesignSection id="fields" title={t('design.sections.fields')}>
        <FieldStates />
      </DesignSection>

      <DesignSection id="status" title={t('design.sections.status')}>
        <StatusChipsSample />
      </DesignSection>

      <DesignSection id="tables" title={t('design.sections.tables')}>
        <TableSample />
        <TableStatesSample />
      </DesignSection>

      <DesignSection id="overlays" title={t('design.sections.overlays')}>
        <Overlays />
      </DesignSection>

      <DesignSection id="command" title={t('design.sections.command')}>
        <PaletteSample />
      </DesignSection>

      <DesignSection id="feedback" title={t('design.sections.feedback')}>
        <FeedbackSamples />
      </DesignSection>

      <DesignSection id="basics" title={t('design.sections.basics')}>
        <Basics />
      </DesignSection>

      <DesignSection id="orders" title={t('design.sections.orders')}>
        <OrderStatusSection />
      </DesignSection>

      <DesignSection id="phone" title={t('design.sections.phone')}>
        <p className="text-muted-foreground">
          {t('design.phone.note')}{' '}
          <a className="text-primary underline focus-ring" href="/design/phone-dashboard">
            {t('design.phone.open')}
          </a>
        </p>
      </DesignSection>

      <DesignSection id="help" title={t('design.sections.help')}>
        <p className="text-muted-foreground">{t('design.help.note')}</p>
        <HelpSample />
      </DesignSection>

      <DesignSection id="frames" title={t('design.sections.frames')}>
        <FramesSection />
      </DesignSection>

      <DesignSection id="rtl" title={t('design.sections.rtl')}>
        <RightToLeftRow />
        <p className="text-muted-foreground">{t('design.rtlNote')}</p>
      </DesignSection>
    </div>
  );
}
