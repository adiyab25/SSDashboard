import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { Avatar, AvatarFallback } from './avatar';

describe('Avatar', () => {
  it('shows its fallback and has no axe violations', async () => {
    const { container } = render(
      <Avatar>
        <AvatarFallback>S</AvatarFallback>
      </Avatar>,
    );

    expect(screen.getByText('S')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
