import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { Kbd, KbdGroup } from './kbd';

describe('Kbd', () => {
  it('renders keys as kbd elements with no axe violations', async () => {
    const { container } = render(
      <KbdGroup>
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>,
    );

    expect(screen.getByText('Ctrl').tagName).toBe('KBD');
    await expectNoAxeViolations(container);
  });
});
