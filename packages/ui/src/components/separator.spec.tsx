import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { Separator } from './separator';

describe('Separator', () => {
  it('is decorative by default', async () => {
    const { container } = render(<Separator />);

    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('is announced when it carries meaning', () => {
    render(<Separator decorative={false} />);

    expect(screen.getByRole('separator')).toBeInTheDocument();
  });
});
