import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { StatusChipOverflow } from './status-chip-overflow';

describe('StatusChipOverflow', () => {
  it('is plain text without onClick, named by the label', () => {
    render(<StatusChipOverflow count={2} label="2 more statuses" />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('2 more statuses')).toHaveClass('sr-only');
  });

  it('is a keyboard button when onClick is passed', async () => {
    const onClick = vi.fn();
    render(<StatusChipOverflow count={2} label="2 more statuses" onClick={onClick} />);

    screen.getByRole('button', { name: /2 more statuses/ }).focus();
    await userEvent.keyboard('{Enter}');

    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each(['light', 'dark', 'rtl'])('has no axe violations in %s', async (mode) => {
    const { container } = render(
      <div
        className={mode === 'dark' ? 'dark' : undefined}
        dir={mode === 'rtl' ? 'rtl' : undefined}
      >
        <StatusChipOverflow count={3} label="3 more statuses" />
        <StatusChipOverflow count={1} label="1 more status" onClick={() => undefined} />
      </div>,
    );

    await expectNoAxeViolations(container);
  });

  it('keeps the plus before the digits inside an ltr isolate under rtl', () => {
    const { container } = render(
      <div dir="rtl" lang="ar">
        <StatusChipOverflow count={2} label="حالتان أخريان" />
      </div>,
    );

    const isolate = container.querySelector('bdi');
    expect(isolate).toHaveAttribute('dir', 'ltr');
    expect(isolate?.textContent).toBe('+2');
    expect(isolate?.firstChild?.textContent).toBe('+');
  });
});
