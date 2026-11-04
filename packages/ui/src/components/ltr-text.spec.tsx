import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { LtrText } from './ltr-text';

// Spec 0004 AC-10
describe('LtrText', () => {
  it('isolates a code as left to right inside right to left text', async () => {
    const { container } = render(
      <p dir="rtl" lang="ar">
        رمز الصنف <LtrText>SKU-A/12</LtrText>
      </p>,
    );

    const code = screen.getByText('SKU-A/12');
    expect(code.tagName).toBe('BDI');
    expect(code).toHaveAttribute('dir', 'ltr');
    await expectNoAxeViolations(container);
  });

  it('passes class names and attributes through', () => {
    render(
      <LtrText className="tabular-nums" title="Version">
        0.0.0-dev
      </LtrText>,
    );

    expect(screen.getByText('0.0.0-dev')).toHaveClass('tabular-nums');
  });
});
