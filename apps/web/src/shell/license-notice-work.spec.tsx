import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { operationsNotice } from '@/settings/license-fixtures';
import { LicenseNoticeWork } from './license-notice-work';

const registry = vi.hoisted(() => ({ modules: [] as unknown[] }));
vi.mock('@ssdashboard/contracts', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  get MODULE_REGISTRY() {
    return registry.modules;
  },
}));

const capability = (
  key: string,
  windDown: string,
  label: string,
  bundle = 'operations',
  requiresOneOf?: string[],
) => ({ key, bundle, kind: 'write', windDown, workOf: [], label, requiresOneOf });
const moduleOf = (bundle: string, capabilities: unknown[]) => ({
  key: bundle,
  bundle,
  toggle: true,
  requires: [],
  label: 'modules.orders.label',
  description: 'modules.orders.description',
  capabilities,
});

// Real catalog labels: platformLicenseCheck = 'The daily license check', identityCleanup = 'The
// nightly sign in cleanup', inventoryReconcile = 'The nightly stock ledger check'.
const CHECK = 'modules.capabilities.platformLicenseCheck';
const CLEANUP = 'modules.capabilities.identityCleanup';
const LEDGER = 'modules.capabilities.inventoryReconcile';
const operations = moduleOf('operations', [
  capability('orders.confirmation_queue', 'none', CHECK),
  capability('settlement.carrier_close_out', 'pre_lapse', CLEANUP),
  capability('consignment.sales_ingestion', 'until_closed', LEDGER),
]);

const lapse = '15 April';

describe('LicenseNoticeWork (AC-17)', () => {
  it('draws nothing when no capability stops or continues', () => {
    registry.modules = [];
    const { container } = render(<LicenseNoticeWork notice={operationsNotice()} lapse={lapse} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names what stops and what continues until when, in English', () => {
    registry.modules = [operations];
    render(<LicenseNoticeWork notice={operationsNotice()} lapse={lapse} />);
    expect(screen.getByText('On 15 April this stops: The daily license check.')).toBeVisible();
    expect(
      screen.getByText(
        'Still continues: The nightly sign in cleanup (until 31 Jan 2027), The nightly stock ledger check (until its open items are closed).',
      ),
    ).toBeVisible();
  });

  // H1: once the plan is off, pre lapse work has ended with the wind down, so it stops.
  it('says stopped and keeps only open item work going once the plan is off', () => {
    registry.modules = [operations];
    render(<LicenseNoticeWork notice={operationsNotice({ phase: 'off' })} lapse={lapse} />);
    expect(
      screen.getByText('Stopped: The daily license check, The nightly sign in cleanup.'),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Still continues: The nightly stock ledger check (until its open items are closed).',
      ),
    ).toBeVisible();
  });

  it('says stopped, not will stop, once the plan is winding down', () => {
    registry.modules = [operations];
    render(<LicenseNoticeWork notice={operationsNotice({ phase: 'wind_down' })} lapse={lapse} />);
    expect(screen.getByText('Stopped: The daily license check.')).toBeVisible();
  });

  it('stops Warehouse pre lapse work too, since Warehouse has no wind down', () => {
    registry.modules = [
      moduleOf('warehouse', [
        capability('inventory.a', 'pre_lapse', CLEANUP, 'warehouse'),
        capability('inventory.b', 'until_closed', LEDGER, 'warehouse'),
      ]),
    ];
    render(
      <LicenseNoticeWork
        notice={operationsNotice({ bundle: 'warehouse', windDownEndsOn: null })}
        lapse={lapse}
      />,
    );
    expect(screen.getByText('On 15 April this stops: The nightly sign in cleanup.')).toBeVisible();
    expect(
      screen.getByText(
        'Still continues: The nightly stock ledger check (until its open items are closed).',
      ),
    ).toBeVisible();
  });

  it('names a capability of another bundle whose every source lapses with this bundle', () => {
    registry.modules = [
      moduleOf('operations', [capability('bosta.new', 'none', CHECK)]),
      moduleOf('warehouse', [
        capability('shopify.push', 'none', CLEANUP, 'warehouse', ['bosta.new']),
      ]),
    ];
    render(<LicenseNoticeWork notice={operationsNotice()} lapse={lapse} />);
    expect(
      screen.getByText(
        'On 15 April this stops: The daily license check, The nightly sign in cleanup.',
      ),
    ).toBeVisible();
  });

  it('words both parts in Arabic', () => {
    registry.modules = [operations];
    const i18n = createI18n({ language: 'ar', catalogs: { ar } });
    render(
      <I18nextProvider i18n={i18n}>
        <LicenseNoticeWork notice={operationsNotice()} lapse="15 أبريل 2027" />
      </I18nextProvider>,
    );
    expect(screen.getByText('في 15 أبريل 2027 يتوقف ما يلي: الفحص اليومي للترخيص.')).toBeVisible();
    const continues = screen.getByText(/^يستمر ما يلي: /);
    expect(continues).toHaveTextContent('التنظيف الليلي لبيانات تسجيل الدخول (حتى');
    expect(continues).toHaveTextContent('2027');
    expect(continues).toHaveTextContent(
      'المراجعة الليلية لدفتر المخزون (حتى إغلاق بنودها المفتوحة)',
    );
  });

  it('shows only the stopping part when nothing continues', () => {
    registry.modules = [moduleOf('operations', [capability('orders.q', 'none', CHECK)])];
    render(<LicenseNoticeWork notice={operationsNotice()} lapse={lapse} />);
    expect(screen.getByText(/this stops/)).toBeVisible();
    expect(screen.queryByText(/Still continues/)).toBeNull();
  });
});
