import type { SettingEntryView } from '@ssdashboard/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { modulesAnswer, stateView } from '@/shell/module-fixtures';
import { moduleKeys } from '@/shell/module-states-api';
import { renderWithQuery } from '@/shared/render-with-query';
import { ModuleSwitchSection } from './module-switch-section';

const settings = vi.hoisted(() => ({ getOffImpact: vi.fn(), putSetting: vi.fn() }));
vi.mock('./settings-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...settings,
}));

const modules = vi.hoisted(() => ({ getModuleStates: vi.fn() }));
vi.mock('@/shell/module-states-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...modules,
}));

/** Fixture switches: no real module is toggleable yet, so they borrow two registry labels. */
const entry = (overrides: Partial<SettingEntryView>): SettingEntryView => ({
  key: 'module.catalog.enabled',
  group: 'modules',
  bundle: 'core',
  label: 'modules.catalog.label',
  description: 'modules.catalog.description',
  warning: null,
  confirm: null,
  reason: 'required',
  value: true,
  default: true,
  isDefault: true,
  invalid: false,
  updatedAt: '2026-11-07T10:15:30.123456Z',
  updatedBy: null,
  canChange: true,
  licensed: true,
  ...overrides,
});

afterEach(() => {
  settings.getOffImpact.mockReset();
  settings.putSetting.mockReset();
  modules.getModuleStates.mockReset();
});

describe('ModuleSwitchSection (spec 0009, AC-12, AC-25)', () => {
  it('draws nothing while no module is toggleable', () => {
    modules.getModuleStates.mockResolvedValue(modulesAnswer());
    const { container } = renderWithQuery(<ModuleSwitchSection entries={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each switch with its effective state, reason and date', async () => {
    modules.getModuleStates.mockResolvedValue(
      modulesAnswer({
        modules: [
          stateView({
            key: 'inventory',
            state: 'read_only',
            since: '2026-11-01T22:00:00.000Z',
            reason: 'lapsed',
          }),
          stateView({ key: 'catalog' }),
        ],
      }),
    );
    renderWithQuery(
      <ModuleSwitchSection
        entries={[
          entry({}),
          entry({
            key: 'module.inventory.enabled',
            label: 'modules.inventory.label',
            description: 'modules.inventory.description',
            bundle: 'warehouse',
          }),
        ]}
      />,
    );

    const section = await screen.findByRole('list', { name: 'Module switches' });
    expect(screen.getByRole('heading', { level: 3, name: 'Module switches' })).toBeVisible();
    const rows = within(section).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(section).getAllByRole('heading', { level: 4 })).toHaveLength(2);
    expect(await within(rows[1]!).findByText('Read only')).toBeVisible();
    expect(rows[1]).toHaveTextContent('Its license has ended.');
    expect(rows[1]).toHaveTextContent(/Since .*2026/);
    expect(within(rows[0]!).getByText('On')).toBeVisible();
    expect(within(section).getByRole('button', { name: 'Turn off Stock' })).toBeEnabled();
  });

  it('disables a switch that is not licensed and says which plan it needs', async () => {
    modules.getModuleStates.mockResolvedValue(modulesAnswer());
    renderWithQuery(
      <ModuleSwitchSection entries={[entry({ bundle: 'operations', licensed: false })]} />,
    );
    expect(await screen.findByRole('button', { name: 'Turn off Catalog' })).toBeDisabled();
    expect(screen.getByText('Needs the Operations plan')).toBeVisible();
  });

  it('opens the off dialog for a switch that is on, and returns focus to its button on cancel', async () => {
    modules.getModuleStates.mockResolvedValue(modulesAnswer());
    settings.getOffImpact.mockResolvedValue({
      waitingCommands: [],
      inFlight: [],
      partnerStock: [],
      typedConfirmation: false,
    });
    renderWithQuery(<ModuleSwitchSection entries={[entry({})]} />);

    const button = await screen.findByRole('button', { name: 'Turn off Catalog' });
    await userEvent.click(button);
    expect(await screen.findByRole('dialog', { name: 'Turn off Catalog' })).toBeVisible();
    expect(settings.getOffImpact).toHaveBeenCalledWith('module.catalog.enabled', expect.anything());

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(button).toHaveFocus();
  });

  it('opens the change dialog started at true, and saves true, refreshing the module states', async () => {
    modules.getModuleStates.mockResolvedValue(modulesAnswer());
    settings.putSetting.mockResolvedValue({
      entry: entry({ value: true }),
      changed: true,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    render(
      <QueryClientProvider client={client}>
        <ModuleSwitchSection entries={[entry({ value: false, isDefault: false })]} />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Turn on Catalog' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change Catalog' });
    expect(settings.getOffImpact).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Needed again');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(settings.putSetting).toHaveBeenCalledExactlyOnceWith('module.catalog.enabled', {
        value: true,
        reason: 'Needed again',
        expectedUpdatedAt: '2026-11-07T10:15:30.123456Z',
      }),
    );
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: moduleKeys.all }));
  });

  it('words MODULE_REQUIRES with the required modules labels when turning one on, sending true', async () => {
    modules.getModuleStates.mockResolvedValue(modulesAnswer());
    settings.putSetting.mockRejectedValue(
      new ApiError(409, { code: 'MODULE_REQUIRES', requires: ['catalog', 'inventory'] }),
    );
    renderWithQuery(<ModuleSwitchSection entries={[entry({ value: false, isDefault: false })]} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Turn on Catalog' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change Catalog' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Reason/ }), 'Needed again');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'It cannot be turned on yet: it needs Catalog, Stock. Turn those on first.',
    );
    expect(settings.putSetting).toHaveBeenCalledWith(
      'module.catalog.enabled',
      expect.objectContaining({ value: true }),
    );
  });
});
