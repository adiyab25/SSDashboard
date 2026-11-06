import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { deriveBrandTokens } from '../lib/brand-tokens';
import { expectNoAxeViolations } from '../test/axe';
import { PortalFrame } from './portal-frame';

const accepted = deriveBrandTokens('#0A7C39');
const tokens = accepted.accepted
  ? { fill: accepted.fill, foreground: accepted.foreground }
  : undefined;

function sample(withTokens: boolean, withLogo: boolean) {
  return (
    <PortalFrame
      brand={{
        name: 'Sample Brand',
        logoUrl: withLogo ? '/logo.png' : undefined,
        tokens: withTokens ? tokens : undefined,
      }}
      title="Request an exchange"
      languageSwitch={<a href="/ar">Arabic</a>}
      backLink={<a href="/">Back</a>}
    >
      <button type="button">Continue</button>
    </PortalFrame>
  );
}

describe('PortalFrame', () => {
  it('renders exactly one main and one h1', () => {
    const { container } = render(sample(true, true));

    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Request an exchange');
  });

  it('has no navigation landmark', () => {
    const { container } = render(sample(true, true));

    expect(container.querySelector('nav, aside')).toBeNull();
  });

  it('gives the logo its alt from the brand name', () => {
    render(sample(true, true));

    expect(screen.getByRole('img', { name: 'Sample Brand' }).getAttribute('src')).toBe('/logo.png');
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
    const root = container.querySelector<HTMLElement>('[data-slot="portal-frame"]');

    expect(root?.style.getPropertyValue('--brand')).toBe('#0A7C39');
    expect(root?.style.getPropertyValue('--brand-foreground')).toBe('#FFFFFF');
  });

  it('keeps the default accent without brand tokens', () => {
    const { container } = render(sample(false, true));
    const root = container.querySelector<HTMLElement>('[data-slot="portal-frame"]');

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
