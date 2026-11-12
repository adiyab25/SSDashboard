import { describe, expect, it } from 'vitest';
import {
  channelBarcodeOf,
  channelSkuLockKey,
  channelSkuOf,
  channelStyleLockKey,
  INVALID_BARCODE,
  isValidSku,
  moneyText,
  nameLanguageOf,
  optionValuesKey,
  styleCodeFromHandle,
} from './channel-rules.js';

// Spec 0012 milestone 4: the pure rules of the channel upsert contract (AC-14, AC-15).
describe('channel rules (spec 0012, channel upsert contract)', () => {
  it('shapes a style code from the handle: uppercased, other characters to -, 60 long, suffixed on a clash', () => {
    expect(styleCodeFromHandle('round-tee')).toBe('ROUND-TEE');
    expect(styleCodeFromHandle(' summer tee/2027 ')).toBe('SUMMER-TEE-2027');
    expect(styleCodeFromHandle('a'.repeat(80))).toBe('A'.repeat(60));
    expect(styleCodeFromHandle('a'.repeat(80), 3)).toBe(`${'A'.repeat(60)}-3`);
    expect(styleCodeFromHandle('tee', 2)).toBe('TEE-2');
  });

  it('falls back to the first SKU code when the handle keeps no letter or digit (Q-12.1)', () => {
    expect(styleCodeFromHandle('قميص', 1, 'TEE-BLK-S')).toBe('TEE-BLK-S');
    expect(styleCodeFromHandle('---', 2, 'tee-blk-s')).toBe('TEE-BLK-S-2');
    expect(styleCodeFromHandle('قميص-2027', 1, 'TEE')).toBe('-----2027');
    expect(styleCodeFromHandle('قميص')).toBe('STYLE');
  });

  it('keeps every suffixed code within the code pattern, cutting the base to fit', () => {
    for (const attempt of [1, 2, 9, 10, 99, 100, 999, 1000]) {
      const code = styleCodeFromHandle('a'.repeat(80), attempt);
      expect(code.length).toBeLessThanOrEqual(64);
      expect(isValidSku(code)).toBe(true);
      expect(code.endsWith(attempt > 1 ? `-${attempt}` : 'A')).toBe(true);
    }
    expect(styleCodeFromHandle('a'.repeat(80), 1000)).toBe(`${'A'.repeat(59)}-1000`);
    expect(styleCodeFromHandle('a'.repeat(80), 10)).toBe(`${'A'.repeat(60)}-10`);
  });

  it('case maps only ASCII, so a Unicode letter never folds onto another code (review L2)', () => {
    expect(styleCodeFromHandle('ſku-1')).toBe('-KU-1');
    expect(channelStyleLockKey('İD')).toBe('catalog.channel_style:İd');
    expect(channelSkuOf('ſku-1')).toBe('ſku-1');
    expect(isValidSku(channelSkuOf('ſku-1') ?? '')).toBe(false);
    expect(channelSkuOf('ıd')).toBe('ıd');
    expect(channelBarcodeOf('ﬀ1')).toBe(INVALID_BARCODE);
    expect(channelBarcodeOf('ſ1')).toBe(INVALID_BARCODE);
    expect(channelSkuLockKey('TEE-1')).toBe('catalog.channel_sku:TEE-1');
  });

  it('keys the advisory lock on the trimmed, lowercased handle', () => {
    expect(channelStyleLockKey(' Round-Tee ')).toBe('catalog.channel_style:round-tee');
  });

  it('writes the Arabic slot only for a title with an Arabic letter', () => {
    expect(nameLanguageOf('Round Tee')).toBe('en');
    expect(nameLanguageOf('قميص أسود')).toBe('ar');
    expect(nameLanguageOf('Tee قميص')).toBe('ar');
    expect(nameLanguageOf('Tee ٢٠٢٧')).toBe('en');
  });

  it('matches SKUs trimmed and uppercased, blank as none', () => {
    expect(channelSkuOf(' tee-blk-m ')).toBe('TEE-BLK-M');
    expect(channelSkuOf('   ')).toBeNull();
    expect(channelSkuOf(null)).toBeNull();
    expect(isValidSku('TEE-BLK-M')).toBe(true);
    expect(isValidSku('TEE BLK')).toBe(false);
  });

  it('shapes a channel barcode like a typed one, and flags one that fails the pattern', () => {
    expect(channelBarcodeOf(' 622ab ')).toBe('622AB');
    expect(channelBarcodeOf('٦٢٢')).toBe('622');
    expect(channelBarcodeOf('')).toBeNull();
    expect(channelBarcodeOf(null)).toBeNull();
    expect(channelBarcodeOf('62 22')).toBe(INVALID_BARCODE);
  });

  it('prints amounts as numeric(14,2) does, so equal prices compare equal', () => {
    expect(moneyText('250')).toBe('250.00');
    expect(moneyText('250.5')).toBe('250.50');
    expect(moneyText('0250.50')).toBe('250.50');
    expect(moneyText(null)).toBeNull();
  });

  it('compares option values regardless of key order', () => {
    expect(optionValuesKey({ '1': 0, '0': 2 })).toBe(optionValuesKey({ '0': 2, '1': 0 }));
    expect(optionValuesKey({ '0': 1 })).not.toBe(optionValuesKey({ '0': 2 }));
  });
});
