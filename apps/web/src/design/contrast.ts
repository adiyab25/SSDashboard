/** WCAG 2 contrast ratio of two sRGB colors (0 to 255 channels). */
export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const luminance = (rgb: readonly number[]) => {
    const [r = 0, g = 0, bl = 0] = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/**
 * The sRGB pixel of a token painted over another, read back from a 1 by 1 canvas. This
 * resolves `oklch()` values and composites translucent tokens over their background.
 */
export function paintedColor(token: string, over: string): number[] {
  const probe = document.createElement('span');
  document.body.append(probe);
  const resolve = (name: string) => {
    probe.style.color = `var(--${name})`;
    return getComputedStyle(probe).color;
  };
  const back = resolve(over);
  const front = resolve(token);
  probe.remove();

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [0, 0, 0];
  context.fillStyle = back;
  context.fillRect(0, 0, 1, 1);
  context.fillStyle = front;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

/** The live contrast of a token pair in the current theme. */
export function tokenContrast(foreground: string, background: string): number {
  return contrastRatio(
    paintedColor(foreground, background),
    paintedColor(background, 'background'),
  );
}

/** The two parts of a stop reference such as `stops-primary@2`: the variable and the stop index. */
const STOP_REFERENCE = /^([a-z-]+)@(\d+)$/;

/**
 * A colour reference as the gallery writes it: a role or any CSS variable name (`foreground`,
 * `tint-row`), a literal hex (`#E9EEF4`), or one stop of a gradient variable (`stops-primary@2`,
 * the third stop). Resolved to a CSS colour string in the live theme.
 */
export function resolveColor(reference: string): string {
  if (reference.startsWith('#')) return reference;
  const stop = STOP_REFERENCE.exec(reference);
  if (!stop) return `var(--${reference})`;
  const [, name = '', index = '0'] = stop;
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`);
  // Split on the commas outside parentheses, then keep the colour before the stop position.
  const entry = value.split(/,(?![^(]*\))/)[Number(index)]?.trim() ?? 'transparent';
  return entry.split(/\s+/)[0] ?? 'transparent';
}

/** Paints colours over each other on a 1 by 1 canvas and reads the sRGB result back. */
function paintStack(layers: readonly string[]): number[] {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return [0, 0, 0];
  for (const layer of layers) {
    context.fillStyle = layer;
    context.fillRect(0, 0, 1, 1);
  }
  return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

/** One measured pair: its ratio and the CSS colours it was measured from (for the swatch). */
export interface MeasuredPair {
  ratio: number;
  foreground: string;
  background: string;
}

/**
 * The live contrast of a foreground over a background that itself sits on a surface (`over`, the
 * page by default). Translucent backgrounds (tints) and foregrounds are composited first, so the
 * figure is what the eye gets. Colours go through a probe element so `var()` and `color-mix()`
 * come out as real sRGB.
 */
export function pairContrast(
  foreground: string,
  background: string,
  over: string = 'background',
): MeasuredPair {
  const probe = document.createElement('span');
  document.body.append(probe);
  const resolve = (reference: string) => {
    probe.style.color = '';
    probe.style.color = resolveColor(reference);
    return getComputedStyle(probe).color;
  };
  const surface = resolve(over);
  const back = resolve(background);
  const front = resolve(foreground);
  probe.remove();
  const backPixel = paintStack([surface, back]);
  const frontPixel = paintStack([surface, back, front]);
  return { ratio: contrastRatio(frontPixel, backPixel), foreground: front, background: back };
}

/** Any computed CSS colour as `#RRGGBB`, or `#RRGGBBAA` when it is translucent. */
export function toHex(css: string): string {
  const match = /rgba?\(([^)]+)\)/.exec(css);
  if (!match) return css;
  const parts = (match[1] ?? '').split(/[\s,/]+/).filter(Boolean);
  const channel = (value: string | undefined) =>
    Math.round(Number(value ?? 0))
      .toString(16)
      .padStart(2, '0');
  const alpha = parts[3] === undefined ? 1 : Number(parts[3]);
  const base = `#${channel(parts[0])}${channel(parts[1])}${channel(parts[2])}`;
  return (
    alpha >= 1
      ? base
      : `${base}${Math.round(alpha * 255)
          .toString(16)
          .padStart(2, '0')}`
  ).toUpperCase();
}
