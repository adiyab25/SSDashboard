import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from './page';

describe('Home page', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the product name as the only top level heading', () => {
    render(<Home />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'SSDashboard' })).toBeInTheDocument();
  });

  it('puts the content in the main landmark', () => {
    render(<Home />);

    expect(screen.getByRole('main')).toContainElement(screen.getByRole('heading', { level: 1 }));
  });

  it('includes the api status', () => {
    render(<Home />);

    expect(screen.getByText('API', { selector: 'dt' })).toBeInTheDocument();
  });
});
