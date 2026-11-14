import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { Alert, AlertDescription, AlertTitle } from './alert';

describe('Alert', () => {
  it('has no axe violations in the warning variant', async () => {
    const { container } = render(
      <Alert variant="warning">
        <AlertTitle>Heads up</AlertTitle>
        <AlertDescription>Something needs attention</AlertDescription>
      </Alert>,
    );

    await expectNoAxeViolations(container);
  });

  it('warning is amber on the card surface and never cyan', () => {
    render(<Alert variant="warning">Heads up</Alert>);
    const classes = screen.getByRole('alert').className.split(/\s+/);

    expect(classes).toEqual(
      expect.arrayContaining([
        'bg-card',
        'border-warning',
        'text-warning',
        '*:data-[slot=alert-description]:text-warning',
        '*:[svg]:text-current',
      ]),
    );
    const joined = classes.join(' ');
    expect(joined).not.toMatch(/primary|ring|gradient|blend|!/);
    expect(joined).not.toContain('destructive');
  });
});
