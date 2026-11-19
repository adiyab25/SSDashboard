import type { SettingEntryView } from '@ssdashboard/contracts';
import { en } from '@ssdashboard/i18n';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from '@/shared/render-with-query';
import { stateView } from '@/shell/module-fixtures';
import { StepOnDialog } from './step-on-dialog';

/**
 * A fixture executing step carrying a registry warning. No real step exists with one yet, so the
 * label and description are catalog keys we own, and the warning is the cutoff hour's.
 */
const entry: SettingEntryView = {
  key: 'step.fixture_send',
  group: 'automations',
  bundle: 'operations',
  label: 'modules.capabilities.mailSend',
  description: 'modules.mail.description',
  warning: 'settings.warnings.operatingDayCutoffHour',
  confirm: null,
  reason: 'required',
  value: false,
  default: false,
  isDefault: true,
  invalid: false,
  updatedAt: null,
  updatedBy: null,
  canChange: true,
  licensed: true,
  step: {
    capability: 'fixturesteps.send',
    notifiesCustomer: true,
    turnOn: { ready: true, facts: [] },
  },
};

/** The Alert around some text: the nearest `data-slot="alert"` ancestor. */
const alertOf = (text: string) => {
  const alert = screen.getByText(text).closest('[data-slot="alert"]');
  if (!(alert instanceof HTMLElement)) throw new Error(`no alert around "${text}"`);
  return alert;
};

describe('StepOnDialog notices (spec 0025 M6, owner ruling 2026-11-19)', () => {
  it('shows the entry warning as an amber needs-attention Alert with the triangle icon', () => {
    renderWithQuery(<StepOnDialog entry={entry} onClose={vi.fn()} />);

    const alert = alertOf(en.settings.warnings.operatingDayCutoffHour);
    expect(alert.className).toContain('border-warning');
    expect(alert.className).toContain('text-warning');
    expect(alert.className).not.toContain('text-muted-foreground');
    const icon = alert.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon?.getAttribute('class')).toContain('lucide-triangle-alert');
  });

  it('shows the waits-for notice as a muted info Alert with the "i" icon', () => {
    renderWithQuery(
      <StepOnDialog
        entry={{ ...entry, warning: null }}
        capability={stateView({ key: 'fixturesteps.send', state: 'read_only' })}
        onClose={vi.fn()}
      />,
    );

    const alert = alertOf(en.settings.automations.turnOn.notRunnable);
    expect(alert.className).toContain('text-muted-foreground');
    expect(alert.className).not.toContain('border-warning');
    expect(alert.className).not.toContain('text-warning');
    const icon = alert.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon?.getAttribute('class')).toContain('lucide-info');
  });

  it('shows both together: the warning amber and the waits-for notice muted', () => {
    renderWithQuery(
      <StepOnDialog
        entry={entry}
        capability={stateView({ key: 'fixturesteps.send', state: 'off' })}
        onClose={vi.fn()}
      />,
    );

    expect(alertOf(en.settings.warnings.operatingDayCutoffHour).className).toContain(
      'border-warning',
    );
    expect(alertOf(en.settings.automations.turnOn.notRunnable).className).toContain(
      'text-muted-foreground',
    );
  });
});
