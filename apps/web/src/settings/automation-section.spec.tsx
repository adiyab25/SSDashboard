import type { SettingEntryView } from '@ssdashboard/contracts';
import { createI18n } from '@ssdashboard/i18n';
import { ar } from '@ssdashboard/i18n/ar';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { modulesAnswer, stateView } from '@/shell/module-fixtures';
import { renderWithQuery } from '@/shared/render-with-query';
import { AutomationSection } from './automation-section';

const api = vi.hoisted(() => ({ putSetting: vi.fn(), getOffImpact: vi.fn() }));
vi.mock('./settings-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const states = vi.hoisted(() => ({ getModuleStates: vi.fn() }));
vi.mock('@/shell/module-states-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...states,
}));

/**
 * A fixture executing step: no real step exists in production yet, so its label and description
 * are catalog keys we own (the turn on dialog reads the description as what the app starts doing).
 */
const step = (overrides: Partial<SettingEntryView>): SettingEntryView => ({
  key: 'step.fixture_send',
  group: 'automations',
  bundle: 'operations',
  label: 'modules.capabilities.mailSend',
  description: 'modules.mail.description',
  warning: null,
  confirm: null,
  reason: 'required',
  value: false,
  default: false,
  isDefault: true,
  invalid: false,
  updatedAt: null,
  updatedBy: null,
  canChange: true,
  licensed: true,
  step: {
    capability: 'fixturesteps.send',
    notifiesCustomer: true,
    turnOn: {
      ready: true,
      facts: [{ label: 'settings.modules.impact.partnerPieces_other', values: { pieces: 1200 } }],
    },
  },
  ...overrides,
});

const send = step({});
const push = step({
  key: 'step.fixture_push',
  bundle: 'warehouse',
  label: 'modules.inventory.label',
  description: 'modules.inventory.description',
  step: {
    capability: 'connectors.shopify.stock_push',
    notifiesCustomer: false,
    turnOn: { ready: false, precondition: 'NO_STOCK_OUT_SOURCE' },
  },
});
const running = step({
  key: 'step.fixture_on',
  label: 'modules.orders.label',
  description: 'modules.orders.description',
  value: true,
  isDefault: false,
  updatedAt: '2026-11-07T10:15:30.123456Z',
  updatedBy: { id: '00000000-0000-4000-8000-000000000001', name: 'Nour Admin' },
  step: {
    capability: 'fixturesteps.on',
    notifiesCustomer: false,
    turnOn: { ready: true, facts: [] },
  },
});

beforeEach(() => states.getModuleStates.mockResolvedValue(modulesAnswer()));

afterEach(() => {
  api.putSetting.mockReset();
  api.getOffImpact.mockReset();
  states.getModuleStates.mockReset();
});

describe('AutomationSection (spec 0009, AC-21, AC-25)', () => {
  it('shows the empty state while no step exists on this install', () => {
    renderWithQuery(<AutomationSection entries={[]} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Automations' })).toBeVisible();
    expect(screen.getByText(/No automation is available on this install yet/)).toBeVisible();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('lists each step with what it does, whether the customer hears, and its switch', () => {
    renderWithQuery(<AutomationSection entries={[send, running]} />);
    const rows = screen.getAllByRole('listitem');
    expect(
      within(rows[0] as HTMLElement).getByText('The customer hears about this.'),
    ).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText('Off')).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText('On')).toBeVisible();
    expect(
      within(rows[1] as HTMLElement).getByText('The customer is not messaged because of this.'),
    ).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText(/Last changed by Nour Admin/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Turn on Sending email' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Turn off Orders' })).toBeEnabled();
  });

  it('shows a step waiting on a stock out source as unavailable, in plain words (W9)', () => {
    renderWithQuery(<AutomationSection entries={[push]} />);
    expect(screen.getByText('Not available yet')).toBeVisible();
    expect(
      screen.getByText(
        'Waits for the app to see online orders leave stock: the Bosta connection (Operations plan), recording stock out from Shopify fulfillment, or packing in the app.',
      ),
    ).toBeVisible();
    expect(screen.getByText('Shopify will not email the customer.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Turn on Stock' })).toBeDisabled();
  });

  it('reads the waiting state from the capability too, when the list still said ready', async () => {
    states.getModuleStates.mockResolvedValue(
      modulesAnswer({
        capabilities: [
          stateView({
            key: 'fixturesteps.send',
            state: 'read_only',
            reason: 'no_stock_out_source',
          }),
        ],
      }),
    );
    renderWithQuery(<AutomationSection entries={[send]} />);
    expect(await screen.findByText(/Waits for the app to see online orders/)).toBeVisible();
  });

  it('says when a switched on step is not running, with the reason', async () => {
    states.getModuleStates.mockResolvedValue(
      modulesAnswer({
        capabilities: [stateView({ key: 'fixturesteps.on', state: 'off', reason: 'lapsed' })],
      }),
    );
    renderWithQuery(<AutomationSection entries={[running]} />);
    expect(await screen.findByText(/Switched on, but not running now\. Its license/)).toBeVisible();
  });

  it('disables an unlicensed step with the plan it needs', () => {
    renderWithQuery(<AutomationSection entries={[step({ licensed: false })]} />);
    expect(screen.getByText('Needs the Operations plan')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Turn on Sending email' })).toBeDisabled();
  });
});

describe('turning a step on (AC-21, AC-25)', () => {
  it('says what starts, whether the customer hears, that it acts from now on, and the facts', async () => {
    renderWithQuery(<AutomationSection entries={[send]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Turn on Sending email' }));
    const dialog = screen.getByRole('dialog', { name: 'Turn on Sending email' });
    expect(within(dialog).getByText('What the app starts doing')).toBeVisible();
    expect(within(dialog).getByText('The emails the app sends.')).toBeVisible();
    expect(within(dialog).getByText('The customer hears about this.')).toBeVisible();
    expect(within(dialog).getByText(/acts only on what happens from now on/)).toBeVisible();
    expect(within(dialog).getByText('1,200 pieces.')).toBeVisible();
  });

  it('works from the keyboard alone: needs a reason, then sends true with the shown updatedAt', async () => {
    api.putSetting.mockResolvedValue({ entry: { ...send, value: true }, changed: true });
    renderWithQuery(<AutomationSection entries={[send]} />);
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'Turn on Sending email' }).focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Turn on Sending email' });

    const confirm = within(dialog).getByRole('button', { name: 'Turn on' });
    confirm.focus();
    await user.keyboard('{Enter}');
    expect(await within(dialog).findByText('Say why you are making this change.')).toBeVisible();
    expect(within(dialog).getByLabelText(/^Reason/)).toHaveFocus();
    expect(api.putSetting).not.toHaveBeenCalled();

    await user.keyboard('Brand wants it');
    await user.tab();
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Turn on' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(api.putSetting).toHaveBeenCalledWith('step.fixture_send', {
        value: true,
        reason: 'Brand wants it',
        expectedUpdatedAt: null,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('words a 409 STEP_PRECONDITION from its code', async () => {
    api.putSetting.mockRejectedValue(
      new ApiError(409, {
        code: 'STEP_PRECONDITION',
        precondition: 'SHOPIFY_STOCK_PUSH_NOT_READY',
      }),
    );
    renderWithQuery(<AutomationSection entries={[send]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Turn on Sending email' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Go');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /a check it needs has not passed \(.*SHOPIFY_STOCK_PUSH_NOT_READY.*\)/,
    );
  });

  it('reads the list and the module states again after a 409 STEP_PRECONDITION', async () => {
    api.putSetting.mockRejectedValue(
      new ApiError(409, { code: 'STEP_PRECONDITION', precondition: 'NO_STOCK_OUT_SOURCE' }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    render(
      <QueryClientProvider client={client}>
        <AutomationSection entries={[send]} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Turn on Sending email' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Go');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Waits for the app/);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['settings'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['platform', 'modules'] });
  });

  it('shows the warning and needs the typed name where the registry asks for it', async () => {
    api.putSetting.mockResolvedValue({ entry: { ...send, value: true }, changed: true });
    const guarded = step({
      warning: 'settings.warnings.shopifyStockSafetyBuffer',
      confirm: 'typed',
    });
    renderWithQuery(<AutomationSection entries={[guarded]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Turn on Sending email' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/show as sold out on Shopify/)).toBeVisible();
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Go');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(
      await within(dialog).findByText('Type the name exactly as shown to confirm.'),
    ).toBeVisible();
    expect(within(dialog).getByLabelText(/Type “Sending email”/)).toHaveFocus();
    expect(api.putSetting).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByLabelText(/Type “Sending email”/), 'sending  EMAIL');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(api.putSetting).toHaveBeenCalledWith('step.fixture_send', {
        value: true,
        reason: 'Go',
        expectedUpdatedAt: null,
      }),
    );
  });

  it('says a step switched on while its capability is stopped waits until it runs (AC-21, S1)', async () => {
    states.getModuleStates.mockResolvedValue(
      modulesAnswer({
        capabilities: [
          stateView({ key: 'fixturesteps.send', state: 'read_only', reason: 'lapsed' }),
        ],
      }),
    );
    renderWithQuery(<AutomationSection entries={[send]} />);
    await waitFor(() => expect(states.getModuleStates).toHaveBeenCalled());
    await act(async () => {
      await states.getModuleStates.mock.results[0]?.value;
    });
    await userEvent.click(screen.getByRole('button', { name: 'Turn on Sending email' }));
    expect(
      within(screen.getByRole('dialog')).getByText(
        'It stays waiting until its work is running again. Its license has ended.',
      ),
    ).toBeVisible();
  });

  it('offers a reload on a stale answer', async () => {
    api.putSetting.mockRejectedValue(new ApiError(409, { code: 'STALE_SETTING' }));
    renderWithQuery(<AutomationSection entries={[send]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Turn on Sending email' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Go');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(await within(dialog).findByRole('button', { name: 'Reload settings' })).toBeVisible();
  });
});

describe('turning a step off (AC-21, AC-30)', () => {
  it('opens the off dialog with what it stops before it asks for the reason', async () => {
    api.getOffImpact.mockResolvedValue({
      waitingCommands: [{ kind: 'shopify.order_edit', count: 3 }],
      inFlight: [],
      partnerStock: [],
      typedConfirmation: false,
    });
    api.putSetting.mockResolvedValue({ entry: { ...running, value: false }, changed: true });
    renderWithQuery(<AutomationSection entries={[running]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Turn off Orders' }));
    const dialog = await screen.findByRole('dialog', { name: 'Turn off Orders' });
    expect(await within(dialog).findByText('Waiting requests that will fail')).toBeVisible();
    expect(api.getOffImpact).toHaveBeenCalledWith('step.fixture_on', expect.anything());

    await userEvent.type(within(dialog).getByLabelText(/^Reason/), 'Pause it');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() =>
      expect(api.putSetting).toHaveBeenCalledWith('step.fixture_on', {
        value: false,
        reason: 'Pause it',
        expectedUpdatedAt: '2026-11-07T10:15:30.123456Z',
      }),
    );
  });
});

describe('in Arabic', () => {
  it('reads the section, the unavailable words, and the turn on dialog', async () => {
    const i18n = createI18n({ language: 'ar', catalogs: { ar } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <AutomationSection entries={[push, send]} />
        </I18nextProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'الأتمتة' })).toBeVisible();
    expect(screen.getByText('غير متاحة بعد')).toBeVisible();
    expect(screen.getByText('لن يرسل شوبيفاي بريدًا إلى العميل.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'تشغيل إرسال البريد الإلكتروني' }));
    expect(within(screen.getByRole('dialog')).getByText('ما سيبدأ التطبيق في فعله')).toBeVisible();
  });
});
