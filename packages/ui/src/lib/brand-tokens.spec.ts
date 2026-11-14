import { describe, expect, it } from 'vitest';
import { BRAND_DARK_FOREGROUND, deriveBrandTokens } from './brand-tokens';

describe('deriveBrandTokens', () => {
  it('accepts the sample green with white (5.31:1)', () => {
    const result = deriveBrandTokens('#0A7C39');
    expect(result).toMatchObject({ accepted: true, fill: '#0A7C39', foreground: '#FFFFFF' });
    if (result.accepted) expect(result.ratio).toBeCloseTo(5.31, 1);
  });

  it('accepts a yellow with the near black foreground (11.54:1)', () => {
    const result = deriveBrandTokens('#f2c230');
    expect(result).toMatchObject({
      accepted: true,
      fill: '#F2C230',
      foreground: BRAND_DARK_FOREGROUND,
    });
    if (result.accepted) expect(result.ratio).toBeCloseTo(11.54, 1);
  });

  it('reads the short form', () => {
    expect(deriveBrandTokens('#000')).toMatchObject({ accepted: true, fill: '#000000' });
  });

  it.each(['', 'green', '#12', '#12345', '#GGGGGG', '0A7C39', '#0A7C39FF'])(
    'rejects %j as invalid',
    (value) => {
      expect(deriveBrandTokens(value)).toEqual({ accepted: false, reason: 'invalid' });
    },
  );

  it.each([
    // Mid tone ochre: 4.36:1 with white, 4.43:1 with the near black.
    ['#997311', 4.43],
    // Mid grey: 4.35:1 with white, 4.44:1 with the near black.
    ['#797979', 4.44],
  ])(
    'rejects %s (best ratio %s, both foregrounds fail) with a passing suggestion',
    (accent, best) => {
      const result = deriveBrandTokens(accent);
      if (result.accepted || result.reason !== 'contrast') throw new Error('expected contrast');
      expect(result.ratio).toBeCloseTo(best, 1);
      expect(result.ratio).toBeLessThan(4.5);
      expect(deriveBrandTokens(result.suggestion).accepted).toBe(true);
    },
  );
});
