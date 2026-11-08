import { describe, expect, it } from 'vitest';
import {
  displayValue,
  draftOf,
  isCodeKind,
  isEditedElsewhere,
  namesSetting,
  parseDraft,
  valueKindOf,
  type SettingWords,
} from './setting-value';

const words: SettingWords = {
  yes: 'Yes',
  no: 'No',
  notSet: 'Not set',
  none: 'None',
  hour: (hour) => `${hour}:00`,
  number: (value) => `#${value}`,
  date: (value) => `on ${value}`,
  riskSignal: ({ refusals, returns, days }) => `${refusals}/${returns} in ${days}`,
};

describe('valueKindOf', () => {
  it('reads the kind from the default', () => {
    expect(valueKindOf({ key: 'prices_include_vat', default: true })).toBe('boolean');
    expect(valueKindOf({ key: 'operations_wind_down_days', default: 60 })).toBe('number');
    expect(valueKindOf({ key: 'operating_day_cutoff_hour', default: 0 })).toBe('hour');
    expect(valueKindOf({ key: 'languages', default: ['en'] })).toBe('list');
    expect(valueKindOf({ key: 'inventory_lock_date', default: null })).toBe('date');
    expect(valueKindOf({ key: 'document_prefixes', default: { PO: 'PO' } })).toBe('record');
    expect(valueKindOf({ key: 'timezone', default: 'Africa/Cairo' })).toBe('text');
  });
});

describe('displayValue', () => {
  it('writes each shape in words', () => {
    expect(displayValue(true, 'boolean', words)).toBe('Yes');
    expect(displayValue(null, 'date', words)).toBe('Not set');
    expect(displayValue(3, 'hour', words)).toBe('03:00');
    expect(displayValue(60, 'number', words)).toBe('#60');
    expect(displayValue('2026-11-01', 'date', words)).toBe('on 2026-11-01');
    expect(displayValue(['en', 'ar'], 'list', words)).toBe('en, ar');
    expect(displayValue({ PO: 'PO', stock_receipt: 'SR' }, 'record', words)).toBe(
      'PO: PO, stock_receipt: SR',
    );
  });

  it('writes an empty list or map as a word, never a blank', () => {
    expect(displayValue({}, 'record', words)).toBe('None');
    expect(displayValue([], 'list', words)).toBe('None');
  });

  it('writes the customer risk signal from its three numbers, and reads a store id as a code', () => {
    const signal = { windowDays: 180, refusalsToSuggest: 2, returnsToSuggest: 3 };
    expect(displayValue(signal, 'riskSignal', words)).toBe('#2/#3 in #180');
    expect(valueKindOf({ key: 'customer_risk_signal', default: signal })).toBe('riskSignal');
    expect(valueKindOf({ key: 'catalog.source_store_id', default: null })).toBe('text');
    expect(isEditedElsewhere('shopify_gift_tags')).toBe(true);
    expect(isEditedElsewhere('customer_risk_signal')).toBe(false);
  });
});

describe('draftOf and parseDraft', () => {
  it('round trips a list, a number, a record, and a cleared date', () => {
    expect(parseDraft(draftOf(['en', 'ar'], 'list'), 'list')).toEqual({
      ok: true,
      value: ['en', 'ar'],
    });
    expect(parseDraft('90', 'number')).toEqual({ ok: true, value: 90 });
    expect(parseDraft('٣', 'hour')).toEqual({ ok: true, value: 3 });
    expect(parseDraft('٩٠', 'number')).toEqual({ ok: true, value: 90 });
    expect(parseDraft(draftOf({ PO: 'PO' }, 'record'), 'record')).toEqual({
      ok: true,
      value: { PO: 'PO' },
    });
    expect(parseDraft('', 'date')).toEqual({ ok: true, value: null });
  });

  it('refuses an empty or non numeric number and an empty text', () => {
    expect(parseDraft('', 'number')).toEqual({ ok: false });
    expect(parseDraft('abc', 'number')).toEqual({ ok: false });
    expect(parseDraft('1.5', 'number')).toEqual({ ok: false });
    expect(parseDraft('  ', 'text')).toEqual({ ok: false });
  });
});

describe('isCodeKind', () => {
  it('marks the kinds that must read left to right', () => {
    expect(isCodeKind('text')).toBe(true);
    expect(isCodeKind('list')).toBe(true);
    expect(isCodeKind('record')).toBe(true);
    expect(isCodeKind('boolean')).toBe(false);
    expect(isCodeKind('number')).toBe(false);
    expect(isCodeKind('date')).toBe(false);
  });
});

describe('namesSetting', () => {
  it('accepts the English name in any case and spacing', () => {
    expect(namesSetting('  prices  include vat ', 'Prices include VAT')).toBe(true);
    expect(namesSetting('Prices include VA', 'Prices include VAT')).toBe(false);
  });

  it('accepts an Arabic name with a different hamza, marks, or a stretched letter', () => {
    const name = 'الأسعار شاملة ضريبة القيمة المضافة';
    expect(namesSetting('الاسعار شاملة ضريبة القيمة المضافة', name)).toBe(true);
    expect(namesSetting('الإسعار شاملة ضريبة القيمة المضافة', name)).toBe(true);
    expect(namesSetting('الأسـعار شاملة ضريبة القيمة المضافة', name)).toBe(true);
    expect(namesSetting('الأسعار شاملة ضريبة القيمة', name)).toBe(false);
  });

  it('folds ة to ه and ى to ي, and keeps Arabic digits apart', () => {
    const name = 'الأسعار شاملة ضريبة القيمة المضافة';
    expect(namesSetting('الاسعار شاملة ضريبة القيمة المضافه', name)).toBe(true);
    expect(namesSetting('على', 'علي')).toBe(true);
    expect(namesSetting('٣', '٤')).toBe(false);
    expect(namesSetting('٣', '٣')).toBe(true);
  });
});
