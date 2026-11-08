import type { OwnerPolicyView } from '@ssdashboard/contracts';
import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { OwnerPolicySection } from './owner-policy-section';

const api = vi.hoisted(() => ({ listOwnerPolicies: vi.fn(), putOwnerPolicy: vi.fn() }));
vi.mock('./owner-policies-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

// Owner type values stay inside the policy service (spec 0002, A13; `owner-type-boundary.spec.ts`),
// and the screen never branches on one: it reads `lockedFields` and `activeLocations`. So these
// fixtures carry stand in types; a row's name is then its catalog key, which is what they assert.
const LOCKED_TYPE = 'fixture_locked' as OwnerPolicyView['ownerType'];
const OPEN_TYPE = 'fixture_open' as OwnerPolicyView['ownerType'];
const LOCKED_NAME = 'settings.ownerPolicies.types.fixture_locked';
const OPEN_NAME = 'settings.ownerPolicies.types.fixture_open';

const own: OwnerPolicyView = {
  ownerType: LOCKED_TYPE,
  stockOwnedByBrand: true,
  handoverIsSale: false,
  saleRecordedAt: 'at_shipment',
  endCustomerRefundBy: 'brand',
  defectivePieceRefundBy: 'brand',
  taxDocument: 'b2c_electronic_receipt',
  settlementOwnerType: null,
  canSellOnline: true,
  lockedFields: [
    'stockOwnedByBrand',
    'handoverIsSale',
    'saleRecordedAt',
    'taxDocument',
    'settlementOwnerType',
  ],
  activeLocations: 4,
  updatedAt: '2026-11-07T10:15:30.123456Z',
  updatedBy: null,
};

const consignment: OwnerPolicyView = {
  ownerType: OPEN_TYPE,
  stockOwnedByBrand: true,
  handoverIsSale: false,
  saleRecordedAt: 'at_sell_through',
  endCustomerRefundBy: 'location_owner',
  defectivePieceRefundBy: 'brand',
  taxDocument: 'b2b_electronic_invoice_at_settlement',
  settlementOwnerType: 'gateway',
  canSellOnline: false,
  lockedFields: [],
  activeLocations: 0,
  updatedAt: '2026-11-06T09:00:00.000000Z',
  updatedBy: { id: '00000000-0000-4000-8000-000000000001', name: 'Nour Admin' },
};

afterEach(() => {
  api.listOwnerPolicies.mockReset();
  api.putOwnerPolicy.mockReset();
});

async function openEdit(policy: OwnerPolicyView, name: string) {
  api.listOwnerPolicies.mockResolvedValue({ policies: [policy] });
  renderWithQuery(<OwnerPolicySection enabled />);
  await userEvent.click(await screen.findByRole('button', { name }));
  return screen.getByRole('dialog');
}

describe('OwnerPolicySection (spec 0009, AC-24, AC-25)', () => {
  it('says each row applies to every location of its type, and lists every answer', async () => {
    api.listOwnerPolicies.mockResolvedValue({ policies: [own, consignment] });
    renderWithQuery(<OwnerPolicySection enabled />);

    expect(screen.getByRole('heading', { level: 2, name: 'Location owner types' })).toBeVisible();
    expect(screen.getByText(/applies to every location of this type/)).toBeVisible();
    expect(screen.getByText(/that partner’s own agreement/)).toBeVisible();
    const rows = await screen.findAllByRole('listitem');
    expect(within(rows[1] as HTMLElement).getByText('When the partner sells it')).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText(/Last changed by Nour Admin/)).toBeVisible();
  });

  it('marks the locked fields and says why, from the locked fields and the open count', async () => {
    api.listOwnerPolicies.mockResolvedValue({
      policies: [own, { ...consignment, lockedFields: ['taxDocument'], activeLocations: 2 }],
    });
    renderWithQuery(<OwnerPolicySection enabled />);
    const rows = await screen.findAllByRole('listitem');
    expect(within(rows[0] as HTMLElement).getAllByText('Locked')).toHaveLength(5);
    expect(
      within(rows[0] as HTMLElement).getByText(/fixed for the brand’s own locations .*open now: 4/),
    ).toBeVisible();
    expect(within(rows[1] as HTMLElement).getAllByText('Locked')).toHaveLength(1);
    expect(within(rows[1] as HTMLElement).getByText(/open now: 2/)).toBeVisible();
  });

  it('shows the empty, error with retry, and no access states', async () => {
    api.listOwnerPolicies.mockResolvedValueOnce({ policies: [] });
    const first = renderWithQuery(<OwnerPolicySection enabled />);
    expect(await screen.findByText(/No location owner type is set up/)).toBeVisible();
    first.unmount();

    api.listOwnerPolicies.mockRejectedValueOnce(new ApiError(500, { code: 'generic' }));
    const second = renderWithQuery(<OwnerPolicySection enabled />);
    expect(await screen.findByText(/could not be loaded/)).toBeVisible();
    api.listOwnerPolicies.mockResolvedValue({ policies: [own] });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Edit/ })).toBeVisible();
    second.unmount();

    api.listOwnerPolicies.mockRejectedValue(new ApiError(403, { code: 'FORBIDDEN' }));
    renderWithQuery(<OwnerPolicySection enabled />);
    expect(await screen.findByText(/do not have permission to see/)).toBeVisible();
  });

  it('asks for nothing before access is known', () => {
    renderWithQuery(<OwnerPolicySection enabled={false} />);
    expect(api.listOwnerPolicies).not.toHaveBeenCalled();
  });
});

describe('the owner type edit dialog (AC-24)', () => {
  it('shows locked fields disabled with why, and sends the whole row with reason and updatedAt', async () => {
    api.putOwnerPolicy.mockResolvedValue({ policy: own, changed: true });
    const dialog = await openEdit(own, `Edit ${LOCKED_NAME}`);
    const stock = within(dialog).getByRole('radiogroup', { name: /Stock belongs to the brand/ });
    expect(within(stock).getByRole('radio', { name: 'Yes' })).toBeDisabled();
    expect(within(dialog).getAllByText(/fixed for the brand’s own locations/)).toHaveLength(1);
    expect(stock).toHaveAccessibleDescription(/fixed for the brand’s own locations/);

    const refund = within(dialog).getByRole('radiogroup', { name: 'A customer refund is paid by' });
    await userEvent.click(within(refund).getByRole('radio', { name: 'The location’s owner' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Say why you are making this change.')).toBeVisible();
    expect(api.putOwnerPolicy).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Partners refund now');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.putOwnerPolicy).toHaveBeenCalledWith(LOCKED_TYPE, {
        stockOwnedByBrand: true,
        handoverIsSale: false,
        saleRecordedAt: 'at_shipment',
        endCustomerRefundBy: 'location_owner',
        defectivePieceRefundBy: 'brand',
        taxDocument: 'b2c_electronic_receipt',
        settlementOwnerType: null,
        canSellOnline: true,
        reason: 'Partners refund now',
        expectedUpdatedAt: '2026-11-07T10:15:30.123456Z',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('words OWNER_POLICY_INCONSISTENT rule by rule and marks the fields they tie', async () => {
    api.putOwnerPolicy.mockRejectedValue(
      new ApiError(422, { code: 'OWNER_POLICY_INCONSISTENT', rules: ['online_needs_brand_stock'] }),
    );
    const dialog = await openEdit(consignment, `Edit ${OPEN_NAME}`);
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Try');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(
      'Only stock that belongs to the brand and is settled with nobody can sell online.',
    );
    for (const name of ['Can sell online', 'Stock belongs to the brand', 'Settled with']) {
      const group = within(dialog).getByRole('radiogroup', { name });
      expect(group).toHaveAttribute('aria-invalid', 'true');
      // A flagged group is described by the refusal, so a screen reader hears why.
      expect(group).toHaveAccessibleDescription(/settled with nobody can sell online/);
    }
    expect(within(dialog).getByRole('radiogroup', { name: 'Tax document' })).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('words the permanent settlement partner rule and marks only Settled with', async () => {
    api.putOwnerPolicy.mockRejectedValue(
      new ApiError(422, {
        code: 'OWNER_POLICY_INCONSISTENT',
        rules: ['consignment_settles_with_partner'],
      }),
    );
    const dialog = await openEdit(consignment, `Edit ${OPEN_NAME}`);
    const settled = within(dialog).getByRole('radiogroup', { name: 'Settled with' });
    await userEvent.click(within(settled).getByRole('radio', { name: 'Nobody' }));
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Try');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Consignment stock is always settled with the consignment partner.',
    );
    expect(api.putOwnerPolicy).toHaveBeenCalledWith(
      OPEN_TYPE,
      expect.objectContaining({ settlementOwnerType: null }),
    );
    expect(settled).toHaveAttribute('aria-invalid', 'true');
    expect(settled).toHaveAccessibleDescription(/always settled with the consignment partner/);
    for (const name of ['Can sell online', 'Stock belongs to the brand']) {
      expect(within(dialog).getByRole('radiogroup', { name })).not.toHaveAttribute(
        'aria-invalid',
        'true',
      );
    }
  });

  it('names the locked fields of OWNER_POLICY_IN_USE, and the selling locations of SELLABLE_LOCATIONS_EXIST', async () => {
    api.putOwnerPolicy.mockRejectedValueOnce(
      new ApiError(409, { code: 'OWNER_POLICY_IN_USE', fields: ['taxDocument'] }),
    );
    const dialog = await openEdit(consignment, `Edit ${OPEN_NAME}`);
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Try');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'locked while locations of this type are open: Tax document.',
    );

    api.putOwnerPolicy.mockRejectedValueOnce(
      new ApiError(409, { code: 'SELLABLE_LOCATIONS_EXIST' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/still sells online/),
    );
  });

  it('offers a reload on a stale answer', async () => {
    api.putOwnerPolicy.mockRejectedValue(new ApiError(409, { code: 'STALE_SETTING' }));
    const dialog = await openEdit(consignment, `Edit ${OPEN_NAME}`);
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Try');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('button', { name: 'Reload owner types' })).toBeVisible();
  });
});

describe('in Arabic', () => {
  it('reads the section and its answers', async () => {
    api.listOwnerPolicies.mockResolvedValue({ policies: [consignment] });
    const i18n = createI18n({ language: 'ar', catalogs: { ar } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <OwnerPolicySection enabled />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'أنواع مالكي المواقع' })).toBeVisible();
    expect(await screen.findByRole('heading', { level: 3, name: OPEN_NAME })).toBeVisible();
    expect(screen.getByText('بوابة الدفع')).toBeVisible();
    expect(screen.getByText('عندما يبيعها الشريك')).toBeVisible();
  });
});
