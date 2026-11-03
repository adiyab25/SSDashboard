import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { AppShell } from './app-shell';

const push = vi.fn();
let pathname = '/';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push }),
}));

function renderShell() {
  return render(
    <Providers>
      <AppShell>
        <h1>Page</h1>
      </AppShell>
    </Providers>,
  );
}

describe('AppShell', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockReset();
    pathname = '/';
  });

  it('renders the page in the single main landmark, with a header and navigation', () => {
    renderShell();

    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(within(screen.getByRole('main')).getByRole('heading', { name: 'Page' })).toBeVisible();
    expect(screen.getByRole('banner')).toHaveTextContent('SSDashboard');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  it('lists the navigation registry grouped by module and marks the current page', () => {
    renderShell();

    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByText('General')).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    // Development only pages show outside production builds.
    expect(within(nav).getByRole('link', { name: 'Design system' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('marks a page below a registry entry as inside that entry', () => {
    pathname = '/design/colors';

    renderShell();

    expect(screen.getByRole('link', { name: 'Design system' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('opens the palette with Ctrl+K, filters, and goes to the highlighted page on Enter', async () => {
    renderShell();

    await userEvent.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Go to a page' });
    await userEvent.type(within(dialog).getByRole('combobox'), 'des');
    await userEvent.keyboard('{Enter}');

    expect(push).toHaveBeenCalledWith('/design');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the palette on Escape and returns focus to the palette button', async () => {
    renderShell();
    const button = screen.getByRole('button', { name: /Search pages/ });

    await userEvent.click(button);
    await screen.findByRole('dialog', { name: 'Go to a page' });
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('toggles the palette closed with the same shortcut', async () => {
    renderShell();

    await userEvent.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Control>}k{/Control}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers theme, language, and sign out', async () => {
    renderShell();

    await userEvent.click(screen.getByRole('button', { name: /User menu/ }));

    expect(screen.getByRole('menuitem', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Language' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).not.toHaveAttribute('aria-disabled');
  });
});
