import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { Input } from './input';

describe('Input', () => {
  it('takes its height from the density token so the floor scope reaches it', () => {
    render(<Input aria-label="Name" />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveClass('h-control');
  });

  it('takes the field fill role, which is the card colour on a card in light only', () => {
    render(<Input aria-label="Name" />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveClass('bg-field');
    expect(screen.getByRole('textbox', { name: 'Name' })).not.toHaveClass('bg-background');
  });

  it('has no axe violations', async () => {
    const { container } = render(<Input aria-label="Name" />);

    await expectNoAxeViolations(container);
  });
});
