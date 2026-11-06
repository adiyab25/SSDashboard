import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { Button } from './button';

describe('Button', () => {
  it('has no axe violations', async () => {
    const { container } = render(<Button>Save</Button>);

    await expectNoAxeViolations(container);
  });

  it('runs its action from the keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    screen.getByRole('button', { name: 'Save' }).focus();
    await userEvent.keyboard('{Enter}');

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders its child as the element when asChild is set', () => {
    render(
      <Button asChild>
        <a href="/x">Go</a>
      </Button>,
    );

    expect(screen.getByRole('link', { name: 'Go' })).toHaveAttribute('data-slot', 'button');
  });

  it('takes its default height from the density token so the floor scope reaches it', () => {
    render(<Button>Save</Button>);

    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('h-control');
  });
});
