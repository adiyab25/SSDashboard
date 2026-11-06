import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { deriveBrandTokens } from '../lib/brand-tokens';
import { expectNoAxeViolations } from '../test/axe';
import { PartnerFrame } from './partner-frame';

const accepted = deriveBrandTokens('#0A7C39');
const tokens = accepted.accepted
  ? { fill: accepted.fill, foreground: accepted.foreground }
  : undefined;

const NAV = [
  { label: 'Statements', href: '/statements', current: true },
  { label: 'Stock at your location', href: '/stock' },
  { label: 'Settlement', href: '/settlement' },
];

function sample(withTokens: boolean, withLogo: boolean) {
  return (
    <PartnerFrame
      brand={{
        name: 'Sample Brand',
        logoUrl: withLogo ? '/logo.png' : undefined,
        tokens: withTokens ? tokens : undefined,
      }}
      partnerName="Showroom Zamalek"
      title="Statements"
      navItems={NAV}
      navLabel="Partner pages"
      actions={<a href="/ar">Arabic</a>}
    >
      <p>Content</p>
    </PartnerFrame>
  );
}

describe('PartnerFrame', () => {
  it('renders exactly one main and one h1', () => {
    const { container } = render(sample(true, true));

    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('shows the partner name and a labelled navigation with the current page marked', () => {
    render(sample(true, true));

    expect(screen.getByText('Showroom Zamalek')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Partner pages' });
    expect(nav.querySelectorAll('a')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'Statements' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: 'Settlement' }).hasAttribute('aria-current')).toBe(
      false,
    );
  });

  it('gives the logo its alt from the brand name', () => {
    render(sample(true, true));

    expect(screen.getByRole('img', { name: 'Sample Brand' })).toBeTruthy();
  });

  it('shows the brand initial when there is no logo', () => {
    const { container } = render(sample(true, false));

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-slot="brand-mark"] [aria-hidden]')?.textContent).toBe(
      'S',
    );
  });

  it('sets the brand tokens inline on the root', () => {
    const { container } = render(sample(true, true));
    const root = container.querySelector<HTMLElement>('[data-slot="partner-frame"]');

    expect(root?.style.getPropertyValue('--brand')).toBe('#0A7C39');
    expect(root?.style.getPropertyValue('--brand-foreground')).toBe('#FFFFFF');
  });

  it('keeps the default accent without brand tokens', () => {
    const { container } = render(sample(false, true));
    const root = container.querySelector<HTMLElement>('[data-slot="partner-frame"]');

    expect(root?.getAttribute('style')).toBeNull();
  });

  it('has no axe violations in light, dark, and right to left', async () => {
    const light = render(sample(true, true));
    await expectNoAxeViolations(light.container);
    light.unmount();

    const dark = render(<div className="dark">{sample(true, false)}</div>);
    await expectNoAxeViolations(dark.container);
    dark.unmount();

    const rtl = render(<div dir="rtl">{sample(true, true)}</div>);
    await expectNoAxeViolations(rtl.container);
  });
});
