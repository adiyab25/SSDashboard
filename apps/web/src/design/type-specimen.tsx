'use client';

import { LtrText } from '@ssdashboard/ui/components/ltr-text';
import { useTranslation } from 'react-i18next';

/** The sizes of the type scale: classes and the written spec, which stay as in DESIGN.md. */
const TYPE_SCALE = [
  { key: 'pageTitle', className: 'text-xl font-semibold', spec: '20px / 28px · 600' },
  { key: 'sectionTitle', className: 'text-base font-semibold', spec: '17px / 25.5px · 600' },
  { key: 'body', className: 'text-sm', spec: '15px / 22.5px · 400' },
  { key: 'label', className: 'text-sm font-medium', spec: '15px / 22.5px · 500' },
  { key: 'secondary', className: 'text-xs text-muted-foreground', spec: '12px / 16px · 400' },
] as const;

/**
 * Geist and Geist Mono specimens: the type scale, tabular figures, the page heading blend (a
 * plain paragraph here, because the page has exactly one `h1`), the `//` section label, the
 * lowercase mono table header, codes in `LtrText`, and the Arabic face.
 */
export function TypeSpecimen() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-col gap-3">
        {TYPE_SCALE.map((step) => (
          <li key={step.key} className="flex flex-wrap items-baseline gap-x-4">
            <span className={step.className}>
              {t(`design.type.${step.key}`)}: {t('design.type.sample')}
            </span>
            <span className="text-xs text-muted-foreground">{step.spec}</span>
          </li>
        ))}
        <li className="tabular-nums">{t('design.type.tabular')}: 1,204.50 · 98.00 · 11,111.11</li>
      </ul>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-card border bg-card p-4">
          <p className="gradient-heading w-fit text-xl font-semibold tracking-[-0.03em] rtl:tracking-normal">
            {t('design.type.headingBlend')}
          </p>
          <span className="text-xs text-muted-foreground">{t('design.type.headingNote')}</span>
        </div>
        <div className="flex flex-col gap-2 rounded-card border bg-card p-4">
          <span className="section-label">{t('design.type.sectionLabelText')}</span>
          <span className="text-xs text-muted-foreground">{t('design.type.sectionLabelNote')}</span>
        </div>
        <div className="flex flex-col gap-2 rounded-card border bg-card p-4">
          <span className="table-head-look bg-muted px-2 py-1">
            {t('design.type.tableHeadText')}
          </span>
          <span className="text-xs text-muted-foreground">{t('design.type.tableHeadNote')}</span>
        </div>
        <div className="flex flex-col gap-1 rounded-card border bg-card p-4">
          <LtrText className="font-mono text-sm">
            SKU-0042 · 6223001234567 · const total = 1204.5;
          </LtrText>
          <span className="text-xs text-muted-foreground">{t('design.type.codeNote')}</span>
        </div>
      </div>
      <div lang="ar" dir="rtl" className="flex flex-col gap-1 rounded-card border p-4">
        <p className="text-base font-semibold">استلام ٢٤ طاولة من خشب البلوط</p>
        <p className="text-sm">
          نص تجريبي بخط Noto Sans Arabic لعرض شكل الحروف والمسافات بين الأسطر.
        </p>
      </div>
    </div>
  );
}
