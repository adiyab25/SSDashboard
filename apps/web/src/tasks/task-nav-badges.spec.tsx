import { SidebarMenu, SidebarProvider } from '@ssdashboard/ui/components/sidebar';
import { TooltipProvider } from '@ssdashboard/ui/components/tooltip';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/shared/render-with-query';
import { MyWorkNavBadge } from './my-work-nav-badge';
import { UnsyncedEditsNavItem } from './unsynced-edits-nav-item';

const api = vi.hoisted(() => ({ getTaskSummary: vi.fn() }));
vi.mock('./tasks-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const me = vi.hoisted(() => ({ permissions: ['tasks.work', 'orders.confirm'] as string[] }));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({
    status: 'ready',
    me: { id: 'me', hats: ['support'], permissions: me.permissions },
  }),
}));

afterEach(() => {
  api.getTaskSummary.mockReset();
  me.permissions = ['tasks.work', 'orders.confirm'];
});

const summary = (overdue: number, unsyncedEdits?: number) => ({
  mine: { open: overdue + 1, overdue, dueToday: 0 },
  ...(unsyncedEdits === undefined ? {} : { unsyncedEdits }),
});

function renderBadges() {
  return renderWithQuery(
    <TooltipProvider>
      <SidebarProvider>
        <SidebarMenu>
          <li>
            <MyWorkNavBadge />
          </li>
          <UnsyncedEditsNavItem />
        </SidebarMenu>
      </SidebarProvider>
    </TooltipProvider>,
  );
}

describe('the task badges of the navigation (spec 0016, AC-7)', () => {
  it('shows the overdue count and the unsynced link to the hold filter', async () => {
    api.getTaskSummary.mockResolvedValue(summary(3, 2));
    renderBadges();

    expect(await screen.findByText('3 overdue tasks')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Edits not synced' });
    expect(link).toHaveAttribute('href', '/orders?hold=1');
    expect(screen.getByText('2 order edits not synced')).toBeInTheDocument();
  });

  it('shows no overdue badge at 0 and no unsynced link without unsyncedEdits', async () => {
    api.getTaskSummary.mockResolvedValue(summary(0));
    renderBadges();

    await vi.waitFor(() => expect(api.getTaskSummary).toHaveBeenCalled());
    expect(screen.queryByText(/overdue/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edits not synced' })).toBeNull();
  });

  it('shows no unsynced link when the count is 0', async () => {
    api.getTaskSummary.mockResolvedValue(summary(1, 0));
    renderBadges();

    expect(await screen.findByText('1 overdue task')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edits not synced' })).toBeNull();
  });

  it('shows neither and calls nothing for a person without tasks.work', async () => {
    me.permissions = ['orders.confirm'];
    api.getTaskSummary.mockResolvedValue(summary(3, 2));
    renderBadges();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.getTaskSummary).not.toHaveBeenCalled();
    expect(screen.queryByText(/overdue/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edits not synced' })).toBeNull();
  });

  it('shows nothing when the summary fails: a nudge, never a blocker', async () => {
    api.getTaskSummary.mockRejectedValue(new Error('down'));
    renderBadges();

    await vi.waitFor(() => expect(api.getTaskSummary).toHaveBeenCalled());
    expect(screen.queryByText(/overdue/)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
