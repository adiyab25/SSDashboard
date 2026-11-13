'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { ContrastList } from './contrast-list';
import { ACCENT_OPTION_A_PAIRS, ACCENT_OPTION_B_PAIRS, CANDIDATE_ACCENT } from './design-pairs';

/** One sample row: a link, the owed text, the confirmed text, and muted text on whatever fill it gets. */
function sampleRow(
  className: string,
  texts: { link: string; owed: string; confirmed: string; muted: string },
) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-chip px-3 py-2 ${className}`}
    >
      <a href="/design" className="text-primary underline-offset-4 hover:underline focus-ring">
        {texts.link}
      </a>
      <span className="text-owed">{texts.owed}</span>
      <span className="text-confirmed">{texts.confirmed}</span>
      <span className="text-muted-foreground">{texts.muted}</span>
    </div>
  );
}

/**
 * The light theme accent choice the owner makes at the gate (spec 0025, AC-17): option A keeps
 * `accent` at #DCE5EE, which carries only `foreground` and `muted-foreground` text and leaves row
 * hover to the ink tint; option B lightens it to #E9EEF4 so a link and status text may sit on it.
 * Both are measured live. Option B is a candidate, not a token, so it is set as a local `--accent`
 * override on its own panel. This is a development only comparison for spec 0025, AC-17, and the
 * rows that fail on option A are expected to: they are the reason for the rule. It is only
 * meaningful in the light theme, so in dark it says so.
 */
export function AccentChoice({ version }: { version: number }) {
  const { t } = useTranslation();
  const [light, setLight] = useState(true);
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      setLight(!document.documentElement.classList.contains('dark')),
    );
    return () => cancelAnimationFrame(frame);
  }, [version]);

  if (!light) {
    return (
      <p className="text-muted-foreground" data-testid="accent-choice-dark">
        {t('design.accent.darkOnly')}
      </p>
    );
  }

  const texts = {
    link: t('design.accent.link'),
    owed: t('design.accent.owed'),
    confirmed: t('design.accent.confirmed'),
    muted: t('design.accent.muted'),
  };

  return (
    <div className="flex flex-col gap-4" data-testid="accent-choice">
      <p className="text-muted-foreground">{t('design.accent.intro')}</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <section
          aria-labelledby="accent-option-a"
          className="flex flex-col gap-3 rounded-card border bg-card p-4"
        >
          <h3 id="accent-option-a" className="font-semibold">
            {t('design.accent.optionA')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('design.accent.optionANote')}</p>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-4 rounded-chip bg-accent px-3 py-2">
              <span>{t('design.accent.plain')}</span>
              <span className="text-muted-foreground">{texts.muted}</span>
            </div>
            {sampleRow('tint-row', texts)}
          </div>
          <p className="text-xs text-muted-foreground">{t('design.accent.optionAPairs')}</p>
          <ContrastList
            single
            pairs={ACCENT_OPTION_A_PAIRS}
            version={version}
            label={t('design.accent.optionA')}
          />
        </section>
        <section
          aria-labelledby="accent-option-b"
          className="flex flex-col gap-3 rounded-card border bg-card p-4"
          // A dev only comparison for spec 0025, AC-17: the candidate is not a token yet, so it is
          // set as a local variable override here and nowhere else.
          style={{ '--accent': CANDIDATE_ACCENT } as CSSProperties}
        >
          <h3 id="accent-option-b" className="font-semibold">
            {t('design.accent.optionB')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('design.accent.optionBNote')}</p>
          <div className="flex flex-col gap-2">
            {sampleRow('bg-accent', texts)}
            {sampleRow('tint-row', texts)}
          </div>
          <p className="text-xs text-muted-foreground">{t('design.accent.optionBPairs')}</p>
          <ContrastList
            single
            pairs={ACCENT_OPTION_B_PAIRS}
            version={version}
            label={t('design.accent.optionB')}
          />
        </section>
      </div>
    </div>
  );
}
