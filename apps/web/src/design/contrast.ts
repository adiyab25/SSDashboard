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
