import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { STATUS_MEANINGS } from '../lib/status-meaning';
import { expectNoAxeViolations } from '../test/axe';
import { StatusChip } from './status-chip';

describe('StatusChip', () => {
  it.each(STATUS_MEANINGS)('shows an icon and a word for %s', (meaning) => {
    const { container } = render(<StatusChip meaning={meaning} label="Word" />);

    const chip = container.querySelector('[data-slot="status-chip"]');
    expect(chip?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(chip?.textContent?.trim()).toBe('Word');
  });

  it.each(['', '   '])('renders nothing for the blank label %j', (label) => {
    const { container } = render(<StatusChip meaning="owed" label={label} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('uses a dashed boundary only for provisional', () => {
    render(
      <>
        <StatusChip meaning="provisional" label="Provisional" />
        <StatusChip meaning="confirmed" label="Confirmed" />
      </>,
    );

    expect(screen.getByText('Provisional').className).toContain('border-dashed');
    expect(screen.getByText('Confirmed').className).not.toContain('border-dashed');
  });

  it.each(STATUS_MEANINGS)('never uses the accent or a blend for %s (AC-4)', (meaning) => {
    const { container } = render(<StatusChip meaning={meaning} label="Word" />);

    const classes = (container.firstElementChild?.className ?? '').split(/\s+/);
    expect(classes.length).toBeGreaterThan(0);
    for (const name of classes) {
      expect(name).not.toMatch(/primary|ring|blend|gradient/);
    }
  });

  it.each(['light', 'dark'])('has no axe violations in %s', async (mode) => {
    const { container } = render(
      <div className={mode === 'dark' ? 'dark' : undefined}>
        {STATUS_MEANINGS.map((meaning) => (
          <StatusChip key={meaning} meaning={meaning} label={meaning} />
        ))}
      </div>,
    );

    await expectNoAxeViolations(container);
  });

  it('has no axe violations in right to left', async () => {
    const { container } = render(
      <div dir="rtl" lang="ar">
        <StatusChip meaning="owed" label="مستحق" />
      </div>,
    );

    await expectNoAxeViolations(container);
  });
});
