import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Popover, PopoverContent, PopoverTrigger } from '../components/popover';
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

  it('forwards the ref and button props, and interactive forces the button', () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(<StatusChipOverflow ref={ref} count={1} label="1 more status" interactive data-x="y" />);

    expect(ref.current).toBe(screen.getByRole('button'));
    expect(ref.current).toHaveAttribute('data-x', 'y');
  });

  describe.each(['ltr', 'rtl'] as const)('as a Popover trigger (%s)', (dir) => {
    it.each([
      ['click', null],
      ['Enter', '{Enter}'],
      ['Space', ' '],
    ])('opens by %s, closes on Escape with focus back on the chip', async (_name, key) => {
      render(
        <div dir={dir}>
          <Popover>
            <PopoverTrigger asChild>
              <StatusChipOverflow count={2} label="2 more statuses" />
            </PopoverTrigger>
            <PopoverContent aria-label="2 more statuses">Owed and failed</PopoverContent>
          </Popover>
        </div>,
      );
      const chip = screen.getByRole('button', { name: /2 more statuses/ });
      expect(chip).toHaveAttribute('aria-expanded', 'false');

      if (key === null) {
        await userEvent.click(chip);
      } else {
        chip.focus();
        await userEvent.keyboard(key);
      }
      expect(await screen.findByText('Owed and failed')).toBeInTheDocument();
      expect(chip).toHaveAttribute('aria-expanded', 'true');
      await expectNoAxeViolations(document.body);

      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByText('Owed and failed')).toBeNull());
      await waitFor(() => expect(chip).toHaveFocus());
      expect(chip).toHaveAttribute('aria-expanded', 'false');
    });
  });
});
