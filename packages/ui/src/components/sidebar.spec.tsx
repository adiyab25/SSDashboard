import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from './sidebar';
import { TooltipProvider } from './tooltip';

function Shell() {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar collapsible="icon" mobileLabel="Navigation">
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive>
                  <a href="/" aria-current="page">
                    Home
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
        <SidebarTrigger label="Toggle sidebar" />
      </SidebarProvider>
    </TooltipProvider>
  );
}

const sidebarState = () =>
  document.querySelector('[data-slot="sidebar"][data-state]')?.getAttribute('data-state');

describe('Sidebar', () => {
  afterEach(() => {
    document.cookie = 'sidebar_state=; max-age=0; path=/';
  });

  it('has no axe violations and labels its trigger from props', async () => {
    const { container } = render(<Shell />);

    expect(screen.getByRole('button', { name: 'Toggle sidebar' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('collapses from the trigger and remembers it in a cookie', async () => {
    render(<Shell />);

    await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));

    expect(sidebarState()).toBe('collapsed');
    expect(document.cookie).toContain('sidebar_state=false');
  });

  it('toggles with Ctrl+B', async () => {
    render(<Shell />);

    await userEvent.keyboard('{Control>}b{/Control}');

    expect(sidebarState()).toBe('collapsed');
  });

  it('restores the collapsed state from the cookie after mount', () => {
    document.cookie = 'sidebar_state=false; path=/';

    act(() => {
      render(<Shell />);
    });

    expect(sidebarState()).toBe('collapsed');
  });
});
