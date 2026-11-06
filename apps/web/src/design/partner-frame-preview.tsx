import type { CoreLanguage } from '@ssdashboard/i18n';
import { PartnerFrame } from '@ssdashboard/ui/frames/partner-frame';
import { deriveBrandTokens } from '@ssdashboard/ui/lib/brand-tokens';
import { OtherLanguageLink } from '@/i18n/other-language-link';
import { PREVIEW_COPY, SAMPLE_BRAND_ACCENT, SAMPLE_LOGO_URL } from './frame-preview-copy';

/** Distinct sample hrefs, because the frame keys its tabs by href. */
const TAB_IDS = ['statements', 'stock', 'settlement'] as const;

/**
 * Development only sample of `PartnerFrame` (spec 0003, AC-18) shown in an `<iframe>` on `/design`:
 * the sample brand, a partner name, and the three tabs the partner area will have (statements,
 * stock at your location, settlement). It must never render in production or call an api.
 */
export function PartnerFramePreview({ language }: { language: CoreLanguage }) {
  const copy = PREVIEW_COPY[language];
  const result = deriveBrandTokens(SAMPLE_BRAND_ACCENT);
  const tokens = result.accepted ? { fill: result.fill, foreground: result.foreground } : undefined;

  return (
    <PartnerFrame
      brand={{ name: copy.brandName, logoUrl: SAMPLE_LOGO_URL, tokens }}
      partnerName={copy.partnerName}
      title={copy.partnerTitle}
      navLabel={copy.navLabel}
      navItems={copy.tabs.map((label, index) => ({
        label,
        href: `#${TAB_IDS[index]}`,
        current: index === 0,
      }))}
      actions={<OtherLanguageLink language={language} path="/partner/preview" />}
    >
      <p className="text-muted-foreground">{copy.partnerBody}</p>
    </PartnerFrame>
  );
}
