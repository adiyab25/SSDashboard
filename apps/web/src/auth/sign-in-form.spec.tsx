import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignInForm } from './sign-in-form';

const signInEmail = vi.fn();
vi.mock('./auth-client', () => ({ authClient: () => ({ signIn: { email: signInEmail } }) }));

const assign = vi.fn();

function atPage(search: string) {
  vi.stubGlobal('location', { origin: 'https://erp.example.com', search, assign });
}

async function fillAndSubmit(email = 'sam@example.com', password = 'Correct-Horse-1') {
  if (email) await userEvent.type(screen.getByLabelText(/^Email/), email);
  if (password) await userEvent.type(screen.getByLabelText(/^Password/), password);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('SignInForm', () => {
  beforeEach(() => atPage(''));
  afterEach(() => {
    signInEmail.mockReset();
    assign.mockReset();
    vi.unstubAllGlobals();
  });

  it('has exactly one top level heading and visible labels that say they are required (AC-24)', () => {
    render(<SignInForm />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByLabelText('Email(Required)')).toBeRequired();
    expect(screen.getByLabelText('Password(Required)')).toBeRequired();
  });

  it('never puts the email or password in the address if submitted before the page is ready', () => {
    const { container } = render(<SignInForm />);

    expect(container.querySelector('form')).toHaveAttribute('method', 'post');
  });

  it('lets a password manager fill the form and never blocks paste (AC-8)', () => {
    render(<SignInForm />);

    expect(screen.getByLabelText(/^Email/)).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText(/^Password/)).not.toHaveAttribute('onpaste');
  });

  describe('validation', () => {
    it('on an empty submit, names each problem, links it to the field, and focuses the first', async () => {
      render(<SignInForm />);

      await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

      const email = screen.getByLabelText(/^Email/);
      const password = screen.getByLabelText(/^Password/);
      expect(email).toHaveAttribute('aria-invalid', 'true');
      expect(email).toHaveAccessibleDescription('Enter your email address.');
      expect(password).toHaveAccessibleDescription('Enter your password.');
      expect(email).toHaveFocus();
      expect(signInEmail).not.toHaveBeenCalled();
    });

    it('focuses the password when only it is missing', async () => {
      render(<SignInForm />);

      await fillAndSubmit('sam@example.com', '');

      expect(screen.getByLabelText(/^Password/)).toHaveFocus();
    });

    it('catches an address that is plainly mistyped', async () => {
      render(<SignInForm />);

      await fillAndSubmit('sam@example', 'Correct-Horse-1');

      expect(screen.getByLabelText(/^Email/)).toHaveAccessibleDescription(
        'Enter a valid email address, like name@example.com.',
      );
      expect(signInEmail).not.toHaveBeenCalled();
    });

    it('shows an error after the person leaves the field, not while typing', async () => {
      render(<SignInForm />);
      const email = screen.getByLabelText(/^Email/);

      await userEvent.type(email, 'sam@');
      expect(email).not.toHaveAttribute('aria-invalid');

      await userEvent.tab();
      expect(email).toHaveAttribute('aria-invalid', 'true');
    });
  });

  describe('signing in (AC-1)', () => {
    it('sends the trimmed email and the password as typed, then lands on /', async () => {
      signInEmail.mockResolvedValue({ data: {}, error: null });
      render(<SignInForm />);

      await fillAndSubmit('  Sam@Example.com ', 'Correct-Horse-1');

      expect(signInEmail).toHaveBeenCalledWith({
        email: 'Sam@Example.com',
        password: 'Correct-Horse-1',
      });
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
    });

    it('lands on the returnTo path when it is a path on this site', async () => {
      atPage('?returnTo=%2Fdesign%3Ftab%3Dcolor');
      signInEmail.mockResolvedValue({ data: {}, error: null });
      render(<SignInForm />);

      await fillAndSubmit();

      await waitFor(() => expect(assign).toHaveBeenCalledWith('/design?tab=color'));
    });

    it.each(['//evil.example', 'https://evil.example', '%2F%5Cevil.example'])(
      'ignores an unsafe returnTo (%s)',
      async (returnTo) => {
        atPage(`?returnTo=${returnTo}`);
        signInEmail.mockResolvedValue({ data: {}, error: null });
        render(<SignInForm />);

        await fillAndSubmit();

        await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
      },
    );

    it('disables the button while the answer is on its way, so nothing is sent twice', async () => {
      signInEmail.mockReturnValue(new Promise(() => {}));
      render(<SignInForm />);

      await fillAndSubmit();

      const button = screen.getByRole('button', { name: 'Sign in' });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(signInEmail).toHaveBeenCalledOnce();
    });
  });

  describe('when sign in fails (AC-2)', () => {
    it.each([
      [
        'a wrong password or unknown email',
        { status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' },
        'The email or password is not right. Check both and try again.',
      ],
      [
        'a disabled account',
        { status: 403, code: 'BANNED_USER' },
        'This account is disabled. Ask an administrator for help.',
      ],
      ['too many attempts', { status: 429 }, 'Too many attempts. Wait a minute, then try again.'],
      [
        'an api failure',
        { status: 500 },
        'Could not sign in. Check your connection and try again.',
      ],
    ])('announces %s and lets the person try again', async (_case, error, message) => {
      signInEmail.mockResolvedValue({ data: null, error });
      render(<SignInForm />);

      await fillAndSubmit();

      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
      expect(assign).not.toHaveBeenCalled();
    });

    it('keeps what was typed so the person only fixes the part that was wrong', async () => {
      signInEmail.mockResolvedValue({ data: null, error: { status: 401 } });
      render(<SignInForm />);

      await fillAndSubmit('sam@example.com', 'Wrong-Password-1');
      await screen.findByRole('alert');

      expect(screen.getByLabelText(/^Email/)).toHaveValue('sam@example.com');
    });

    it('shows the same message when the request itself throws', async () => {
      signInEmail.mockRejectedValue(new Error('network down'));
      render(<SignInForm />);

      await fillAndSubmit();

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign in.');
    });
  });
});
