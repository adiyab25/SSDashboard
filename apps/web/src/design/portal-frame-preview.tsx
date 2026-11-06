import type { CoreLanguage } from '@ssdashboard/i18n';
import { Button } from '@ssdashboard/ui/components/button';
import { Input } from '@ssdashboard/ui/components/input';
import { PortalFrame } from '@ssdashboard/ui/frames/portal-frame';
import { deriveBrandTokens, type FrameBrand } from '@ssdashboard/ui/lib/brand-tokens';
import { OtherLanguageLink } from '@/i18n/other-language-link';
import {
  PREVIEW_COPY,
  REJECTED_BRAND_ACCENT,
  SAMPLE_BRAND_ACCENT,
  SAMPLE_LOGO_URL,
} from './frame-preview-copy';

/**
 * Development only sample of `PortalFrame` (spec 0003, AC-18, AC-19) shown in an `<iframe>` on
 * `/design`. `brand` carries the accepted sample green and a logo; `rejected` runs a refused
 * accent through `deriveBrandTokens`, passes no tokens (the neutral primary), and prints the
 * refusal reason and suggestion. It must never render in production or call an api.
 */
export function PortalFramePreview({
  language,
  sample,
}: {
  language: CoreLanguage;
  sample: 'brand' | 'rejected';
}) {
  const copy = PREVIEW_COPY[language];
  const accent = sample === 'brand' ? SAMPLE_BRAND_ACCENT : REJECTED_BRAND_ACCENT;
  const result = deriveBrandTokens(accent);
  const brand: FrameBrand = { name: copy.brandName };
  if (result.accepted) {
    brand.logoUrl = SAMPLE_LOGO_URL;
    brand.tokens = { fill: result.fill, foreground: result.foreground };
  }

  return (
    <PortalFrame
      brand={brand}
      title={sample === 'brand' ? copy.title : copy.rejectedTitle}
      languageSwitch={<OtherLanguageLink language={language} path={`/returns/preview/${sample}`} />}
    >
      {result.accepted ? null : (
        <p data-testid="brand-refusal" className="text-sm text-muted-foreground">
          {copy.refusal(
            accent,
            result.reason === 'contrast' ? result.ratio : 0,
            result.reason === 'contrast' ? result.suggestion : '',
          )}
        </p>
      )}
      <p className="text-muted-foreground">{copy.body}</p>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        {copy.orderLabel}
        <Input name="order" inputMode="numeric" autoComplete="off" />
      </label>
      <Button
        data-testid="brand-button"
        className="bg-brand text-brand-foreground hover:bg-brand/90"
      >
        {copy.action}
      </Button>
    </PortalFrame>
  );
}
