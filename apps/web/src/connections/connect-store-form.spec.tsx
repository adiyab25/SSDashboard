import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { renderWithQuery } from '@/shared/render-with-query';
import { ConnectStoreForm } from './connect-store-form';
import { ConnectStoreFormPage } from './connect-store-form-page';

const api = vi.hoisted(() => ({ connectShopify: vi.fn() }));
vi.mock('./connections-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const me = vi.hoisted((): { current: { id: string; hats: string[]; permissions: string[] } } => ({
  current: { id: 'a', hats: ['manager'], permissions: ['settings.manage'] },
}));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({ status: 'ready', me: me.current }),
}));

afterEach(() => {
  api.connectShopify.mockReset();
  push.mockReset();
  me.current = { id: 'a', hats: ['manager'], permissions: ['settings.manage'] };
});

const ID = '7f0d6e3a-1111-4111-8111-000000000001';

/** Types a full valid form in English. */
async function fillValid() {
  await userEvent.type(screen.getByLabelText(/^Name/), '  Pilot  ');
  await userEvent.type(screen.getByLabelText(/^Store code/), 'PILOT');
  await userEvent.type(screen.getByLabelText(/^Shop domain/), '  My-Brand.MyShopify.com ');
  await userEvent.type(screen.getByLabelText(/^Client id/), 'id-1234');
  await userEvent.type(screen.getByLabelText(/^Client secret/), 'shpss_secret');
}

describe('ConnectStoreForm (spec 0015, AC-1, AC-2)', () => {
  it('has one h1, a password secret field with autocomplete off, and explains the failing codes', () => {
    renderWithQuery(<ConnectStoreForm />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const secret = screen.getByLabelText(/^Client secret/);
    expect(secret).toHaveAttribute('type', 'password');
    expect(secret).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByText(/Never send them by message/)).toBeVisible();
    expect(
      screen.getByText(/not installed on this store, or the app and the store belong/),
    ).toBeVisible();
  });

  it('shows every error on submit after blurring from an empty field, and never on blur alone', async () => {
    renderWithQuery(<ConnectStoreForm />);

    await userEvent.click(screen.getByLabelText(/^Client id/));
    await userEvent.tab();
    expect(screen.getByLabelText(/^Client id/)).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.queryByText('Type the client id.')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Type the client id.')).toBeVisible();
    expect(screen.getByText('Type a name of up to 80 characters.')).toBeVisible();
    expect(screen.getByText(/Use 1 to 32 capital letters/)).toBeVisible();
    expect(screen.getByText(/Type the shop domain/)).toBeVisible();
    expect(screen.getByText('Type the client secret.')).toBeVisible();
    expect(api.connectShopify).not.toHaveBeenCalled();
  });

  it('refuses a bad store code and shop domain with the contract schema, and sends nothing', async () => {
    renderWithQuery(<ConnectStoreForm />);

    await userEvent.type(screen.getByLabelText(/^Name/), 'Pilot');
    await userEvent.type(screen.getByLabelText(/^Store code/), 'bad code');
    await userEvent.type(screen.getByLabelText(/^Shop domain/), 'example.com');
    await userEvent.type(screen.getByLabelText(/^Client id/), 'id');
    await userEvent.type(screen.getByLabelText(/^Client secret/), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText(/Use 1 to 32 capital letters/)).toBeVisible();
    expect(screen.getByText(/Type the shop domain/)).toBeVisible();
    expect(screen.getByLabelText(/^Store code/)).toHaveAttribute('aria-invalid', 'true');
    expect(api.connectShopify).not.toHaveBeenCalled();
  });

  it('sends exactly the contract body, clears the secret, and goes to the list', async () => {
    api.connectShopify.mockResolvedValue({ id: ID, health: 'connecting' });
    renderWithQuery(<ConnectStoreForm />);

    await fillValid();
    await userEvent.click(screen.getByLabelText('A person’s own Shopify account'));
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(api.connectShopify).toHaveBeenCalledWith({
        label: 'Pilot',
        storeCode: 'PILOT',
        shopDomain: 'my-brand.myshopify.com',
        clientId: 'id-1234',
        clientSecret: 'shpss_secret',
        appOwner: 'person',
      }),
    );
    expect(screen.getByLabelText(/^Client secret/)).toHaveValue('');
    await waitFor(() => expect(push).toHaveBeenCalledWith('/connections'));
  });

  it.each([
    ['SHOP_ALREADY_CONNECTED', 409, /This shop is already connected/, /^Shop domain/],
    ['STORE_CODE_TAKEN', 409, /This store code is already used/, /^Store code/],
    ['INVALID_SHOP_DOMAIN', 422, /This is not a shop domain/, /^Shop domain/],
  ] as const)(
    'shows %s in words on its field and clears the secret',
    async (code, status, text, field) => {
      api.connectShopify.mockRejectedValue(new ApiError(status, { code }));
      renderWithQuery(<ConnectStoreForm />);

      await fillValid();
      await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

      expect(await screen.findByText(text)).toBeVisible();
      expect(screen.getByLabelText(field)).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText(/^Client secret/)).toHaveValue('');
      expect(push).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['INVALID_BODY', 422, /Some of what you typed was not accepted/],
    ['FORBIDDEN', 403, /You may not connect stores/],
    ['SOMETHING_ELSE', 500, /could not be connected/],
  ] as const)('shows %s as an alert', async (code, status, text) => {
    api.connectShopify.mockRejectedValue(new ApiError(status, { code }));
    renderWithQuery(<ConnectStoreForm />);

    await fillValid();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('shows the no access state without settings.manage and renders no form', async () => {
    me.current = { id: 's', hats: ['support'], permissions: ['orders.view'] };
    renderWithQuery(<ConnectStoreFormPage />);

    expect(await screen.findByText('You do not have access to this page')).toBeVisible();
    expect(screen.queryByLabelText(/^Client secret/)).not.toBeInTheDocument();
  });

  it('reads in Arabic, with right to left safe code fields', async () => {
    api.connectShopify.mockRejectedValue(new ApiError(409, { code: 'STORE_CODE_TAKEN' }));
    const i18n = createI18n({ language: 'ar', catalogs: { ar } });
    const ui: ReactElement = (
      <I18nextProvider i18n={i18n}>
        <ConnectStoreForm />
      </I18nextProvider>
    );
    renderWithQuery(ui);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('ربط متجر Shopify');
    const secret = screen.getByLabelText(/^سرّ العميل/);
    expect(secret).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/^نطاق المتجر/)).toHaveAttribute('dir', 'ltr');

    await userEvent.type(screen.getByLabelText(/^الاسم/), 'سيملي');
    await userEvent.type(screen.getByLabelText(/^رمز المتجر/), 'PILOT');
    await userEvent.type(screen.getByLabelText(/^نطاق المتجر/), 'my-brand.myshopify.com');
    await userEvent.type(screen.getByLabelText(/^معرّف العميل/), 'id-1');
    await userEvent.type(secret, 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'ربط' }));

    expect(await screen.findByText(/رمز المتجر هذا مستخدم بالفعل/)).toBeVisible();
    expect(secret).toHaveValue('');
  });
});
