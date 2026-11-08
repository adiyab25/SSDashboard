import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isolateLtr } from '@/shared/isolate-ltr';
import { renderWithQuery } from '@/shared/render-with-query';
import { modulesAnswer } from './module-fixtures';
import { StaffNoticeBanner } from './staff-notice-banner';

const api = vi.hoisted(() => ({ getModuleStates: vi.fn() }));
vi.mock('./module-states-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...api,
}));

const me = vi.hoisted(() => ({ hats: ['operations'] as string[] }));
vi.mock('@/auth/use-me', () => ({
  useMeState: () => ({ status: 'ready', me: { id: 'me', hats: me.hats, permissions: [] } }),
}));

const notice = {
  bundle: 'operations' as const,
  stopsOn: '2026-12-01',
  stopsAt: '2026-11-30T22:00:00.000Z',
  capabilities: ['mail.send', 'future.thing'],
};

afterEach(() => {
  api.getModuleStates.mockReset();
  me.hats = ['operations'];
});

/**
 * Waits until the module states query has succeeded (not only been called) and React has drawn
 * the answer, so an absence check looks at the settled screen.
 */
async function settled() {
  await waitFor(() => expect(api.getModuleStates).toHaveBeenCalled());
  await waitFor(() => expect(api.getModuleStates.mock.results[0]?.value).toBeDefined());
  await act(async () => {
    await api.getModuleStates.mock.results[0]?.value;
  });
}

describe('StaffNoticeBanner (spec 0009, AC-17, W8)', () => {
  it('tells an internal hat what stops and on which day, with no price', async () => {
    api.getModuleStates.mockResolvedValue(modulesAnswer({ staffNotices: [notice] }));
    renderWithQuery(<StaffNoticeBanner />);

    const region = await screen.findByRole('region', { name: 'Notice about work that stops' });
    expect(region).toHaveTextContent(
      `From 1 Dec 2026 this stops: Sending email, ${isolateLtr('future.thing')}. Ask your manager.`,
    );
  });

  it('shows nothing to a person who wears only external hats, whatever the answer holds', async () => {
    me.hats = ['partner'];
    api.getModuleStates.mockResolvedValue(modulesAnswer({ staffNotices: [notice] }));
    const { container } = renderWithQuery(<StaffNoticeBanner />);
    await settled();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows nothing when there is no notice', async () => {
    api.getModuleStates.mockResolvedValue(modulesAnswer());
    const { container } = renderWithQuery(<StaffNoticeBanner />);
    await settled();
    expect(container).toBeEmptyDOMElement();
  });
});
