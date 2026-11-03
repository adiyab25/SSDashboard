'use client';

import { LocationListResponse, type LocationSummary } from '@ssdashboard/contracts';
import { createContext, use, useCallback, useEffect, useMemo, useState } from 'react';

/** A location id, or `'all'`. Spelled out so readers see the special value. */
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export type LocationChoice = string | 'all';
export type LocationsStatus = 'loading' | 'ready' | 'empty' | 'error';

const COOKIE = 'ss_location';
const ONE_YEAR = 60 * 60 * 24 * 365;
const MAX_PAGES = 50;

function readCookie(): LocationChoice | null {
  const value = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`).exec(document.cookie)?.[1];
  return value ? decodeURIComponent(value) : null;
}

function writeCookie(value: LocationChoice) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax${secure}`;
}

/** Every page of `GET /api/locations`, up to 50 pages. */
async function fetchAllLocations(signal: AbortSignal): Promise<LocationSummary[]> {
  const items: LocationSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const response = await fetch(`/api/locations${query}`, { signal });
    if (!response.ok) throw new Error(`api answered ${response.status}`);
    const body = LocationListResponse.parse(await response.json());
    items.push(...body.items);
    cursor = body.nextCursor;
    if (!cursor) return items;
  }
  console.warn(`Stopped loading locations after ${MAX_PAGES} pages; showing what loaded.`);
  return items;
}

/** The label for a location: English name, else Arabic, else its code. */
export function locationName(location: LocationSummary): string {
  return location.name.en?.trim() || location.name.ar?.trim() || location.code;
}

interface CurrentLocation {
  current: LocationChoice;
  locations: LocationSummary[];
  status: LocationsStatus;
  retry: () => void;
  setCurrentLocation: (choice: LocationChoice) => void;
}

const CurrentLocationContext = createContext<CurrentLocation | null>(null);

/**
 * The warehouse or showroom the person is working in, kept in a cookie. Read on the
 * client only; `'all'` while loading, on error, or when the stored one is gone.
 */
export function CurrentLocationProvider({ children }: { children: React.ReactNode }) {
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [status, setStatus] = useState<LocationsStatus>('loading');
  const [current, setCurrent] = useState<LocationChoice>('all');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchAllLocations(controller.signal)
      .then((items) => {
        const stored = readCookie();
        const known = stored !== null && items.some((item) => item.id === stored);
        // A location that was archived or removed falls back to all, and the cookie follows.
        if (stored !== null && stored !== 'all' && !known) writeCookie('all');
        setLocations(items);
        setCurrent(known ? stored : 'all');
        setStatus(items.length === 0 ? 'empty' : 'ready');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setCurrent('all');
        setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => {
    setStatus('loading');
    setAttempt((count) => count + 1);
  }, []);

  const setCurrentLocation = useCallback((choice: LocationChoice) => {
    writeCookie(choice);
    setCurrent(choice);
  }, []);

  const value = useMemo(
    () => ({
      current: status === 'ready' ? current : 'all',
      locations,
      status,
      retry,
      setCurrentLocation,
    }),
    [current, locations, status, retry, setCurrentLocation],
  );

  return <CurrentLocationContext value={value}>{children}</CurrentLocationContext>;
}

/** The switcher's full state. */
export function useLocationSwitcher(): CurrentLocation {
  const context = use(CurrentLocationContext);
  if (!context) throw new Error('useLocationSwitcher needs a CurrentLocationProvider');
  return context;
}

/** The selected location id, or `'all'`. Later stock screens default to it. */
export function useCurrentLocation(): LocationChoice {
  return useLocationSwitcher().current;
}
