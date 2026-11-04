import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn<typeof fetch>();

async function renderClientName() {
  // A fresh module per test: the config is cached once per browser session.
  vi.resetModules();
  const { ClientName } = await import('./client-name');
  return render(<ClientName />);
}

describe('ClientName', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('shows the install name from /api/config', async () => {
    fetchMock.mockResolvedValue(Response.json({ clientName: 'Acme Home', version: '1.0.0' }));

    await renderClientName();

    expect(await screen.findByText('Acme Home')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/config', { cache: 'no-store' });
  });

  it('shows SSDashboard while the config is loading', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    await renderClientName();

    expect(screen.getByText('SSDashboard')).toBeInTheDocument();
  });

  it.each([
    ['the api answers with an error', () => Promise.resolve(new Response('', { status: 500 }))],
    ['the request fails', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the answer breaks the contract', () => Promise.resolve(Response.json({ name: 'x' }))],
  ])('keeps SSDashboard when %s', async (_case, answer) => {
    fetchMock.mockImplementation(answer);

    await renderClientName();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(await screen.findByText('SSDashboard')).toBeInTheDocument();
  });

  it('fetches the config only once when it remounts', async () => {
    fetchMock.mockResolvedValue(Response.json({ clientName: 'Acme Home', version: '1.0.0' }));
    const { unmount } = await renderClientName();
    await screen.findByText('Acme Home');
    unmount();

    const { ClientName } = await import('./client-name');
    render(<ClientName />);

    expect(await screen.findByText('Acme Home')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
