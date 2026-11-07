import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useHelpShortcut } from '../hooks/use-help-shortcut';
import { expectNoAxeViolations } from '../test/axe';
import { FirstRunChecklist } from './first-run-checklist';
import { HelpHint } from './help-hint';
import { HelpPanel } from './help-panel';

const MODES = ['light', 'dark', 'rtl'] as const;

/** Wraps a node the way the three axe modes need. */
function inMode(mode: (typeof MODES)[number], node: React.ReactNode) {
  return (
    <div className={mode === 'dark' ? 'dark' : undefined} dir={mode === 'rtl' ? 'rtl' : undefined}>
      {node}
    </div>
  );
}

/** A screen with a field, the shortcut, and the panel, as an app would wire them. */
function Screen({ withTrigger = false }: { withTrigger?: boolean }) {
  const [open, setOpen] = useState(false);
  useHelpShortcut(() => setOpen(true), !open);
  return (
    <div>
      <label>
        Search
        <input />
      </label>
      <button type="button">Elsewhere</button>
      <HelpPanel
        open={open}
        onOpenChange={setOpen}
        title="How this screen works"
        description="A short guide"
        closeLabel="Close"
        trigger={withTrigger ? <button type="button">Help</button> : undefined}
        steps={{ heading: 'Steps', items: ['Call the customer', 'Pick an outcome'] }}
        glossary={{
          heading: 'Outcomes',
          items: [
            { meaning: 'confirmed', chipLabel: 'Confirmed', description: 'Customer said yes.' },
          ],
        }}
        settings={{ heading: 'Settings', items: [{ label: 'Callback delay', value: '2 hours' }] }}
      />
    </div>
  );
}

describe('HelpHint', () => {
  it('opens by Enter and Space and closes by Esc with focus back', async () => {
    const user = userEvent.setup();
    render(<HelpHint label="Help: callback delay">The delay before we call back.</HelpHint>);
    const button = screen.getByRole('button', { name: 'Help: callback delay' });
    expect(button.className).toContain('size-6');
    expect(button.className).toContain('coarse:size-11');

    button.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('The delay before we call back.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('The delay before we call back.')).toBeNull();
    expect(button).toHaveFocus();

    await user.keyboard(' ');
    expect(screen.getByText('The delay before we call back.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(button).toHaveFocus();
  });

  it.each(MODES)('has no axe violations when open in %s', async (mode) => {
    const user = userEvent.setup();
    render(inMode(mode, <HelpHint label="Help: callback delay">One sentence.</HelpHint>));
    await user.click(screen.getByRole('button', { name: 'Help: callback delay' }));
    await expectNoAxeViolations(document.body);
  });
});

describe('HelpPanel with useHelpShortcut', () => {
  it('opens on ? outside a text field and Esc returns focus', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();

    await user.keyboard('?');
    expect(screen.getByRole('dialog', { name: 'How this screen works' })).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('2 hours')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(elsewhere).toHaveFocus());
  });

  it('does not open while typing ? in an input', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    const input = screen.getByRole('textbox');
    await user.click(input);
    await user.keyboard('why?');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(input).toHaveValue('why?');
  });

  it('ignores ? with Ctrl or Meta held', async () => {
    const user = userEvent.setup();
    render(<Screen />);
    await user.keyboard('{Control>}?{/Control}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens from the visible trigger and returns focus to it', async () => {
    const user = userEvent.setup();
    render(<Screen withTrigger />);
    const trigger = screen.getByRole('button', { name: 'Help' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('draws no section for an empty slot, and the training clip when given', () => {
    const { rerender } = render(
      <HelpPanel open onOpenChange={() => {}} title="Guide" closeLabel="Close" />,
    );
    expect(screen.queryByRole('heading', { name: 'Training' })).toBeNull();
    rerender(
      <HelpPanel
        open
        onOpenChange={() => {}}
        title="Guide"
        closeLabel="Close"
        trainingClip={{ heading: 'Training', content: <p>Clip here</p> }}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Training' })).toBeInTheDocument();
  });

  it.each(MODES)('has no axe violations when open in %s', async (mode) => {
    render(
      inMode(
        mode,
        <HelpPanel
          open
          onOpenChange={() => {}}
          title="How this screen works"
          description="A short guide"
          closeLabel="Close"
          steps={{ heading: 'Steps', items: ['Call the customer'] }}
          glossary={{
            heading: 'Outcomes',
            items: [{ meaning: 'failed', chipLabel: 'Failed', description: 'It did not work.' }],
          }}
          settings={{ heading: 'Settings', items: [{ label: 'Retries', value: '3' }] }}
        />,
      ),
    );
    await expectNoAxeViolations(document.body);
  });
});

describe('HelpPanel scroll region', () => {
  it('is keyboard reachable and axe clean with no focusable content in the body', async () => {
    const user = userEvent.setup();
    render(
      <HelpPanel
        open
        onOpenChange={() => {}}
        title="How this screen works"
        closeLabel="Close"
        steps={{ heading: 'Steps', items: ['Call the customer'] }}
      />,
    );
    const region = screen.getByRole('region', { name: 'How this screen works' });
    expect(region).toHaveAttribute('tabindex', '0');
    await user.tab();
    await user.tab();
    await expectNoAxeViolations(document.body);
  });
});

describe('FirstRunChecklist', () => {
  const items = [
    { label: 'Confirm your first order', done: true },
    { label: 'Scan a receipt', done: true },
    { label: 'Invite a teammate', done: false, href: '/team' },
    { label: 'Set a callback delay', done: false },
  ];
  const props = {
    title: 'Your first steps',
    items,
    progressLabel: '2 of 4',
    doneLabel: 'Done',
    todoLabel: 'To do',
    dismissLabel: 'Hide the checklist',
  };

  it('shows progress and dismisses', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<FirstRunChecklist {...props} onDismiss={onDismiss} />);

    expect(screen.getByText('2 of 4')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '2');
    expect(bar).toHaveAttribute('aria-valuemax', '4');
    expect(screen.getByRole('link', { name: /Invite a teammate/ })).toHaveAttribute(
      'href',
      '/team',
    );

    await user.click(screen.getByRole('button', { name: 'Hide the checklist' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it.each(MODES)('has no axe violations in %s', async (mode) => {
    const { container } = render(
      inMode(mode, <FirstRunChecklist {...props} onDismiss={() => {}} />),
    );
    await expectNoAxeViolations(container);
  });
});
