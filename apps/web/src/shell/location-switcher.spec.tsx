import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrentLocationProvider, locationName, useCurrentLocation } from './current-location';
import { LocationSwitcher } from './location-switcher';

const fetchMock = vi.fn<typeof fetch>();

/** The list answers `LocationDetail` rows (spec 0006): the master data fields ride along. */
const DETAIL = { archived: false, updatedAt: '2026-11-03T10:00:00.000000Z', codeLocked: false };
const MAIN = {
  ...DETAIL,
  id: '11111111-1111-4111-8111-111111111111',
  code: 'WH-A',
  type: 'warehouse',
};
const SHOWROOM = {
  ...DETAIL,
  id: '22222222-2222-4222-8222-222222222222',
  code: 'SR-1',
  type: 'showroom',
};

function page(items: unknown[], nextCursor: string | null = null) {
  return Response.json({ items, nextCursor });
}

function Current() {
  return <output aria-label="current">{useCurrentLocation()}</output>;
}

function renderSwitcher() {
  return render(
    <CurrentLocationProvider>
      <LocationSwitcher />
      <Current />
    </CurrentLocationProvider>,
  );
}

const trigger = () => screen.getByRole('button', { name: /^Location:/ });
const current = () => screen.getByLabelText('current');

describe('location switcher', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    document.cookie = 'ss_location=; Max-Age=0; Path=/';
  });

  it('is All locations while the list loads', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    renderSwitcher();

    expect(trigger()).toHaveTextContent('All locations');
    expect(current()).toHaveTextContent('all');
  });

  it('lists All locations first, then each location, and remembers the choice', async () => {
    fetchMock.mockResolvedValue(
      page([
        { ...SHOWROOM, name: { ar: 'صالة' } },
        { ...MAIN, name: { en: ' Main ' } },
      ]),
    );
    renderSwitcher();
    await waitFor(() => expect(trigger()).toBeEnabled());

    await userEvent.click(trigger());
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'All locations',
      'صالةSR-1',
      'MainWH-A',
    ]);
    await userEvent.click(screen.getByRole('option', { name: /Main/ }));

    expect(trigger()).toHaveTextContent('Main');
    expect(current()).toHaveTextContent(MAIN.id);
    expect(document.cookie).toContain(`ss_location=${MAIN.id}`);
  });

  it('restores the stored location after the list loads', async () => {
    document.cookie = `ss_location=${MAIN.id}; Path=/`;
    fetchMock.mockResolvedValue(page([{ ...MAIN, name: { en: 'Main' } }]));

    renderSwitcher();

    await waitFor(() => expect(current()).toHaveTextContent(MAIN.id));
    expect(trigger()).toHaveTextContent('Main');
  });

  it('falls back to all and rewrites the cookie when the stored location is gone', async () => {
    document.cookie = `ss_location=${SHOWROOM.id}; Path=/`;
    fetchMock.mockResolvedValue(page([{ ...MAIN, name: { en: 'Main' } }]));

    renderSwitcher();

    await waitFor(() => expect(document.cookie).toContain('ss_location=all'));
    expect(current()).toHaveTextContent('all');
  });

  it('follows nextCursor until every page is loaded', async () => {
    fetchMock
      .mockResolvedValueOnce(page([{ ...MAIN, name: { en: 'Main' } }], 'V0gtQQ'))
      .mockResolvedValueOnce(page([{ ...SHOWROOM, name: { en: 'Showroom' } }]));
    renderSwitcher();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/locations?cursor=V0gtQQ');
    await userEvent.click(trigger());
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('is disabled and says so when there are no locations yet', async () => {
    fetchMock.mockResolvedValue(page([]));

    renderSwitcher();

    await waitFor(() => expect(trigger()).toHaveTextContent('No locations yet'));
    expect(trigger()).toBeDisabled();
    expect(current()).toHaveTextContent('all');
  });

  it('shows the error with a retry that loads the list again', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    fetchMock.mockResolvedValueOnce(page([{ ...MAIN, name: { en: 'Main' } }]));
    renderSwitcher();
    await waitFor(() => expect(trigger()).toHaveTextContent('Locations unavailable'));
    expect(current()).toHaveTextContent('all');

    await userEvent.click(trigger());
    expect(screen.getByRole('alert')).toHaveTextContent('The locations could not be loaded.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    // The popover stays open and fills in once the list loads.
    expect(await screen.findByRole('option', { name: /Main/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// AC-9: the active language first, then the install default, then the code.
describe('locationName', () => {
  const base = { id: MAIN.id, code: 'WH-A', type: 'warehouse' as const };
  const english = { active: 'en', fallback: 'en' };

  it('uses the active language, trimmed, then the other language, then the code', () => {
    expect(locationName({ ...base, name: { en: ' Main ', ar: 'المخزن' } }, english)).toBe('Main');
    expect(locationName({ ...base, name: { en: '  ', ar: ' المخزن ' } }, english)).toBe('المخزن');
    expect(locationName({ ...base, name: {} }, english)).toBe('WH-A');
  });

  it('prefers Arabic when Arabic is active', () => {
    const arabic = { active: 'ar', fallback: 'en' };

    expect(locationName({ ...base, name: { en: 'Main', ar: 'المخزن' } }, arabic)).toBe('المخزن');
    expect(locationName({ ...base, name: { en: 'Main' } }, arabic)).toBe('Main');
  });
});
