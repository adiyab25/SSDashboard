import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { Skeleton } from './skeleton';

describe('Skeleton', () => {
  it('is decorative and has no axe violations', async () => {
    const { container } = render(<Skeleton aria-hidden className="h-4 w-24" />);

    expect(container.firstElementChild).toHaveAttribute('data-slot', 'skeleton');
    await expectNoAxeViolations(container);
  });
});
