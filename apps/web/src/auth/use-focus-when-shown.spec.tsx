import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useFocusWhenShown } from './use-focus-when-shown';

function Screen({ active = true }: { active?: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useFocusWhenShown(ref, active);
  return (
    <h1 ref={ref} tabIndex={-1}>
      Title
    </h1>
  );
}

describe('useFocusWhenShown', () => {
  afterEach(() => document.documentElement.removeAttribute('data-i18n'));

  it('focuses right away when the page is showing', () => {
    render(<Screen />);

    expect(screen.getByRole('heading')).toHaveFocus();
  });

  it('does nothing while not active', () => {
    render(<Screen active={false} />);

    expect(screen.getByRole('heading')).not.toHaveFocus();
  });

  it('waits for a pending language to be applied, then focuses', async () => {
    document.documentElement.setAttribute('data-i18n', 'pending');
    render(<Screen />);
    expect(screen.getByRole('heading')).not.toHaveFocus();

    await act(async () => {
      document.documentElement.removeAttribute('data-i18n');
      await Promise.resolve();
    });

    expect(screen.getByRole('heading')).toHaveFocus();
  });
});
