/** The white foreground a brand fill may carry. */
export const BRAND_LIGHT_FOREGROUND = '#FFFFFF';

/**
 * The near black foreground a brand fill may carry: the Daftar light `--foreground`,
 * `oklch(0.22 0.02 70)`, converted to sRGB (OKLab matrix, sRGB transfer, rounded).
 */
export const BRAND_DARK_FOREGROUND = '#211910';

/** The lowest contrast a brand fill and its foreground may have (WCAG 2.2 AA, normal text). */
export const BRAND_MIN_RATIO = 4.5;

/** The two values a frame sets inline as `--brand` and `--brand-foreground`. */
export type BrandTokens = {
  /** Fill for the logo tile, the top rule, and the main portal button, as `#RRGGBB`. */
  fill: string;
  /** Text and icon color on the fill, `#FFFFFF` or `#211910`. */
  foreground: string;
};

/** What `deriveBrandTokens` answers: the tokens and their ratio, or a rejection with a reason. */
export type BrandTokenResult =
  | { accepted: true; fill: string; foreground: string; ratio: number }
  | { accepted: false; reason: 'invalid' }
  | {
      accepted: false;
      reason: 'contrast';
      /** The better of the two ratios, below 4.5. */
      ratio: number;
      /** The nearest accepted fill (same hue and saturation, changed lightness), as `#RRGGBB`. */
      suggestion: string;
    };

/** The brand a portal or partner frame shows. All text comes from the app. */
export type FrameBrand = {
  /** The brand name, shown beside the logo and used as the logo `alt`. */
  name: string;
  /** The logo image URL; without it the tile shows the first letter of the name. */
  logoUrl?: string;
  /** Output of an accepted `deriveBrandTokens`; without it the frame keeps the neutral primary. */
  tokens?: BrandTokens;
};

/**
 * The inline style that carries a brand accent: `--brand` and `--brand-foreground` on the frame
 * root, so every descendant `bg-brand` picks them up. Without tokens it returns undefined, so no
 * override reaches the DOM and the defaults (the primary pair) apply.
 */
export function brandStyle(tokens: BrandTokens | undefined): Record<string, string> | undefined {
  if (!tokens) return undefined;
  return { '--brand': tokens.fill, '--brand-foreground': tokens.foreground };
}

type Rgb = readonly [number, number, number];

/** Parses `#RGB` or `#RRGGBB` (any case) into 0 to 255 channels, or null. */
function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  const digits = match?.[1];
  if (!digits) return null;
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((c) => c + c)
          .join('')
      : digits;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** Formats 0 to 255 channels as uppercase `#RRGGBB`. */
function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/** WCAG 2 relative luminance of 0 to 255 channels. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio of two colors. */
function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** RGB to HSL, hue in degrees, saturation and lightness 0 to 1. */
function toHsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

/** HSL back to 0 to 255 channels. */
function fromHsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const WHITE: Rgb = [255, 255, 255];
const DARK = parseHex(BRAND_DARK_FOREGROUND) ?? WHITE;

/** The better foreground for a fill and its ratio. Ties go to white. */
function best(fill: Rgb): { foreground: string; ratio: number } {
  const onWhite = contrast(fill, WHITE);
  const onDark = contrast(fill, DARK);
  return onWhite >= onDark
    ? { foreground: BRAND_LIGHT_FOREGROUND, ratio: onWhite }
    : { foreground: BRAND_DARK_FOREGROUND, ratio: onDark };
}

/** Rounds a ratio to two decimals for display and tests. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Turns a brand accent into the fill and foreground a portal or partner frame carries (AC-19).
 * The foreground is white or the near black `#211910`, whichever contrasts more (WCAG 2 relative
 * luminance); the pair is accepted at 4.5:1 or more. Otherwise the answer says `contrast` and
 * suggests the nearest accepted fill, found by moving only the HSL lightness in steps of 0.25
 * percent, trying darker then lighter at each distance and taking the first that passes, so hue
 * and saturation stay the brand's. Anything that is not `#RGB` or `#RRGGBB` answers `invalid`.
 * It never throws; callers pass no tokens (the neutral primary) on any rejection and must never
 * apply a rejected accent.
 */
export function deriveBrandTokens(accent: string): BrandTokenResult {
  const rgb = parseHex(accent);
  if (!rgb) return { accepted: false, reason: 'invalid' };

  const { foreground, ratio } = best(rgb);
  if (ratio >= BRAND_MIN_RATIO) {
    return { accepted: true, fill: toHex(rgb), foreground, ratio: round2(ratio) };
  }

  const [h, s, l] = toHsl(rgb);
  for (let step = 1; step <= 400; step += 1) {
    const delta = step * 0.0025;
    for (const next of [l - delta, l + delta]) {
      if (next < 0 || next > 1) continue;
      const candidate = fromHsl(h, s, next);
      if (best(candidate).ratio >= BRAND_MIN_RATIO) {
        return {
          accepted: false,
          reason: 'contrast',
          ratio: round2(ratio),
          suggestion: toHex(candidate),
        };
      }
    }
  }
  // Unreachable: black and white always pass. Kept so the type is total.
  return { accepted: false, reason: 'invalid' };
}
