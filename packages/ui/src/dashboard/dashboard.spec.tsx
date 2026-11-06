import { render, screen, within } from '@testing-library/react';
import { Home } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../test/axe';
import { ProvisionalValue } from '../status/provisional-value';
import { StatusChip } from '../status/status-chip';
import { BottomTabs } from './bottom-tabs';
import { CollapsingTable } from './collapsing-table';
import { MetricCard } from './metric-card';
import { NeedsYouList } from './needs-you-list';

const MODES = ['light', 'dark', 'rtl'] as const;

/** Wraps a node the way the three axe modes need. */
function inMode(mode: (typeof MODES)[number], node: React.ReactNode) {
  return (
    <div className={mode === 'dark' ? 'dark' : undefined} dir={mode === 'rtl' ? 'rtl' : undefined}>
      {node}
    </div>
  );
}

const tabs = ['Today', 'Orders', 'Cash', 'More', 'Extra'].map((label, index) => ({
  label,
  href: `/${label.toLowerCase()}`,
  icon: <Home />,
  current: index === 0,
}));

const needs = Array.from({ length: 7 }, (_, index) => ({
  id: `o${index}`,
  href: `/orders/o${index}`,
  label: `Order ${index} needs a call`,
  meaning: 'failed' as const,
  chipLabel: 'Failed',
}));

const orders = [
  { code: 'TBL-1', who: 'Mona', total: '1,240 EGP' },
  { code: 'TBL-2', who: 'Sara', total: '980 EGP' },
];

const table = (
  <CollapsingTable
    caption="Orders"
    rows={orders}
    getRowKey={(row) => row.code}
    columns={[
      { id: 'code', header: 'Code', cell: (row) => row.code, title: true },
      { id: 'who', header: 'Who', cell: (row) => row.who },
      {
        id: 'state',
        header: 'State',
        cell: () => <StatusChip meaning="confirmed" label="Confirmed" />,
      },
      { id: 'total', header: 'Total', align: 'end', cell: (row) => row.total },
    ]}
  />
);

describe('MetricCard', () => {
  it('is one link to its drill down with the owed edge', () => {
    render(
      <MetricCard
        label="Cash owed to you"
        value="12,400 EGP"
        href="/cash"
        emphasis="owed"
        split={[
          { label: 'Bosta', value: '9,000 EGP' },
          { label: 'Partners', value: '3,400 EGP' },
        ]}
      />,
    );

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/cash');
    expect(links[0]?.className).toContain('border-s-owed');
    expect(links[0]?.className).toContain('min-h-touch');
    expect(links[0]?.className).not.toContain('border-dashed');
  });

  it('draws the provisional card dashed with the ≈ from ProvisionalValue', () => {
    render(
      <MetricCard
        label="Today so far"
        href="/today"
        provisional
        value={<ProvisionalValue value="18 orders" provisionalLabel="Provisional" />}
      />,
    );

    const card = screen.getByRole('link');
    expect(card.className).toContain('border-dashed');
    expect(card).toHaveTextContent('≈18 orders');
  });

  it.each(MODES)('has no axe violations in %s', async (mode) => {
    const { container } = render(
      inMode(
        mode,
        <MetricCard
          label="Cash owed"
          value="12,400 EGP"
          href="/cash"
          detail="Since 1 Nov"
          split={[{ label: 'Bosta', value: '9,000 EGP' }]}
        />,
      ),
    );
    await expectNoAxeViolations(container);
  });
});

describe('BottomTabs', () => {
  it('refuses a fifth tab and marks the current one', () => {
    render(<BottomTabs label="Main" tabs={tabs} />);

    const nav = screen.getByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(4);
    expect(within(nav).queryByText('Extra')).toBeNull();
    expect(links[0]).toHaveAttribute('aria-current', 'page');
    expect(links[1]).not.toHaveAttribute('aria-current');
    expect(links[0]?.className).toContain('h-14');
    expect(links[0]?.className).toContain('bg-primary');
  });

  it.each(MODES)('has no axe violations in %s', async (mode) => {
    const { container } = render(inMode(mode, <BottomTabs label="Main" tabs={tabs} />));
    await expectNoAxeViolations(container);
  });
});

describe('NeedsYouList', () => {
  it('caps at five rows and links to the rest', () => {
    render(
      <NeedsYouList
        label="Needs you"
        items={needs}
        moreHref="/queue"
        moreLabel={(count) => `${count} more`}
      />,
    );

    const links = within(screen.getByRole('list', { name: 'Needs you' })).getAllByRole('link');
    expect(links).toHaveLength(6);
    expect(links[5]).toHaveTextContent('2 more');
    expect(links[5]).toHaveAttribute('href', '/queue');
    expect(links[0]?.className).toContain('min-h-12');
    expect(screen.queryByText('Order 5 needs a call')).toBeNull();
  });

  it('shows no more link when everything fits', () => {
    render(
      <NeedsYouList
        label="Needs you"
        items={needs.slice(0, 3)}
        moreHref="/queue"
        moreLabel={(count) => `${count} more`}
      />,
    );
    expect(screen.getAllByRole('link')).toHaveLength(3);
  });

  it('uses the api total to count hidden rows', () => {
    render(
      <NeedsYouList
        label="Needs you"
        items={needs.slice(0, 5)}
        total={12}
        moreHref="/queue"
        moreLabel={(count) => `${count} more`}
      />,
    );
    expect(screen.getByText('7 more')).toBeInTheDocument();
  });

  it.each(MODES)('has no axe violations in %s', async (mode) => {
    const { container } = render(
      inMode(
        mode,
        <NeedsYouList
          label="Needs you"
          items={needs}
          moreHref="/queue"
          moreLabel={(count) => `${count} more`}
        />,
      ),
    );
    await expectNoAxeViolations(container);
  });
});

describe('CollapsingTable', () => {
  it('renders a table from sm up and a card list below, from the same columns', () => {
    const { container } = render(table);

    const wrapper = container.querySelector('table')?.closest('.hidden');
    expect(wrapper?.className).toContain('sm:block');
    const cards = screen.getByRole('list', { name: 'Orders', hidden: true });
    expect(cards.className).toContain('sm:hidden');
    expect(within(cards).getAllByRole('listitem', { hidden: true })).toHaveLength(2);
    expect(within(cards).getAllByText('Confirmed')).toHaveLength(2);
  });

  it.each(MODES)('has no axe violations in %s', async (mode) => {
    const { container } = render(inMode(mode, table));
    await expectNoAxeViolations(container);
  });
});
