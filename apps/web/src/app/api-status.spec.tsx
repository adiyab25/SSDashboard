import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiStatus } from './api-status';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The value shown next to a label in the status list (dt → dd). */
async function valueOf(label: string): Promise<string | null> {
  const term = await screen.findByText(label, { selector: 'dt' });
  return term.nextElementSibling?.textContent ?? null;
}

describe('ApiStatus', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('shows checking while the api has not answered yet', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    render(<ApiStatus />);

    expect(await valueOf('API')).toBe('checking…');
  });

  it('calls the api through the relative /api path every install uses', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    render(<ApiStatus />);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) as unknown }),
    );
  });

  it('shows the api status, database state, and version when the api is healthy', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok', version: '0.1.0', database: 'up' }));

    render(<ApiStatus />);

    expect(await valueOf('Database')).toBe('up');
    expect(await valueOf('API')).toBe('ok');
    expect(await valueOf('Version')).toBe('0.1.0');
  });

  it('shows degraded and the database as down when the api cannot reach it', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ status: 'degraded', version: '0.1.0', database: 'down' }),
    );

    render(<ApiStatus />);

    expect(await valueOf('Database')).toBe('down');
    expect(await valueOf('API')).toBe('degraded');
  });

  it('shows the api as unreachable with the status code when it answers with an error', async () => {
    fetchMock.mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

    render(<ApiStatus />);

    expect(await screen.findByText('unreachable (api answered 502)')).toBeInTheDocument();
    expect(screen.queryByText('Database', { selector: 'dt' })).not.toBeInTheDocument();
  });

  it('shows the api as unreachable when the request fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<ApiStatus />);

    expect(await screen.findByText('unreachable (Failed to fetch)')).toBeInTheDocument();
  });

  it('shows the api as unreachable instead of rendering an answer that breaks the contract', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ status: 'starting', version: '0.1.0', database: 'up' }),
    );

    render(<ApiStatus />);

    expect(await screen.findByText(/^unreachable \(/)).toBeInTheDocument();
    expect(screen.queryByText('starting')).not.toBeInTheDocument();
  });

  it('cancels the request when it leaves the page', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<ApiStatus />);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;

    unmount();

    expect(signal?.aborted).toBe(true);
  });

  it('announces status changes to screen readers through a polite live region', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    render(<ApiStatus />);

    const term = await screen.findByText('API', { selector: 'dt' });
    expect(term.closest('dl')).toHaveAttribute('aria-live', 'polite');
  });
});
