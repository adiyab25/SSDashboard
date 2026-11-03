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

  it('has exactly one top level heading, the page title', () => {
    render(<Home />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  });

  it('shows the install name in the header, SSDashboard until the config loads', () => {
    render(<Home />);

    expect(screen.getByRole('banner')).toHaveTextContent('SSDashboard');
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
