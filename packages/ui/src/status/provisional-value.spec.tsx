import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { ProvisionalValue } from './provisional-value';

describe('ProvisionalValue', () => {
  it('puts ≈ first inside a bdi, with a dashed boundary and a hidden label', () => {
    const { container } = render(
      <ProvisionalValue value="1,240 EGP" provisionalLabel="Provisional" />,
    );

    const bdi = container.querySelector('bdi');
    expect(bdi?.textContent).toBe('≈1,240 EGP');
    const root = container.querySelector('[data-slot="provisional-value"]');
    expect(root?.className).toContain('border-dashed');
    expect(root?.className).not.toMatch(/border-(solid|double)/);
    expect(root?.className).toContain('tabular-nums');
    expect(container.querySelector('.sr-only')?.textContent).toBe('Provisional');
  });

  it.each(['light', 'dark', 'rtl'])('has no axe violations in %s', async (mode) => {
    const { container } = render(
      <div
        className={mode === 'dark' ? 'dark' : undefined}
        dir={mode === 'rtl' ? 'rtl' : undefined}
      >
        <ProvisionalValue value="1,240 EGP" provisionalLabel="Provisional" />
      </div>,
    );

    await expectNoAxeViolations(container);
  });
});
