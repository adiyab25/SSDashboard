import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { FreshnessStrip } from './freshness-strip';

describe('FreshnessStrip', () => {
  it('shows the caller text on a muted band with a decorative icon', () => {
    const { container } = render(<FreshnessStrip text="Confirmed through 4 Nov" />);

    expect(screen.getByText('Confirmed through 4 Nov')).toBeInTheDocument();
    expect(container.firstElementChild?.className).toContain('bg-muted');
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it.each(['light', 'dark', 'rtl'])('has no axe violations in %s', async (mode) => {
    const { container } = render(
      <div
        className={mode === 'dark' ? 'dark' : undefined}
        dir={mode === 'rtl' ? 'rtl' : undefined}
      >
        <FreshnessStrip text="Confirmed through 4 Nov, today is provisional" />
      </div>,
    );

    await expectNoAxeViolations(container);
  });
});
