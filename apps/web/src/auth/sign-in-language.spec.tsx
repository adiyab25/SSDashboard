import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignInForm } from './sign-in-form';

const signInEmail = vi.fn();
vi.mock('./auth-client', () => ({ authClient: () => ({ signIn: { email: signInEmail } }) }));

const assign = vi.fn();
const fetchMock = vi.fn();
const cookie = () => /(?:^|;\s*)ss_lang=([^;]*)/.exec(document.cookie)?.[1];

const ME = {
  id: '0190c0de-0000-7000-8000-000000000001',
  name: 'Sam',
  email: 'sam@example.com',
  role: 'staff',
  phone: null,
  staffCode: null,
  language: null,
  twoFactorEnabled: false,
  mustChangePassword: false,
  home: 'backoffice',
};

async function signIn() {
  await userEvent.type(screen.getByLabelText(/^Email/), 'sam@example.com');
  await userEvent.type(screen.getByLabelText(/^Password/), 'Correct-Horse-1');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('SignInForm applies the saved account language (AC-19)', () => {
  beforeEach(() => {
    document.cookie = 'ss_lang=; Path=/; Max-Age=0';
    vi.stubGlobal('location', {
      origin: 'https://erp.example.com',
      search: '',
      protocol: 'https:',
      assign,
    });
    vi.stubGlobal('fetch', fetchMock);
    signInEmail.mockResolvedValue({ data: {}, error: null });
  });
  afterEach(() => {
    signInEmail.mockReset();
    fetchMock.mockReset();
    assign.mockReset();
    vi.unstubAllGlobals();
  });

  it('sets the language cookie from the account after a full sign in, then opens the page', async () => {
    fetchMock.mockResolvedValue(Response.json({ ...ME, language: 'ar' }));
    render(<SignInForm />);

    await signIn();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(fetchMock).toHaveBeenCalledWith('/api/me', { cache: 'no-store' });
    expect(cookie()).toBe('ar');
  });

  it('beats a language chosen on the sign in screen', async () => {
    document.cookie = 'ss_lang=en; Path=/';
    fetchMock.mockResolvedValue(Response.json({ ...ME, language: 'ar' }));
    render(<SignInForm />);

    await signIn();

    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(cookie()).toBe('ar');
  });

  it('leaves the language alone when the account has none saved', async () => {
    document.cookie = 'ss_lang=en; Path=/';
    fetchMock.mockResolvedValue(Response.json({ ...ME, language: null }));
    render(<SignInForm />);

    await signIn();

    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(cookie()).toBe('en');
  });

  it.each([
    ['the call fails', () => fetchMock.mockRejectedValue(new Error('offline'))],
    [
      'the answer is not ok',
      () => fetchMock.mockResolvedValue(new Response('{}', { status: 500 })),
    ],
    ['the answer is not a profile', () => fetchMock.mockResolvedValue(Response.json({ nope: 1 }))],
  ])('still signs the person in when %s', async (_name, arrange) => {
    arrange();
    render(<SignInForm />);

    await signIn();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    expect(cookie()).toBeUndefined();
  });

  it('goes to the code step, keeping returnTo, when the account also needs a code (AC-20)', async () => {
    vi.stubGlobal('location', {
      origin: 'https://erp.example.com',
      search: '?returnTo=%2Fstaff',
      protocol: 'https:',
      assign,
    });
    signInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    render(<SignInForm />);

    await signIn();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/two-factor?returnTo=%2Fstaff'));
    // Not signed in yet, so the saved language is not read and the sign in has not finished.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cookie()).toBeUndefined();
  });

  it('goes to the code step with no returnTo when there was none', async () => {
    signInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    render(<SignInForm />);

    await signIn();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/two-factor'));
  });

  it('does not ask for the profile when sign in fails', async () => {
    signInEmail.mockResolvedValue({ data: null, error: { status: 401 } });
    render(<SignInForm />);

    await signIn();

    expect(await screen.findByText(/not right/)).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
