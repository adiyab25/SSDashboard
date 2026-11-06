import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetApiFetchForTests } from '@/auth/api-fetch';
import { resetMeForTests } from '@/auth/use-me';
import { UserMenu } from './user-menu';

const signOut = vi.fn();
vi.mock('@/auth/auth-client', () => ({ authClient: () => ({ signOut }) }));

const assign = vi.fn();
const ME = {
  id: '0190c0de-0000-7000-8000-000000000001',
  name: 'Sam Carter',
  email: 'sam@example.com',
  hats: ['manager'],
  permissions: ['people.manage'],
  partnerAccountId: null,
  phone: null,
  staffCode: null,
  language: null,
  twoFactorEnabled: false,
  mustChangePassword: false,
  home: 'backoffice',
};

describe('UserMenu identity and sign out (AC-25)', () => {
  beforeEach(() => {
    resetMeForTests();
    resetApiFetchForTests();
    vi.stubGlobal('location', { pathname: '/', search: '', assign });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url === '/api/me'
            ? new Response(JSON.stringify(ME), { status: 200 })
            : new Response('{}', { status: 404 }),
        ),
      ),
    );
  });

  afterEach(() => {
    signOut.mockReset();
    assign.mockReset();
    vi.unstubAllGlobals();
  });

  it("shows the person's name, email, and role from GET /api/me", async () => {
    render(<UserMenu />);

    const trigger = await screen.findByRole('button', { name: /Sam Carter/ });
    expect(trigger).toHaveTextContent('S');

    await userEvent.click(trigger);

    expect(screen.getByText('sam@example.com')).toBeInTheDocument();
    expect(screen.getByText('Administrator')).toBeInTheDocument();
  });

  it('keeps the email in a left to right run, so it reads right inside Arabic text', async () => {
    render(<UserMenu />);

    await userEvent.click(await screen.findByRole('button', { name: /Sam Carter/ }));

    expect(screen.getByText('sam@example.com')).toHaveAttribute('dir', 'ltr');
  });

  it('ends only this session and goes to the sign in page', async () => {
    signOut.mockResolvedValue({ data: { success: true }, error: null });
    render(<UserMenu />);
    await userEvent.click(await screen.findByRole('button', { name: /Sam Carter/ }));

    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(signOut).toHaveBeenCalledOnce();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/sign-in'));
  });

  it('stays put and says so when the api could not sign the person out', async () => {
    signOut.mockResolvedValue({ data: null, error: { status: 500 } });
    render(<UserMenu />);
    await userEvent.click(await screen.findByRole('button', { name: /Sam Carter/ }));

    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign out. Try again.');
    expect(assign).not.toHaveBeenCalled();
  });

  it('stays put when the request itself throws', async () => {
    signOut.mockRejectedValue(new Error('network down'));
    render(<UserMenu />);
    await userEvent.click(await screen.findByRole('button', { name: /Sam Carter/ }));

    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign out.');
    expect(assign).not.toHaveBeenCalled();
  });
});
